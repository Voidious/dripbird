import type { ChangedRange } from "./diff.ts";

export interface RefactorResult {
    changed: boolean;
    source: string;
    description: string;
}

export type Refactor = (
    source: string,
    ranges: ChangedRange[],
) => RefactorResult;

export function runRefactors(
    source: string,
    ranges: ChangedRange[],
    refactors: Refactor[],
): RefactorResult {
    let current = source;
    let anyChanged = false;
    const descriptions: string[] = [];

    for (const refactor of refactors) {
        const result = refactor(current, ranges);
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
    };
}
