import type { ChangedRange } from "./diff.ts";
import type { TypeChecker } from "./type_checker.ts";

export interface RefactorResult {
    changed: boolean;
    source: string;
    description: string;
}

export interface RefactorContext {
    filePath: string;
    log?: (msg: string) => void;
    /**
     * Read a file by absolute path, returning null when unreadable. Enables
     * cross-file refactoring (e.g. the function matcher following existing
     * relative imports).
     */
    readFile?: (path: string) => Promise<string | null>;
}

export type Refactor = (
    source: string,
    ranges: ChangedRange[],
    context?: RefactorContext,
) => RefactorResult | Promise<RefactorResult>;

export interface NamedRefactor {
    name: string;
    refactor: Refactor;
}

/**
 * One diff file handed to a cross-file refactor: its path relative to the
 * working directory (as written in the diff), its on-disk source, and the
 * changed-line ranges that overlap the diff.
 */
export interface FileChangeset {
    file: string;
    source: string;
    ranges: ChangedRange[];
}

export interface CrossFileContext {
    /** Absolute working directory the diff applies to. */
    baseDir: string;
    log?: (msg: string) => void;
    /**
     * Read a file by absolute path, returning null when unreadable. Lets
     * cross-file refactors follow existing imports and inspect files that are
     * not part of the diff.
     */
    readFile: (path: string) => Promise<string | null>;
    /**
     * Shared semantic checker for deterministic gates on multi-file
     * proposals (baseline-diffed, like the single-file extractors).
     * Optional: without it, refactors fall back to parse checks + review.
     */
    typeChecker?: TypeChecker;
}

export interface CrossFileResult {
    /** Existing diff file (relative path) -> rewritten source. */
    modified: Map<string, string>;
    /** New file (relative path) -> content to create. */
    created: Map<string, string>;
    changed: boolean;
    description: string;
}

/**
 * A refactor that sees every file in the diff at once and may rewrite them
 * and/or create new files (e.g. a shared helper module). Unlike `Refactor`,
 * which transforms one file in isolation, a cross-file refactor coordinates
 * multiple files in a single pass.
 */
export type CrossFileRefactor = (
    files: FileChangeset[],
    context: CrossFileContext,
) => CrossFileResult | Promise<CrossFileResult>;

export interface NamedCrossFileRefactor {
    name: string;
    refactor: CrossFileRefactor;
}

export interface RunResult extends RefactorResult {
    timings: Array<{ name: string; durationMs: number }>;
}

export async function runRefactors(
    source: string,
    ranges: ChangedRange[],
    refactors: NamedRefactor[],
    context?: RefactorContext,
): Promise<RunResult> {
    let current = source;
    let anyChanged = false;
    const descriptions: string[] = [];
    const timings: Array<{ name: string; durationMs: number }> = [];

    for (const { name, refactor } of refactors) {
        const start = performance.now();
        const result = await refactor(current, ranges, context);
        const durationMs = performance.now() - start;
        timings.push({ name, durationMs });
        if (result.changed) {
            current = result.source;
            anyChanged = true;
            descriptions.push(result.description);
        }
    }

    return {
        changed: anyChanged,
        source: current,
        description: descriptions.join("\n"),
        timings,
    };
}
