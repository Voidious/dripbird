const decoder = new TextDecoder();

async function readStdin(): Promise<string> {
    const chunks: Uint8Array[] = [];
    const stdin = Deno.stdin.readable;
    for await (const chunk of stdin) {
        chunks.push(chunk);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return decoder.decode(merged);
}

interface DiffHunk {
    file: string;
    newStart: number;
    newCount: number;
    oldStart: number;
    oldCount: number;
}

function parseDiff(diff: string): DiffHunk[] {
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

async function main(): Promise<never> {
    const diff = await readStdin();

    if (!diff.trim()) {
        Deno.exit(0);
    }

    const hunks = parseDiff(diff);

    if (hunks.length === 0) {
        Deno.exit(0);
    }

    console.error(
        `dripbird: parsed ${hunks.length} hunk(s) across ${
            new Set(hunks.map((h) => h.file)).size
        } file(s)`,
    );
    console.error("dripbird: no refactors implemented yet");

    Deno.exit(0);
}

main();
