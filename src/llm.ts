import type { Config } from "./config.ts";

export interface LLMClient {
    nameFunction(
        context: string,
        params: string[],
    ): Promise<string>;
}

export interface LLMOptions {
    apiKey?: string;
    fetchFn?: typeof fetch;
}

interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

interface ChatResponse {
    choices: Array<{
        message: { content: string };
    }>;
}

export class MoonshotClient implements LLMClient {
    private apiKey: string;
    private model: string;
    private fetchFn: typeof fetch;

    constructor(apiKey: string, model: string, fetchFn?: typeof fetch) {
        this.apiKey = apiKey;
        this.model = model;
        this.fetchFn = fetchFn ?? fetch;
    }

    async nameFunction(
        context: string,
        params: string[],
    ): Promise<string> {
        const messages: ChatMessage[] = [
            {
                role: "system",
                content:
                    "You are a code refactoring assistant. Given a code context and parameter names, suggest a concise function name in snake_case. Reply with ONLY the function name, no explanation.",
            },
            {
                role: "user",
                content: `Context:\n${context}\n\nParameters: ${
                    params.join(", ")
                }\n\nSuggest a function name:`,
            },
        ];

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
                    max_tokens: 50,
                }),
            },
        );

        const data: ChatResponse = await response.json();
        if (!response.ok) {
            throw new Error(
                `LLM API error ${response.status}: ${JSON.stringify(data)}`,
            );
        }
        const name = data?.choices?.[0]?.message?.content?.trim();
        if (!name) {
            throw new Error(
                `Unexpected LLM response: ${JSON.stringify(data)}`,
            );
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
    return new MoonshotClient(apiKey, config.model, options?.fetchFn);
}
