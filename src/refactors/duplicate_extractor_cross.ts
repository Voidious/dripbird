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
 * Current stage: detection only. Groups are found and logged; extraction
 * (placement, rewriting, LLM flow) arrives in later commits.
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
import { parse } from "recast";
import * as babelParser from "@babel/parser";

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

function overlapsRange(
    startLine: number,
    endLine: number,
    ranges: ChangedRange[],
): boolean {
    return ranges.some((r) => startLine <= r.end && endLine >= r.start);
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
 * Cross-file duplicate extraction. Detection is wired end to end; the
 * extraction pipeline (placement, shared module creation, rewriting, LLM
 * verification) lands in subsequent commits. Until then the refactor is a
 * no-op that reports what it found under verbose logging.
 */
export function createCrossFileDuplicateExtractor(
    config: Config,
): CrossFileRefactor {
    // deno-lint-ignore require-await
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

        for (const group of groups) {
            const fileNames = [...new Set(group.blocks.map((b) => b.file))];
            log(
                `dripbird: duplicate_extractor: cross-file group: ${group.blocks.length} blocks in ${
                    fileNames.join(", ")
                }`,
            );
        }

        return {
            modified: new Map(),
            created: new Map(),
            changed: false,
            description: "",
        };
    };
}
