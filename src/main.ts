import { parseDiff } from "./diff.ts";

export async function readStream(
    stream: ReadableStream<Uint8Array>,
): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(merged);
}

export function run(diff: string): number {
    if (!diff.trim()) return 0;

    const hunks = parseDiff(diff);

    if (hunks.length === 0) return 0;

    console.error(
        `dripbird: parsed ${hunks.length} hunk(s) across ${
            new Set(hunks.map((h) => h.file)).size
        } file(s)`,
    );
    console.error("dripbird: no refactors implemented yet");

    return 0;
}
