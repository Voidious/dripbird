import { groupByFile, parseDiff } from "./diff.ts";
import { runRefactors } from "./engine.ts";
import { type Config, filterRefactors, loadConfig } from "./config.ts";
import type { NamedRefactor } from "./engine.ts";
import { createLLMClient, LLMStats } from "./llm.ts";
import { ifNotElse } from "./refactors/if_not_else.ts";
import { createFunctionSplitter } from "./refactors/function_splitter.ts";
import { createFunctionMatcher } from "./refactors/function_matcher.ts";
import { TypeCheckerImpl } from "./type_checker.ts";
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

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

interface FileResult {
    file: string;
    durationMs: number;
    changed: boolean;
    timings: Array<{ name: string; durationMs: number }>;
}

function printSummary(
    overallMs: number,
    fileResults: FileResult[],
    llmStats: LLMStats,
): void {
    console.error(
        `dripbird: summary: ${formatDuration(overallMs)} total, ${
            formatDuration(llmStats.totalDurationMs)
        } llm (${llmStats.callCount} calls, ${llmStats.totalPromptTokens} in / ${llmStats.totalCompletionTokens} out)`,
    );

    const refactorTimings = new Map<string, number>();
    const fileLlm = llmStats.byFile();
    for (const fr of fileResults) {
        for (const t of fr.timings) {
            refactorTimings.set(
                t.name,
                (refactorTimings.get(t.name) ?? 0) + t.durationMs,
            );
        }
    }

    console.error("dripbird:   by refactor:");
    for (const [name, ms] of refactorTimings) {
        console.error(`dripbird:     ${name}: ${formatDuration(ms)}`);
    }

    console.error("dripbird:   by file:");
    for (const fr of fileResults) {
        if (!fr.changed) continue;
        const llmInfo = fileLlm.get(fr.file);
        let msg = `dripbird:     ${fr.file}: ${formatDuration(fr.durationMs)}`;
        if (llmInfo) {
            const tokens = llmInfo.promptTokens + llmInfo.completionTokens;
            msg += `, ${llmInfo.callCount} llm call${
                llmInfo.callCount !== 1 ? "s" : ""
            }, ${tokens} tokens`;
        }
        console.error(msg);
    }
}

function printConfig(config: Config): void {
    const entries: [string, string][] = [
        ["provider", config.provider],
        ["model", config.model],
        ["max_function_lines", String(config.max_function_lines)],
        ["function_splitter_retries", String(config.function_splitter_retries)],
    ];
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
    for (const [key, value] of entries) {
        console.error(`dripbird:   ${`${key}:`.padEnd(maxKeyLen + 2)}${value}`);
    }
}

export async function runInDir(
    diff: string,
    baseDir: string,
    llmOptions?: LLMOptions,
): Promise<number> {
    if (!diff.trim()) return 0;

    const hunks = parseDiff(diff);
    if (hunks.length === 0) return 0;

    const overallStart = performance.now();

    const config = loadConfig(baseDir);
    const llmStats = new LLMStats();

    const pendingLog: string[] = [];
    let logFlushed = false;
    const log = (msg: string) => {
        if (logFlushed) {
            console.error(msg);
        } else {
            pendingLog.push(msg);
        }
    };
    const flushLog = () => {
        for (const msg of pendingLog) {
            console.error(msg);
        }
        pendingLog.length = 0;
        logFlushed = true;
    };

    const namedRefactors: NamedRefactor[] = [
        { name: "if_not_else", refactor: ifNotElse },
    ];

    const llm = createLLMClient(config, {
        ...llmOptions,
        stats: llmStats,
        logFn: log,
    });
    const typeChecker = new TypeCheckerImpl();
    if (llm) {
        namedRefactors.push({
            name: "function_splitter",
            refactor: createFunctionSplitter(
                config,
                llm,
                undefined,
                typeChecker,
            ),
        });
        namedRefactors.push({
            name: "function_matcher",
            refactor: createFunctionMatcher(llm),
        });
    }

    const refactors = filterRefactors(namedRefactors, config);

    const files = groupByFile(hunks);
    let anyChanged = false;
    let configPrinted = false;

    const fileResults: FileResult[] = [];

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

        llmStats.setFile(file);
        const fileStart = performance.now();
        const result = await runRefactors(
            source,
            ranges,
            refactors,
            { filePath },
        );
        const fileDuration = performance.now() - fileStart;

        fileResults.push({
            file,
            durationMs: fileDuration,
            changed: result.changed,
            timings: result.timings,
        });

        if (result.changed) {
            if (!configPrinted) {
                printConfig(config);
                configPrinted = true;
                flushLog();
            }
            await Deno.writeTextFile(filePath, result.source);
            console.error(
                `dripbird: ${file}: ${result.description}`,
            );
            anyChanged = true;
        }
    }

    const overallDuration = performance.now() - overallStart;

    if (anyChanged) {
        printSummary(overallDuration, fileResults, llmStats);
    }

    return anyChanged ? 1 : 0;
}

export function run(diff: string): Promise<number> {
    return runInDir(diff, Deno.cwd());
}
