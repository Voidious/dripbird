import { groupByFile, parseDiff } from "./diff.ts";
import { runRefactors } from "./engine.ts";
import { ifNotElse } from "./refactors/if_not_else.ts";

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

export async function runInDir(
    diff: string,
    baseDir: string,
): Promise<number> {
    if (!diff.trim()) return 0;

    const hunks = parseDiff(diff);
    if (hunks.length === 0) return 0;

    const files = groupByFile(hunks);
    let anyChanged = false;

    for (const { file, ranges } of files) {
        const filePath = `${baseDir}/${file}`;
        let source: string;
        try {
            source = await Deno.readTextFile(filePath);
        } catch {
            console.error(
                `dripbird: skipping ${file}: unable to read`,
            );
            continue;
        }

        const result = runRefactors(source, ranges, [ifNotElse]);

        if (result.changed) {
            await Deno.writeTextFile(filePath, result.source);
            console.error(
                `dripbird: ${file}: ${result.description}`,
            );
            anyChanged = true;
        }
    }

    return anyChanged ? 1 : 0;
}

export function run(diff: string): Promise<number> {
    return runInDir(diff, Deno.cwd());
}
