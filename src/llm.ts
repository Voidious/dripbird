import type { Config } from "./config.ts";

export interface LLMClient {
    nameFunction(
        context: string,
        params: string[],
        forbiddenNames?: string[],
    ): Promise<string>;
}

export interface LLMOptions {
    apiKey?: string;
    fetchFn?: typeof fetch;
    stats?: LLMStats;
    logFn?: (msg: string) => void;
}

export interface LLMCallRecord {
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    file: string | null;
}

export class LLMStats {
    records: LLMCallRecord[] = [];
    currentFile: string | null = null;

    setFile(file: string | null) {
        this.currentFile = file;
    }

    add(record: Omit<LLMCallRecord, "file">) {
        this.records.push({ ...record, file: this.currentFile });
    }

    get totalDurationMs(): number {
        return this.records.reduce((s, r) => s + r.durationMs, 0);
    }

    get totalPromptTokens(): number {
        return this.records.reduce((s, r) => s + r.promptTokens, 0);
    }

    get totalCompletionTokens(): number {
        return this.records.reduce((s, r) => s + r.completionTokens, 0);
    }

    get callCount(): number {
        return this.records.length;
    }

    byFile(): Map<
        string,
        {
            durationMs: number;
            promptTokens: number;
            completionTokens: number;
            callCount: number;
        }
    > {
        const map = new Map<
            string,
            {
                durationMs: number;
                promptTokens: number;
                completionTokens: number;
                callCount: number;
            }
        >();
        for (const r of this.records) {
            const key = r.file ?? "(unknown)";
            const existing = map.get(key) ?? {
                durationMs: 0,
                promptTokens: 0,
                completionTokens: 0,
                callCount: 0,
            };
            existing.durationMs += r.durationMs;
            existing.promptTokens += r.promptTokens;
            existing.completionTokens += r.completionTokens;
            existing.callCount++;
            map.set(key, existing);
        }
        return map;
    }
}

interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

interface ChatResponse {
    choices: Array<{
        message: { content: string };
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export class MoonshotClient implements LLMClient {
    private apiKey: string;
    private model: string;
    private fetchFn: typeof fetch;
    private stats: LLMStats | null;
    private logFn: (msg: string) => void;

    constructor(
        apiKey: string,
        model: string,
        fetchFn?: typeof fetch,
        stats?: LLMStats,
        logFn?: (msg: string) => void,
    ) {
        this.apiKey = apiKey;
        this.model = model;
        this.fetchFn = fetchFn ?? fetch;
        this.stats = stats ?? null;
        this.logFn = logFn ?? ((msg: string) => console.error(msg));
    }

    async nameFunction(
        context: string,
        params: string[],
        forbiddenNames?: string[],
    ): Promise<string> {
        const forbiddenSection = forbiddenNames?.length
            ? `\n\nForbidden names (do NOT use these): ${forbiddenNames.join(", ")}`
            : "";
        const messages: ChatMessage[] = [
            {
                role: "system",
                content:
                    "Suggest a concise camelCase function name for code with the given context and parameters. Reply with ONLY the function name.",
            },
            {
                role: "user",
                content: `Context:\n${context}\n\nParameters: ${
                    params.join(", ")
                }${forbiddenSection}\n\nSuggest a function name:`,
            },
        ];

        if (this.stats) {
            this.logFn(
                `dripbird: llm: naming function (params: ${params.join(", ")})...`,
            );
        }

        const start = performance.now();

        const response = await this.fetchFn(
            "https://api.moonshot.ai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    temperature: 1,
                    max_tokens: 3000,
                }),
            },
        );

        const data: ChatResponse = await response.json();

        const durationMs = performance.now() - start;

        if (!response.ok) {
            if (this.stats) {
                this.logFn(
                    `dripbird: llm: API error ${response.status} after ${
                        Math.round(durationMs)
                    }ms`,
                );
            }
            throw new Error(
                `LLM API error ${response.status}: ${JSON.stringify(data)}`,
            );
        }

        const name = data?.choices?.[0]?.message?.content?.trim();
        if (!name) {
            if (this.stats) {
                this.logFn(
                    `dripbird: llm: bad response after ${Math.round(durationMs)}ms`,
                );
            }
            throw new Error(
                `Unexpected LLM response: ${JSON.stringify(data)}`,
            );
        }

        if (this.stats) {
            const promptTokens = data.usage?.prompt_tokens ?? 0;
            const completionTokens = data.usage?.completion_tokens ?? 0;
            let tokenMsg = "";
            if (data.usage) tokenMsg += `, ${promptTokens} in`;
            if (data.usage) tokenMsg += `, ${completionTokens} out`;
            this.logFn(
                `dripbird: llm: ${Math.round(durationMs)}ms${tokenMsg} → "${name}"`,
            );
            this.stats.add({ durationMs, promptTokens, completionTokens });
        }

        return name;
    }
}

export function createLLMClient(
    config: Config,
    options?: LLMOptions,
): LLMClient | null {
    const apiKey = options?.apiKey ?? Deno.env.get("MOONSHOT_API_KEY");
    if (!apiKey) return null;
    return new MoonshotClient(
        apiKey,
        config.model,
        options?.fetchFn,
        options?.stats,
        options?.logFn,
    );
}
