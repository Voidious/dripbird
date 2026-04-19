import type { ChangedRange } from "./diff.ts";

export interface RefactorResult {
    changed: boolean;
    source: string;
    description: string;
}

export type Refactor = (
    source: string,
    ranges: ChangedRange[],
) => RefactorResult | Promise<RefactorResult>;

export async function runRefactors(
    source: string,
    ranges: ChangedRange[],
    refactors: Refactor[],
): Promise<RefactorResult> {
    let current = source;
    let anyChanged = false;
    const descriptions: string[] = [];

    for (const refactor of refactors) {
        const result = await refactor(current, ranges);
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
