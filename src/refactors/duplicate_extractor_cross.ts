// deno-lint-ignore-file no-explicit-any
/**
 * Cross-file support for the duplicate extractor (0.3.3).
 *
 * This module sees every file in the diff at once and extracts duplicate
 * blocks that live in DIFFERENT files into a shared module placed under
 * the deepest common ancestor of the involved files — see
 * PLANS/DRIPBIRD_033_CROSS_FILE_DUPLICATE_EXTRACTOR.md for the placement
 * and cycle-safety design.
 *
 * Pipeline per group (mirrors the single-file extractor):
 * detect (fingerprint) -> placement gating (deterministic, pre-LLM) ->
 * LLM verify -> LLM generate helper + call sites (with the leaf-import
 * constraint and per-file provenance) -> parse checks -> LLM review ->
 * apply. Accepted groups rewrite their files (import + call sites) and
 * create the shared module; detection then re-runs on the updated
 * sources, exactly like the single-file re-detection loop.
 */
import type { ChangedRange } from "../diff.ts";
import type { Config } from "../config.ts";
import type {
    CrossFileContext,
    CrossFileRefactor,
    CrossFileResult,
    FileChangeset,
} from "../engine.ts";
import type {
    CrossFileReviewCallSite,
    DuplicateVerifyResult,
    ExtractionResult,
    LLMClient,
    ReviewResult,
} from "../llm.ts";
import {
    applyTextEdit,
    collectSequences,
    detectBaseIndent,
    normalizeCallSiteIndent,
    selectNonOverlapping,
    type SeqInfo,
    usesThis,
} from "./duplicate_extractor.ts";
import { collectFileLevelBindings, JS_TS_KEYWORDS } from "./function_splitter.ts";
import {
    checkImportMovable,
    collectUsedImportBindings,
    commonAncestorDir,
    pickSharedDir,
    relativeSpecifier,
} from "./duplicate_extractor_placement.ts";
import { collectImportEdges } from "./function_matcher_imports.ts";
import type { TypeChecker } from "../type_checker.ts";
import { parse } from "recast";
import * as babelParser from "@babel/parser";

/**
 * Fallback shared-directory names tried after the configured preferred
 * name (see `sharedDirCandidates`).
 */
const SHARED_DIR_CANDIDATES = ["common", "shared", "lib", "util"];

/**
 * Candidate shared-directory names under the common ancestor, tried in
 * order: the configured name first (`duplicate_extractor_shared_dir`,
 * default `common`), then the boring backups that are not already in
 * the list.
 */
export function sharedDirCandidates(config: Config): string[] {
    const preferred = config.duplicate_extractor_shared_dir;
    return [preferred, ...SHARED_DIR_CANDIDATES.filter((d) => d !== preferred)];
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A duplicate block tagged with the file it was found in. */
export interface CrossFileBlock extends SeqInfo {
    file: string;
}

export interface CrossFileGroup {
    fingerprint: string;
    blocks: CrossFileBlock[];
}

/** One import the shared module must carry for the helper to work. */
interface HelperImport {
    /** Import statement for the shared module (rewritten specifier). */
    line: string;
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

/** Join path pieces, collapsing any doubled slash from a "/" root. */
function joinPath(a: string, b: string): string {
    return `${a}/${b}`.replace(/\/\//g, "/");
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

    return insertImportAtLine(
        source,
        lastImportEndLine(ast),
        specifier,
        imported,
        local,
    );
}

/** Line number (1-based) just past the last top-level import, else 0. */
function lastImportEndLine(ast: any): number {
    let insertLine = 0;
    for (const stmt of ast.program.body) {
        if (stmt.type !== "ImportDeclaration") break;
        insertLine = stmt.loc.end.line;
    }
    return insertLine;
}

/**
 * First line (0-based index) of real code: skips leading blank lines,
 * line comments, block comments, and a shebang. An import inserted above
 * them would strand file-scoped directives like `// deno-lint-ignore-file`.
 */
function firstCodeLineIndex(lines: string[]): number {
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (inBlockComment) {
            if (text.includes("*/")) inBlockComment = false;
        } else if (text === "" || text.startsWith("//") || text.startsWith("#!")) {
            continue;
        } else if (text.startsWith("/*")) {
            if (!text.includes("*/")) inBlockComment = true;
        } else {
            return i;
        }
    }
    return lines.length;
}

/**
 * Splice an import statement after `insertLine` (1-based; 0 = before the
 * first code line, keeping any leading comments above the import). Text
 * edits in function bodies never move a file's top-of-file imports, so
 * callers that already hold the file's AST can pass the line directly
 * instead of re-parsing mid-rewrite.
 */
function insertImportAtLine(
    source: string,
    insertLine: number,
    specifier: string,
    imported: string,
    local: string,
): string {
    const aliased = local === imported ? imported : `${imported} as ${local}`;
    const statement = `import { ${aliased} } from "${specifier}";`;
    const lines = source.split("\n");
    // A file's first import is separated from the code below it by a blank
    // line; an import joining existing imports sits directly after them.
    const at = insertLine === 0 ? firstCodeLineIndex(lines) : insertLine;
    const separator = insertLine === 0 && lines[at]?.trim() !== "" ? [""] : [];
    return [
        ...lines.slice(0, at),
        statement,
        ...separator,
        ...lines.slice(at),
    ].join("\n");
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
    candidateDirs: string[] = SHARED_DIR_CANDIDATES,
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
            candidateDirs,
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

/** A finished, reviewed extraction ready to apply. */
interface GroupExtraction {
    /** Shared module path relative to baseDir. */
    moduleRel: string;
    moduleContent: string;
    /** Rewritten sources for the involved files. */
    fileEdits: Map<string, string>;
    description: string;
}

/**
 * Compute the import statements the shared module needs so the helper can
 * reference the module-level names the blocks used. Names resolve per file;
 * the FIRST binding wins when several files bind the same import target
 * under the same local name, but a local name that resolves to two
 * DIFFERENT imports is a semantic conflict and rejects the group (returns
 * null). Unmovable imports also reject (should not happen post-gating).
 */
async function collectHelperImports(
    blocks: CrossFileBlock[],
    sources: Map<string, string>,
    baseDir: string,
    sharedDirAbs: string,
    readFile: (path: string) => Promise<string | null>,
): Promise<HelperImport[] | null> {
    const placeholderModule = joinPath(sharedDirAbs, "_.ts");

    // localName -> dedup key (shape:specifier:importedName)
    const byLocal = new Map<string, string>();
    const imports = new Map<string, HelperImport>();

    const perFile = new Map<string, CrossFileBlock[]>();
    for (const block of blocks) {
        const list = perFile.get(block.file);
        if (list) list.push(block);
        else perFile.set(block.file, [block]);
    }

    for (const [file, fileBlocks] of perFile) {
        const ast = parseBare(sources.get(file)!);

        const used = new Set<string>();
        for (const block of fileBlocks) {
            for (const name of collectUsedImportBindings(block.statements, ast)) {
                used.add(name);
            }
        }
        if (used.size === 0) continue;

        for (const edge of collectImportEdges(ast)) {
            const moved = await checkImportMovable(
                edge.specifier,
                `${baseDir}/${file}`,
                placeholderModule,
                readFile,
            );
            if (moved === null) continue; // unmovable edge: not one the blocks need

            const bindings: Array<{
                local: string;
                key: string;
                line: string;
            }> = [];
            for (const [imported, local] of edge.named) {
                if (!used.has(local)) continue;
                bindings.push({
                    local,
                    key: `named:${moved.specifier}:${imported}`,
                    line: local === imported
                        ? `import { ${imported} } from "${moved.specifier}";`
                        : `import { ${imported} as ${local} } from "${moved.specifier}";`,
                });
            }
            if (edge.namespaceBinding && used.has(edge.namespaceBinding)) {
                bindings.push({
                    local: edge.namespaceBinding,
                    key: `namespace:${moved.specifier}`,
                    line:
                        `import * as ${edge.namespaceBinding} from "${moved.specifier}";`,
                });
            }
            if (edge.defaultBinding && used.has(edge.defaultBinding)) {
                bindings.push({
                    local: edge.defaultBinding,
                    key: `default:${moved.specifier}`,
                    line:
                        `import ${edge.defaultBinding} from "${moved.specifier}";`,
                });
            }

            for (const { local, key, line } of bindings) {
                const existingKey = byLocal.get(local);
                if (existingKey !== undefined && existingKey !== key) {
                    return null; // same name, different import: ambiguous
                }
                byLocal.set(local, key);
                if (!imports.has(key)) imports.set(key, { line });
            }
        }
    }

    return [...imports.values()];
}

/**
 * Run the full LLM pipeline for one gated group: verify, generate (with
 * retries), parse-check, review. Returns the finished extraction, or null
 * when the group is rejected or every attempt fails.
 */
async function extractGroup(
    gated: GatedGroup,
    llm: LLMClient,
    config: Config,
    sources: Map<string, string>,
    created: Map<string, string>,
    baseDir: string,
    readFile: (path: string) => Promise<string | null>,
    pathExists: (path: string) => Promise<boolean>,
    relOf: (abs: string) => string,
    astOf: (file: string) => any,
    typeChecker: TypeChecker | undefined,
    log: (msg: string) => void,
): Promise<GroupExtraction | null> {
    const group = gated.group;
    const blocks = group.blocks;
    const label = `${blocks.length} blocks in ${
        [...new Set(blocks.map((b) => b.file))].join(", ")
    }`;

    const verifyResult: DuplicateVerifyResult = await llm
        .verifyCrossFileDuplicateMatch(
            blocks.map((b) => ({ file: b.file, source: b.source })),
        );
    if (!verifyResult.isMatch) {
        log(
            `dripbird: duplicate_extractor: LLM rejected cross-file group (${label}): ${verifyResult.reason}`,
        );
        return null;
    }

    let remaining = blocks;
    if (verifyResult.excludeIndices.length > 0) {
        const exclude = new Set(verifyResult.excludeIndices);
        remaining = blocks.filter((_, i) => !exclude.has(i));
        const remainingFiles = new Set(remaining.map((b) => b.file));
        if (remainingFiles.size < 2) {
            log(
                `dripbird: duplicate_extractor: too few files after exclusion (${label})`,
            );
            return null;
        }
    }

    const helperImports = await collectHelperImports(
        remaining,
        sources,
        baseDir,
        gated.sharedDirAbs,
        readFile,
    );
    if (helperImports === null) {
        log(
            `dripbird: duplicate_extractor: skipped cross-file group (${label}): conflicting or unmovable imports for the shared module`,
        );
        return null;
    }

    const forbiddenNames = new Set<string>(JS_TS_KEYWORDS);
    for (const file of new Set(remaining.map((b) => b.file))) {
        for (const name of collectFileLevelBindings(astOf(file))) {
            forbiddenNames.add(name);
        }
    }

    const relSharedDir = relOf(gated.sharedDirAbs);
    const maxAttempts = config.duplicate_extractor_retries + 1;
    let lastFeedback = "";

    // Baseline diagnostics for the type-check gate: every diff file's
    // current source plus modules created by earlier passes, virtualized
    // at their real absolute paths so imports between them resolve. Null
    // when no multi-file checker is wired (gate becomes a no-op).
    let baselineKeys: Set<string> | null = null;
    if (typeChecker?.initForFiles) {
        const baseline = [...sources].map(([file, source]) => ({
            path: `${baseDir}/${file}`,
            source,
        }));
        for (const [rel, content] of created) {
            baseline.push({ path: `${baseDir}/${rel}`, source: content });
        }
        await typeChecker.initForFiles(baseline);
        baselineKeys = new Set(
            typeChecker.getSemanticErrors().map((e) =>
                `${e.file}:${e.code}:${e.message}`
            ),
        );
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const extraction: ExtractionResult = await llm
            .generateCrossFileExtraction(
                remaining.map((b) => ({ file: b.file, source: b.source })),
                {
                    modulePath: `${relSharedDir}/<helperName>.ts`,
                    imports: helperImports.map((i) => i.line),
                },
                [...forbiddenNames].sort(),
                lastFeedback || undefined,
            );

        if (extraction.callSites.length !== remaining.length) {
            lastFeedback =
                `Expected exactly ${remaining.length} call sites but got ${extraction.callSites.length}. Try again.`;
            continue;
        }

        const helperName = extraction.helperName;
        if (!IDENTIFIER_RE.test(helperName) || JS_TS_KEYWORDS.has(helperName)) {
            lastFeedback =
                `"${helperName}" is not a usable helper name. Choose a descriptive camelCase identifier.`;
            continue;
        }

        const moduleAbs = await resolveModulePath(
            gated.sharedDirAbs,
            helperName,
            pathExists,
        );
        const moduleRel = relOf(moduleAbs);

        // Pair each block with its generated call site, then group by file
        // (keeping block order, which is ascending per file).
        const pairs = remaining.map((b, i) => ({
            block: b,
            cs: extraction.callSites[i],
        }));
        const byFile = new Map<string, typeof pairs>();
        for (const pair of pairs) {
            const list = byFile.get(pair.block.file);
            if (list) list.push(pair);
            else byFile.set(pair.block.file, [pair]);
        }

        const fileEdits = new Map<string, string>();
        const reviewSites: CrossFileReviewCallSite[] = [];
        let failed = false;

        for (const [file, filePairs] of byFile) {
            const current = sources.get(file)!;
            const ast = astOf(file);
            const binding = resolveLocalBinding(helperName, ast);
            const specifier = relativeSpecifier(
                `${baseDir}/${file}`,
                moduleAbs,
            );
            const importLine = binding === helperName
                ? `import { ${helperName} } from "${specifier}";`
                : `import { ${helperName} as ${binding} } from "${specifier}";`;

            let proposed = current;
            // Apply edits bottom-up so earlier line numbers stay valid.
            const sorted = [...filePairs].sort((a, b) =>
                b.block.startLine - a.block.startLine
            );
            for (const { block, cs } of sorted) {
                let callSite = cs;
                if (binding !== helperName) {
                    // Identifiers contain no regex metacharacters after the
                    // validation above, so this substitution is safe.
                    callSite = callSite.replaceAll(
                        `${helperName}(`,
                        `${binding}(`,
                    );
                }
                callSite = normalizeCallSiteIndent(
                    callSite,
                    detectBaseIndent(block.source),
                );
                proposed = applyTextEdit(
                    proposed,
                    block.startLine,
                    block.endLine,
                    callSite,
                );
                reviewSites.push({
                    file,
                    location:
                        `lines ${block.startLine}-${block.endLine} (${block.scope})`,
                    importLine,
                    originalBlock: block.source,
                    replacement: callSite,
                });
            }

            const withImport = insertImportAtLine(
                proposed,
                lastImportEndLine(ast),
                specifier,
                helperName,
                binding,
            );
            try {
                parseBare(withImport);
            } catch {
                lastFeedback =
                    `The rewrite of ${file} did not parse. Regenerate the call sites as valid TypeScript.`;
                failed = true;
                break;
            }
            fileEdits.set(file, withImport);
        }
        if (failed) {
            log(
                `dripbird: duplicate_extractor: rewrite failed (attempt ${
                    attempt + 1
                }/${maxAttempts})`,
            );
            continue;
        }

        const helperFn = extraction.helperFunction.trim().replace(
            /^export\s+/,
            "",
        );
        const moduleContent = (helperImports.length > 0
            ? `${
                helperImports.map((i) => i.line).join("\n")
            }\n\n`
            : "") + `export ${helperFn}\n`;
        try {
            parseBare(moduleContent);
        } catch {
            lastFeedback =
                "The helper function did not produce a valid module. Regenerate it as a single top-level function declaration.";
            log(
                `dripbird: duplicate_extractor: shared module didn't parse (attempt ${
                    attempt + 1
                }/${maxAttempts})`,
            );
            continue;
        }

        // Deterministic type-check gate, mirroring the single-file
        // extractor: baseline the current multi-file state (all diff files
        // + modules created by earlier passes, virtualized at their real
        // paths so cross-imports resolve), then reject any attempt whose
        // diagnostics contain a (file, code, message) pair the baseline
        // lacks. Catches build-breakers the parse checks and the LLM
        // review both miss (e.g. a call site left referencing a binding
        // that now lives inside the helper).
        if (typeChecker?.initForFiles && baselineKeys !== null) {
            const proposal = [...sources].map(([file, source]) => ({
                path: `${baseDir}/${file}`,
                source: fileEdits.get(file) ?? source,
            }));
            for (const [rel, content] of created) {
                proposal.push({ path: `${baseDir}/${rel}`, source: content });
            }
            proposal.push({ path: moduleAbs, source: moduleContent });
            await typeChecker.initForFiles(proposal);
            const newErrors = typeChecker.getSemanticErrors().filter((e) =>
                !baselineKeys.has(`${e.file}:${e.code}:${e.message}`)
            );
            if (newErrors.length > 0) {
                lastFeedback =
                    "The previous extraction introduced type errors. Keep the helper and call sites, but fix these so every file still type-checks:\n" +
                    newErrors.map((e) =>
                        `${e.file} line ${e.line}: [TS${e.code}] ${e.message}`
                    ).join("\n");
                log(
                    `dripbird: duplicate_extractor: type-check failed (attempt ${
                        attempt + 1
                    }/${maxAttempts}): ${
                        newErrors.map((e) => `[TS${e.code}] ${e.message}`)
                            .join("; ")
                    }`,
                );
                continue;
            }
        }

        const description =
            `extracted cross-file duplicate code into ${moduleRel} (replacing ${remaining.length} blocks across ${byFile.size} files)`;
        const reviewResult: ReviewResult = await llm.reviewCrossFileChange(
            description,
            {
                modulePath: moduleRel,
                helperModule: moduleContent,
                callSites: reviewSites,
            },
        );
        if (!reviewResult.accepted) {
            log(
                `dripbird: duplicate_extractor: LLM review rejected (attempt ${
                    attempt + 1
                }/${maxAttempts}): ${reviewResult.feedback}`,
            );
            lastFeedback = reviewResult.feedback;
            continue;
        }

        return { moduleRel, moduleContent, fileEdits, description };
    }

    return null;
}

/**
 * Cross-file duplicate extraction: detect duplicate blocks across diff
 * files, place their helper in a shared module under the common ancestor,
 * and rewrite every involved file to import and call it. Cycle safety comes
 * from placement (see duplicate_extractor_placement.ts): the shared module
 * is a leaf whose imports were proven movable, and it is always a NEW file.
 */
export function createCrossFileDuplicateExtractor(
    config: Config,
    llm: LLMClient,
): CrossFileRefactor {
    return async (
        files: FileChangeset[],
        context: CrossFileContext,
    ): Promise<CrossFileResult> => {
        const log = context.log ?? (() => {});
        const baseDir = context.baseDir;
        // Every path handed to relOf is built from `${baseDir}/${file}`
        // pieces (the shared directory is derived from those paths), so the
        // prefix is guaranteed.
        const relOf = (abs: string) => abs.slice(baseDir.length + 1);

        const sources = new Map(files.map((f) => [f.file, f.source]));
        const originalSources = new Map(sources);
        const rangesByFile = new Map(files.map((f) => [f.file, f.ranges]));
        const created = new Map<string, string>();
        const descriptions: string[] = [];
        const doneFingerprints = new Set<string>();

        // ASTs are re-parsed whenever a file's source changes.
        const astCache = new Map<string, any>();
        const astOf = (file: string): any => {
            let ast = astCache.get(file);
            if (ast === undefined) {
                ast = parseBare(sources.get(file)!);
                astCache.set(file, ast);
            }
            return ast;
        };

        // Modules created by earlier passes exist only in memory until the
        // refactor returns, so every read must consult `created` first —
        // otherwise gating false-rejects imports of those modules as
        // unmovable (they "don't resolve" on disk yet).
        const readFile = async (abs: string): Promise<string | null> => {
            if (abs.startsWith(`${baseDir}/`)) {
                const rel = abs.slice(baseDir.length + 1);
                const content = created.get(rel);
                if (content !== undefined) return content;
            }
            return await context.readFile(abs);
        };

        const pathExists = async (abs: string) => (await readFile(abs)) !== null;

        const initialGroups = findCrossFileDuplicateGroups(
            files,
            config.duplicate_extractor_min_lines,
            config.duplicate_extractor_max_lines,
        );

        // One group per pass; re-detect after each accepted extraction so
        // coordinates stay exact (mirrors the single-file re-detection
        // loop). Rejected fingerprints are never retried within a run.
        for (let pass = 0; pass < initialGroups.length + 1; pass++) {
            const changesets: FileChangeset[] = [...sources].map((
                [file, source],
            ) => ({ file, source, ranges: rangesByFile.get(file)! }));

            const groups = findCrossFileDuplicateGroups(
                changesets,
                config.duplicate_extractor_min_lines,
                config.duplicate_extractor_max_lines,
            ).filter((g) => !doneFingerprints.has(g.fingerprint));
            if (groups.length === 0) break;

            const gated = await gateCrossFileGroups(
                groups,
                changesets,
                baseDir,
                readFile,
                log,
                sharedDirCandidates(config),
            );
            if (gated.length === 0) break;

            const target = gated[0];
            doneFingerprints.add(target.group.fingerprint);

            const outcome = await extractGroup(
                target,
                llm,
                config,
                sources,
                created,
                baseDir,
                readFile,
                pathExists,
                relOf,
                astOf,
                context.typeChecker,
                log,
            );
            if (outcome === null) continue;

            for (const [file, source] of outcome.fileEdits) {
                sources.set(file, source);
                astCache.delete(file);
            }
            created.set(outcome.moduleRel, outcome.moduleContent);
            descriptions.push(outcome.description);
        }

        const modified = new Map<string, string>();
        for (const [file, source] of sources) {
            if (source !== originalSources.get(file)) modified.set(file, source);
        }

        return {
            modified,
            created,
            changed: descriptions.length > 0,
            description: descriptions.join("\n"),
        };
    };
}
