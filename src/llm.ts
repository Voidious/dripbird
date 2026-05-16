import type { Config } from "./config.ts";

export interface FunctionMatchResult {
    isMatch: boolean;
    reason: string;
}

export interface ReviewResult {
    accepted: boolean;
    feedback: string;
}

export interface DuplicateVerifyResult {
    isMatch: boolean;
    excludeIndices: number[];
    reason: string;
}

export interface ExtractionResult {
    helperName: string;
    helperFunction: string;
    callSites: string[];
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
        previousFeedback?: string,
    ): Promise<string>;

    reviewChange(
        originalSource: string,
        proposedSource: string,
        description: string,
    ): Promise<ReviewResult>;

    verifyDuplicateMatch(
        codeBlocks: string[],
        fileSource: string,
    ): Promise<DuplicateVerifyResult>;

    generateExtraction(
        codeBlocks: string[],
        fileSource: string,
        forbiddenNames: string[],
        previousFeedback?: string,
    ): Promise<ExtractionResult>;
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
        finish_reason?: string;
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
        maxRetries = 2,
    ): Promise<T> {
        if (this.stats) {
            this.logFn(`dripbird: llm: ${logLabel}...`);
        }

        const start = performance.now();
        let attempt = 0;

        while (true) {
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

            if (!response.ok) {
                const durationMs = performance.now() - start;
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
                const durationMs = performance.now() - start;
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

            const choice = data.choices[0];
            const finishReason = choice.finish_reason ?? "unknown";
            try {
                const result = JSON.parse(
                    toolCall.function.arguments,
                ) as T;

                const durationMs = performance.now() - start;
                if (this.stats) {
                    const promptTokens = data.usage?.prompt_tokens ?? 0;
                    const completionTokens = data.usage?.completion_tokens ?? 0;
                    this.logFn(
                        `dripbird: llm: ${
                            Math.round(durationMs)
                        }ms, ${promptTokens} in, ${completionTokens} out → ${logLabel}`,
                    );
                    this.stats.add({
                        durationMs,
                        promptTokens,
                        completionTokens,
                    });
                }

                return result;
            } catch (parseErr) {
                attempt++;
                if (attempt <= maxRetries) {
                    this.logFn(
                        `dripbird: llm: JSON parse failed on attempt ${attempt}/${
                            maxRetries + 1
                        } for ${logLabel} (finish_reason=${finishReason}, args length=${toolCall.function.arguments.length}), retrying...`,
                    );
                    this.logFn(
                        `dripbird: llm: raw arguments: ${
                            toolCall.function.arguments.slice(0, 500)
                        }`,
                    );
                    continue;
                }
                this.logFn(
                    `dripbird: llm: JSON parse failed after ${attempt} attempts for ${logLabel} (finish_reason=${finishReason}, args length=${toolCall.function.arguments.length})`,
                );
                this.logFn(
                    `dripbird: llm: raw arguments: ${toolCall.function.arguments}`,
                );
                throw new Error(
                    `Failed to parse LLM tool arguments after ${attempt} attempts (finish_reason=${finishReason}): ${
                        (parseErr as Error).message
                    }`,
                );
            }
        }
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
        previousFeedback?: string,
    ): Promise<string> {
        const snippet = fileSource.length > 4000
            ? fileSource.slice(0, 4000)
            : fileSource;
        const feedbackSection = previousFeedback
            ? `\n\nIMPORTANT: A previous attempt was rejected with this feedback. Fix the issue:\n${previousFeedback}`
            : "";
        const messages: ChatMessage[] = [
            {
                role: "user",
                content:
                    `Replace this code block with a call to the existing function '${funcName}'.\n\n` +
                    `Code block:\n\`\`\`typescript\n${codeBlock.trim()}\n\`\`\`\n\n` +
                    `Function '${funcName}':\n\`\`\`typescript\n${funcSource.trim()}\n\`\`\`\n\n` +
                    `File source (for context only):\n\`\`\`typescript\n${snippet}\n\`\`\`\n\n` +
                    `Output ONLY the replacement lines that will replace the code block. Do NOT output the full file, surrounding code, or any lines outside the code block. The replacement must preserve the original indentation of the code block. Pass the replacement to the generate_call tool.${feedbackSection}`,
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
                    `Original file:\n\`\`\`typescript\n${originalSource.trim()}\n\`\`\`\n\n` +
                    `Modified file:\n\`\`\`typescript\n${proposedSource.trim()}\n\`\`\`\n\n` +
                    `Both are complete files. Only the lines described in the description should differ between them. Check each of the following:\n` +
                    `1. Every variable read in the changed lines that is not locally assigned is passed as a parameter or available in scope\n` +
                    `2. Every variable assigned in the changed lines and used afterward is still defined\n` +
                    `3. No parameter is assigned before it is first read in the called function\n` +
                    `4. If the changed lines originally ended with a return, the replacement also propagates that return value\n` +
                    `5. Only the lines described in the description were modified — all other lines must be identical between the two files\n` +
                    `6. The replacement preserves the original indentation of the changed lines\n` +
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

    async verifyDuplicateMatch(
        codeBlocks: string[],
        fileSource: string,
    ): Promise<DuplicateVerifyResult> {
        const snippet = fileSource.length > 4000
            ? fileSource.slice(0, 4000)
            : fileSource;
        const blocksText = codeBlocks
            .map((block, i) =>
                `Block ${i + 1}:\n\`\`\`typescript\n${block.trim()}\n\`\`\``
            )
            .join("\n\n");
        const messages: ChatMessage[] = [
            {
                role: "user",
                content:
                    `Several code blocks in a TypeScript/JavaScript file may perform the same operation.\n\n` +
                    `${blocksText}\n\n` +
                    `File source (for context):\n\`\`\`typescript\n${snippet}\n\`\`\`\n\n` +
                    `Do these code blocks perform the same semantic operation, such that they could all be replaced by calls to a single helper function? ` +
                    `If most match but some don't, exclude the non-matching ones. Use the evaluate_duplicates tool.`,
            },
        ];
        const tool: ToolDefinition = {
            type: "function",
            function: {
                name: "evaluate_duplicates",
                description:
                    "Evaluate whether code blocks are semantically equivalent and identify any to exclude",
                parameters: {
                    type: "object",
                    properties: {
                        is_match: {
                            type: "boolean",
                            description:
                                "True if the code blocks perform the same semantic operation",
                        },
                        exclude_indices: {
                            type: "array",
                            items: { type: "integer" },
                            description:
                                "0-based indices of blocks to exclude from extraction",
                        },
                        reason: {
                            type: "string",
                            description: "Explanation of the evaluation",
                        },
                    },
                    required: [
                        "is_match",
                        "exclude_indices",
                        "reason",
                    ],
                },
            },
        };
        const result = await this.callWithTool<{
            is_match: boolean;
            exclude_indices: number[];
            reason: string;
        }>(messages, tool, "verify duplicate match");
        return {
            isMatch: result.is_match,
            excludeIndices: result.exclude_indices ?? [],
            reason: result.reason,
        };
    }

    async generateExtraction(
        codeBlocks: string[],
        fileSource: string,
        forbiddenNames: string[],
        previousFeedback?: string,
    ): Promise<ExtractionResult> {
        const snippet = fileSource.length > 4000
            ? fileSource.slice(0, 4000)
            : fileSource;
        const feedbackSection = previousFeedback
            ? `\n\nIMPORTANT: A previous attempt was rejected with this feedback. Fix the issue:\n${previousFeedback}`
            : "";
        const blocksText = codeBlocks
            .map((block, i) =>
                `Block ${i + 1}:\n\`\`\`typescript\n${block.trim()}\n\`\`\``
            )
            .join("\n\n");
        const forbiddenSection = forbiddenNames.length
            ? `\n\nForbidden names (do NOT use these): ${forbiddenNames.join(", ")}`
            : "";
        const messages: ChatMessage[] = [
            {
                role: "user",
                content:
                    `Extract a common helper function from these duplicate code blocks.\n\n` +
                    `${blocksText}\n\n` +
                    `File source (for context):\n\`\`\`typescript\n${snippet}\n\`\`\`\n\n` +
                    `Requirements:\n` +
                    `- Generate a top-level function declaration (not arrow function)\n` +
                    `- Choose a descriptive camelCase name\n` +
                    `- Pass all necessary values as parameters\n` +
                    `- If a code block ends with a return, the call site must also return\n` +
                    `- Preserve the original indentation of each call site\n` +
                    `- Output exactly ${codeBlocks.length} call sites, one per block${forbiddenSection}${feedbackSection}\n\n` +
                    `Use the generate_extraction tool.`,
            },
        ];
        const tool: ToolDefinition = {
            type: "function",
            function: {
                name: "generate_extraction",
                description:
                    "Generate a helper function and call sites for duplicate code blocks",
                parameters: {
                    type: "object",
                    properties: {
                        helper_name: {
                            type: "string",
                            description:
                                "camelCase name for the new helper function",
                        },
                        helper_function: {
                            type: "string",
                            description:
                                "Complete source of the helper function declaration",
                        },
                        call_sites: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Replacement code for each block, preserving indentation",
                        },
                    },
                    required: [
                        "helper_name",
                        "helper_function",
                        "call_sites",
                    ],
                },
            },
        };
        const result = await this.callWithTool<{
            helper_name: string;
            helper_function: string;
            call_sites: string[];
        }>(messages, tool, "generate extraction");
        return {
            helperName: result.helper_name,
            helperFunction: result.helper_function,
            callSites: result.call_sites,
        };
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
