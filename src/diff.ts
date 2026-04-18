export interface DiffHunk {
    file: string;
    newStart: number;
    newCount: number;
    oldStart: number;
    oldCount: number;
}

export interface ChangedRange {
    start: number;
    end: number;
}

export interface FileChanges {
    file: string;
    ranges: ChangedRange[];
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

export function groupByFile(hunks: DiffHunk[]): FileChanges[] {
    const map = new Map<string, ChangedRange[]>();
    for (const hunk of hunks) {
        if (hunk.file === "/dev/null" || hunk.newCount === 0) continue;
        let ranges = map.get(hunk.file);
        if (!ranges) {
            ranges = [];
            map.set(hunk.file, ranges);
        }
        ranges.push({
            start: hunk.newStart,
            end: hunk.newStart + hunk.newCount - 1,
        });
    }
    return Array.from(map.entries()).map(([file, ranges]) => ({
        file,
        ranges,
    }));
}
