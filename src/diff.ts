export interface DiffHunk {
    file: string;
    newStart: number;
    newCount: number;
    oldStart: number;
    oldCount: number;
}

export function parseDiff(diff: string): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    const lines = diff.split("\n");
    let currentFile = "";

    for (const line of lines) {
        const fileMatch = line.match(/^\+\+\+ [ab]\/(.+)$/);
        if (fileMatch) {
            currentFile = fileMatch[1];
            continue;
        }

        const hunkMatch = line.match(
            /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
        );
        if (hunkMatch && currentFile) {
            hunks.push({
                file: currentFile,
                oldStart: parseInt(hunkMatch[1]),
                oldCount: hunkMatch[2] ? parseInt(hunkMatch[2]) : 1,
                newStart: parseInt(hunkMatch[3]),
                newCount: hunkMatch[4] ? parseInt(hunkMatch[4]) : 1,
            });
        }
    }

    return hunks;
}
