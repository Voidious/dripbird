import type { Config } from "./config.ts";

export interface FunctionMatchResult {
    isMatch: boolean;
    reason: string;
}

export interface ReviewResult {
    accepted: boolean;
    feedback: string;
}

export interface LLMClient {
    nameFunction(
        context: string,
        params: string[],
        forbiddenNames?: string[],
    ): Promise<string>;

    verifyFunctionMatch(
        codeBlock: string,
        funcSource: string,
        fileSource: string,
    ): Promise<FunctionMatchResult>;

    generateCallReplacement(
        codeBlock: string,
        funcName: string,
        funcSource: string,
        fileSource: string,
    ): Promise<string>;

    reviewChange(
        originalSource: string,
        proposedSource: string,
        description: string,
    ): Promise<ReviewResult>;
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

interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required: string[];
        };
    };
}

interface ToolCallResponse {
    choices: Array<{
        message: {
            content: string | null;
            tool_calls?: Array<{
                function: {
                    name: string;
                    arguments: string;
                };
            }>;
        };
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
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

    private async callWithTool<T>(
        messages: ChatMessage[],
        tool: ToolDefinition,
        logLabel: string,
    ): Promise<T> {
        if (this.stats) {
            this.logFn(`dripbird: llm: ${logLabel}...`);
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
                    max_tokens: 1024,
                    tools: [tool],
                    tool_choice: "required",
                    thinking: { type: "disabled" },
                }),
            },
        );

        const data: ToolCallResponse = await response.json();
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

        const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
        if (!toolCall || toolCall.function.name !== tool.function.name) {
            if (this.stats) {
                this.logFn(
                    `dripbird: llm: no tool response after ${
                        Math.round(durationMs)
                    }ms`,
                );
            }
            throw new Error(
                `Unexpected LLM response: ${JSON.stringify(data)}`,
            );
        }

        const result = JSON.parse(toolCall.function.arguments) as T;

        if (this.stats) {
            const promptTokens = data.usage?.prompt_tokens ?? 0;
            const completionTokens = data.usage?.completion_tokens ?? 0;
            this.logFn(
                `dripbird: llm: ${
                    Math.round(durationMs)
                }ms, ${promptTokens} in, ${completionTokens} out → ${logLabel}`,
            );
            this.stats.add({ durationMs, promptTokens, completionTokens });
        }

        return result;
    }

    async verifyFunctionMatch(
        codeBlock: string,
        funcSource: string,
        fileSource: string,
    ): Promise<FunctionMatchResult> {
        const snippet = fileSource.length > 4000
            ? fileSource.slice(0, 4000)
            : fileSource;
        const messages: ChatMessage[] = [
            {
                role: "user",
                content:
                    `A code block in a TypeScript/JavaScript file may be replaceable by a call to an existing function.\n\n` +
                    `Code block:\n\`\`\`typescript\n${codeBlock.trim()}\n\`\`\`\n\n` +
                    `Existing function:\n\`\`\`typescript\n${funcSource.trim()}\n\`\`\`\n\n` +
                    `File source:\n\`\`\`typescript\n${snippet}\n\`\`\`\n\n` +
                    `Does this code block perform the same semantic operation as the function body, such that it could be replaced by a call to the function? Use the evaluate tool.`,
            },
        ];
        const tool: ToolDefinition = {
            type: "function",
            function: {
                name: "evaluate_match",
                description:
                    "Evaluate whether a code block semantically matches a function body",
                parameters: {
                    type: "object",
                    properties: {
                        is_match: {
                            type: "boolean",
                            description:
                                "True if the code block performs the same operation as the function body",
                        },
                        reason: {
                            type: "string",
                            description: "Explanation of the evaluation",
                        },
                    },
                    required: ["is_match", "reason"],
                },
            },
        };
        const result = await this.callWithTool<{
            is_match: boolean;
            reason: string;
        }>(messages, tool, "verify function match");
        return { isMatch: result.is_match, reason: result.reason };
    }

    async generateCallReplacement(
        codeBlock: string,
        funcName: string,
        funcSource: string,
        fileSource: string,
    ): Promise<string> {
        const snippet = fileSource.length > 4000
            ? fileSource.slice(0, 4000)
            : fileSource;
        const messages: ChatMessage[] = [
            {
                role: "user",
                content:
                    `Replace this code block with a call to the existing function '${funcName}'.\n\n` +
                    `Code block:\n\`\`\`typescript\n${codeBlock.trim()}\n\`\`\`\n\n` +
                    `Function '${funcName}':\n\`\`\`typescript\n${funcSource.trim()}\n\`\`\`\n\n` +
                    `File source:\n\`\`\`typescript\n${snippet}\n\`\`\`\n\n` +
                    `Generate a replacement that preserves the original indentation and covers exactly the lines of the code block. Pass the replacement to the generate_call tool.`,
            },
        ];
        const tool: ToolDefinition = {
            type: "function",
            function: {
                name: "generate_call",
                description:
                    "Generate a call to an existing function that replaces a code block",
                parameters: {
                    type: "object",
                    properties: {
                        replacement: {
                            type: "string",
                            description:
                                "Complete replacement source including indentation",
                        },
                    },
                    required: ["replacement"],
                },
            },
        };
        const result = await this.callWithTool<{ replacement: string }>(
            messages,
            tool,
            "generate call replacement",
        );
        return result.replacement;
    }

    async reviewChange(
        originalSource: string,
        proposedSource: string,
        description: string,
    ): Promise<ReviewResult> {
        const messages: ChatMessage[] = [
            {
                role: "user",
                content: `Review this proposed code change.\n\n` +
                    `Description: ${description}\n\n` +
                    `Original:\n\`\`\`typescript\n${originalSource.trim()}\n\`\`\`\n\n` +
                    `Proposed:\n\`\`\`typescript\n${proposedSource.trim()}\n\`\`\`\n\n` +
                    `Check each of the following:\n` +
                    `1. Every variable read in the original block that is not locally assigned is passed as a parameter or available in scope\n` +
                    `2. Every variable assigned in the original block and used afterward is still defined\n` +
                    `3. No parameter is assigned before it is first read in the called function\n` +
                    `4. If the original block ends with a return, the replacement also propagates that return value\n` +
                    `5. The replacement covers exactly the lines of the original block\n` +
                    `6. The replacement preserves the original indentation\n` +
                    `Use the review tool to answer.`,
            },
        ];
        const tool: ToolDefinition = {
            type: "function",
            function: {
                name: "review",
                description: "Review a proposed code change",
                parameters: {
                    type: "object",
                    properties: {
                        accepted: {
                            type: "boolean",
                            description:
                                "True if the change is semantically correct",
                        },
                        feedback: {
                            type: "string",
                            description:
                                "Specific issues found, or empty if accepted",
                        },
                    },
                    required: ["accepted", "feedback"],
                },
            },
        };
        const result = await this.callWithTool<{
            accepted: boolean;
            feedback: string;
        }>(messages, tool, "review change");
        return { accepted: result.accepted, feedback: result.feedback };
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
