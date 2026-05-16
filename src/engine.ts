import type { ChangedRange } from "./diff.ts";

export interface RefactorResult {
    changed: boolean;
    source: string;
    description: string;
}

export interface RefactorContext {
    filePath: string;
    log?: (msg: string) => void;
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
