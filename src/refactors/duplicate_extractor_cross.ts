// deno-lint-ignore-file no-explicit-any
/**
 * Cross-file support for the duplicate extractor (0.3.3, in progress).
 *
 * This module sees every file in the diff at once and detects duplicate
 * blocks that live in DIFFERENT files. Such groups are extracted into a
 * shared module placed under the deepest common ancestor of the involved
 * files — see PLANS/DRIPBIRD_033_CROSS_FILE_DUPLICATE_EXTRACTOR.md for the
 * placement and cycle-safety design.
 *
 * Current stage: detection + placement gating. Groups are found, their
 * placement is resolved, and their imports are proven movable — all before
 * any LLM call. The extraction itself (LLM-generated helper + call sites,
 * rewriting, review) lands in the next piece.
 */
import type { ChangedRange } from "../diff.ts";
import type { Config } from "../config.ts";
import type {
    CrossFileContext,
    CrossFileRefactor,
    CrossFileResult,
    FileChangeset,
} from "../engine.ts";
import {
    collectSequences,
    selectNonOverlapping,
    type SeqInfo,
    usesThis,
} from "./duplicate_extractor.ts";
import { collectFileLevelBindings } from "./function_splitter.ts";
import {
    checkImportMovable,
    collectUsedImportBindings,
    commonAncestorDir,
    pickSharedDir,
} from "./duplicate_extractor_placement.ts";
import { collectImportEdges } from "./function_matcher_imports.ts";
import { parse } from "recast";
import * as babelParser from "@babel/parser";

/**
 * Candidate shared-directory names under the common ancestor, tried in
 * order (`common` first, then boring backups). The configurable version of
 * this list arrives with the config piece.
 */
const SHARED_DIR_CANDIDATES = ["common", "shared", "lib", "util"];

/** A duplicate block tagged with the file it was found in. */
export interface CrossFileBlock extends SeqInfo {
    file: string;
}

export interface CrossFileGroup {
    fingerprint: string;
    blocks: CrossFileBlock[];
}

function parseSource(source: string): any {
    return parse(source, {
        parser: {
            parse(code: string) {
                return babelParser.parse(code, {
                    sourceType: "module",
                    plugins: ["typescript", "jsx"],
                });
            },
        },
    });
}

function parseBare(source: string): any {
    return babelParser.parse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });
}

/**
 * The local name a file can bind for an imported symbol: `desired` unless
 * the file already binds that name at the top level, in which case a
 * numeric suffix (`helper2`, `helper3`, ...) is applied. The resolved name
 * must be told to the LLM so generated call sites reference it exactly.
 */
export function resolveLocalBinding(desired: string, fileAst: any): string {
    const bound = collectFileLevelBindings(fileAst);
    if (!bound.has(desired)) return desired;
    let candidate = `${desired}2`;
    while (bound.has(candidate)) {
        candidate = `${desired}${Number(candidate.slice(desired.length)) + 1}`;
    }
    return candidate;
}

/**
 * Insert `import { imported as local } from "specifier"` after the last
 * top-level import statement (or at the very top when the file has none).
 * A local name equal to `imported` omits the alias. Returns null when the
 * source cannot be parsed (caller's parse check will reject the rewrite).
 */
export function insertImport(
    source: string,
    specifier: string,
    imported: string,
    local: string,
): string | null {
    let ast: any;
    try {
        ast = parseSource(source);
    } catch {
        return null;
    }

    let insertLine = 0; // 1-based; 0 means "before everything"
    for (const stmt of ast.program.body) {
        if (stmt.type !== "ImportDeclaration") break;
        insertLine = stmt.loc.end.line;
    }

    const aliased = local === imported ? imported : `${imported} as ${local}`;
    const statement = `import { ${aliased} } from "${specifier}";`;
    const lines = source.split("\n");
    return [...lines.slice(0, insertLine), statement, ...lines.slice(insertLine)]
        .join("\n");
}

/** Join path pieces, collapsing any doubled slash from a "/" root. */
function joinPath(a: string, b: string): string {
    return `${a}/${b}`.replace(/\/\//g, "/");
}

/**
 * Absolute path for the shared module: `${dir}/${helperName}.ts`, with a
 * numeric suffix when that path already exists (per-group modules — we
 * never merge into an existing file).
 */
export async function resolveModulePath(
    sharedDirAbs: string,
    helperName: string,
    pathExists: (path: string) => Promise<boolean>,
): Promise<string> {
    let path = joinPath(sharedDirAbs, `${helperName}.ts`);
    let suffix = 1;
    while (await pathExists(path)) {
        suffix++;
        path = joinPath(sharedDirAbs, `${helperName}${suffix}.ts`);
    }
    return path;
}

function overlapsRange(
    startLine: number,
    endLine: number,
    ranges: ChangedRange[],
): boolean {
    return ranges.some((r) => startLine <= r.end && endLine >= r.start);
}

/** Map local import binding -> raw specifier for one file's AST. */
function importBindingSpecifiers(fileAst: any): Map<string, string> {
    const map = new Map<string, string>();
    for (const edge of collectImportEdges(fileAst)) {
        for (const local of edge.named.values()) {
            map.set(local, edge.specifier);
        }
        if (edge.namespaceBinding) {
            map.set(edge.namespaceBinding, edge.specifier);
        }
        if (edge.defaultBinding) {
            map.set(edge.defaultBinding, edge.specifier);
        }
    }
    return map;
}

/**
 * A duplicate group proven placeable: every import its blocks reference can
 * move to the shared module, and the shared directory is resolved. The
 * module file path awaits the LLM-chosen helper name.
 */
export interface GatedGroup {
    group: CrossFileGroup;
    /** Absolute shared directory (ancestor + chosen dir name). */
    sharedDirAbs: string;
}

/**
 * Filter detected groups down to those whose placement is provably safe,
 * logging why the others are skipped. Gates, in order:
 *
 * 1. A usable shared directory exists under the common ancestor.
 * 2. Every import binding referenced by any block is movable: bare
 *    specifiers move verbatim; relative ones must resolve against the
 *    importing file (they are re-targeted from the shared module later).
 */
export async function gateCrossFileGroups(
    groups: CrossFileGroup[],
    files: FileChangeset[],
    baseDir: string,
    readFile: (path: string) => Promise<string | null>,
    log: (msg: string) => void,
): Promise<GatedGroup[]> {
    // Files were parsed during detection with the same babel parser, so
    // parsing here cannot fail; a cache keeps the per-group loop cheap.
    const astCache = new Map<string, any>();
    const astFor = (changeset: FileChangeset): any => {
        let ast = astCache.get(changeset.file);
        if (ast === undefined) {
            ast = parseBare(changeset.source);
            astCache.set(changeset.file, ast);
        }
        return ast;
    };
    const fileByName = new Map(files.map((f) => [f.file, f]));

    const gated: GatedGroup[] = [];
    for (const group of groups) {
        const fileNames = [...new Set(group.blocks.map((b) => b.file))];
        const label = `${group.blocks.length} blocks in ${fileNames.join(", ")}`;

        const absFiles = fileNames.map((f) => `${baseDir}/${f}`);
        const ancestor = commonAncestorDir(absFiles);
        const dirName = await pickSharedDir(
            SHARED_DIR_CANDIDATES,
            ancestor,
            (p) => readFile(p).then((s) => s !== null),
        );
        if (dirName === null) {
            log(
                `dripbird: duplicate_extractor: skipped cross-file group (${label}): no usable shared directory under ${ancestor}`,
            );
            continue;
        }
        const sharedDirAbs = joinPath(ancestor, dirName);

        // Placeholder module path for movability checks: the verdict does
        // not depend on the file name, only on resolvability.
        const placeholderModule = `${sharedDirAbs}/common.ts`;

        let movable = true;
        for (const block of group.blocks) {
            const changeset = fileByName.get(block.file)!;
            const ast = astFor(changeset);
            const used = collectUsedImportBindings(block.statements, ast);
            if (used.size === 0) continue;
            const specifiers = importBindingSpecifiers(ast);
            const fileAbs = `${baseDir}/${block.file}`;
            for (const name of used) {
                // Both maps are built from the same import edges, so every
                // used binding has a specifier.
                const specifier = specifiers.get(name)!;
                const moved = await checkImportMovable(
                    specifier,
                    fileAbs,
                    placeholderModule,
                    readFile,
                );
                if (moved === null) {
                    movable = false;
                    log(
                        `dripbird: duplicate_extractor: skipped cross-file group (${label}): import "${specifier}" (${block.file}) cannot move to the shared module`,
                    );
                    break;
                }
            }
            if (!movable) break;
        }

        if (movable) {
            log(
                `dripbird: duplicate_extractor: cross-file group (${label}) -> ${sharedDirAbs}`,
            );
            gated.push({ group, sharedDirAbs });
        }
    }
    return gated;
}

/**
 * Detect duplicate block groups that span at least two DIFFERENT diff files.
 *
 * Semantics mirror the single-file extractor's diff gate: a fingerprint
 * qualifies when at least ONE of its blocks overlaps the diff in its own
 * file; every block of that fingerprint (in-range or not, in any diff file)
 * then participates as a call site, since extraction rewrites them all.
 * Within one file, overlapping sub-sequences are reduced to a disjoint set
 * (see selectNonOverlapping) so text edits never corrupt the source.
 *
 * Groups whose blocks use `this` are never returned: cross-file extraction
 * moves the helper to a shared module, and no `this` can be reconciled
 * across files (same rule as the single-file extractor's external targets).
 */
export function findCrossFileDuplicateGroups(
    files: FileChangeset[],
    minLines: number,
    maxLines: number,
): CrossFileGroup[] {
    const fpMap = new Map<string, CrossFileBlock[]>();

    for (const { file, source } of files) {
        let ast: any;
        try {
            ast = parseSource(source);
        } catch {
            continue; // unparseable files are skipped wholesale
        }

        for (
            const seq of collectSequences(
                ast,
                source.split("\n"),
                minLines,
                maxLines,
            )
        ) {
            const block: CrossFileBlock = { ...seq, file };
            const list = fpMap.get(seq.fingerprint);
            if (list) {
                list.push(block);
            } else {
                fpMap.set(seq.fingerprint, [block]);
            }
        }
    }

    const groups: CrossFileGroup[] = [];
    for (const [fingerprint, blocks] of fpMap) {
        const filesWithBlocks = new Set(blocks.map((b) => b.file));
        if (filesWithBlocks.size < 2) continue;

        const hasDiffOverlap = blocks.some((b) => {
            const file = files.find((f) => f.file === b.file)!;
            return overlapsRange(b.startLine, b.endLine, file.ranges);
        });
        if (!hasDiffOverlap) continue;

        if (blocks.some((b) => usesThis(b.statements))) continue;

        // Reduce overlapping sub-sequences per file, keeping relative order.
        // Each file keeps at least its earliest block, so a group that
        // reached this point (>= 2 distinct files) always retains >= 2
        // blocks.
        const byFile = new Map<string, CrossFileBlock[]>();
        for (const block of blocks) {
            const list = byFile.get(block.file);
            if (list) {
                list.push(block);
            } else {
                byFile.set(block.file, [block]);
            }
        }
        const selected: CrossFileBlock[] = [];
        for (const [, fileBlocks] of byFile) {
            // selectNonOverlapping returns a subset of the SAME block
            // objects, so each result still carries its `file` tag.
            selected.push(
                ...selectNonOverlapping(fileBlocks) as CrossFileBlock[],
            );
        }

        groups.push({ fingerprint, blocks: selected });
    }

    return groups;
}

/**
 * Cross-file duplicate extraction. Detection and placement gating are wired
 * end to end; the LLM extraction pipeline (helper + call-site generation,
 * rewriting, review) lands in the next piece. Until then the refactor is a
 * no-op that reports what it found under verbose logging.
 */
export function createCrossFileDuplicateExtractor(
    config: Config,
): CrossFileRefactor {
    return async (
        files: FileChangeset[],
        context: CrossFileContext,
    ): Promise<CrossFileResult> => {
        const log = context.log ?? (() => {});

        const groups = findCrossFileDuplicateGroups(
            files,
            config.duplicate_extractor_min_lines,
            config.duplicate_extractor_max_lines,
        );

        await gateCrossFileGroups(
            groups,
            files,
            context.baseDir,
            context.readFile,
            log,
        );

        return {
            modified: new Map(),
            created: new Map(),
            changed: false,
            description: "",
        };
    };
}
