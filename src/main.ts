import { groupByFile, parseDiff } from "./diff.ts";
import { runRefactors } from "./engine.ts";
import { filterRefactors, loadConfig } from "./config.ts";
import type { NamedRefactor } from "./config.ts";
import { createLLMClient } from "./llm.ts";
import { ifNotElse } from "./refactors/if_not_else.ts";
import { createFunctionSplitter } from "./refactors/function_splitter.ts";
import type { LLMOptions } from "./llm.ts";

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
    llmOptions?: LLMOptions,
): Promise<number> {
    if (!diff.trim()) return 0;

    const hunks = parseDiff(diff);
    if (hunks.length === 0) return 0;

    const config = loadConfig(baseDir);

    const namedRefactors: NamedRefactor[] = [
        { name: "if_not_else", refactor: ifNotElse },
    ];

    const llm = createLLMClient(config, llmOptions);
    if (llm) {
        namedRefactors.push({
            name: "function_splitter",
            refactor: createFunctionSplitter(config, llm),
        });
    }

    const refactors = filterRefactors(namedRefactors, config);

    const files = groupByFile(hunks);
    let anyChanged = false;
    let configPrinted = false;

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

        const result = await runRefactors(source, ranges, refactors);

        if (result.changed) {
            if (!configPrinted) {
                console.error(
                    `dripbird: provider=${config.provider} model=${config.model} max_function_lines=${config.max_function_lines} function_splitter_retries=${config.function_splitter_retries}`,
                );
                configPrinted = true;
            }
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
