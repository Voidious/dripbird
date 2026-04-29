import { assert, assertEquals, assertRejects } from "@std/assert";
import { createLLMClient, LLMStats, MoonshotClient } from "../src/llm.ts";

function mockFetch(response: string): typeof fetch {
    return (() =>
        Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [
                        { message: { content: response } },
                    ],
                }),
            ),
        )) as unknown as typeof fetch;
}

function mockFetchWithUsage(
    response: string,
    promptTokens: number,
    completionTokens: number,
): typeof fetch {
    return (() =>
        Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: response } }],
                    usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens,
                    },
                }),
            ),
        )) as unknown as typeof fetch;
}

Deno.test("LLMStats tracks records and computes totals", () => {
    const stats = new LLMStats();
    stats.setFile("foo.ts");
    stats.add({ durationMs: 100, promptTokens: 50, completionTokens: 10 });
    stats.setFile("bar.ts");
    stats.add({ durationMs: 200, promptTokens: 100, completionTokens: 20 });

    assertEquals(stats.callCount, 2);
    assertEquals(stats.totalDurationMs, 300);
    assertEquals(stats.totalPromptTokens, 150);
    assertEquals(stats.totalCompletionTokens, 30);
});

Deno.test("LLMStats handles zero token counts", () => {
    const stats = new LLMStats();
    stats.setFile("a.ts");
    stats.add({ durationMs: 50, promptTokens: 0, completionTokens: 0 });

    assertEquals(stats.callCount, 1);
    assertEquals(stats.totalPromptTokens, 0);
    assertEquals(stats.totalCompletionTokens, 0);
});

Deno.test("LLMStats byFile aggregates per file", () => {
    const stats = new LLMStats();
    stats.setFile("a.ts");
    stats.add({ durationMs: 100, promptTokens: 50, completionTokens: 10 });
    stats.add({ durationMs: 50, promptTokens: 25, completionTokens: 5 });
    stats.setFile("b.ts");
    stats.add({ durationMs: 200, promptTokens: 100, completionTokens: 20 });

    const byFile = stats.byFile();
    assertEquals(byFile.size, 2);

    const a = byFile.get("a.ts")!;
    assertEquals(a.callCount, 2);
    assertEquals(a.durationMs, 150);
    assertEquals(a.promptTokens, 75);
    assertEquals(a.completionTokens, 15);

    const b = byFile.get("b.ts")!;
    assertEquals(b.callCount, 1);
    assertEquals(b.durationMs, 200);
});

Deno.test("LLMStats byFile uses unknown for null file", () => {
    const stats = new LLMStats();
    stats.setFile(null);
    stats.add({ durationMs: 100, promptTokens: 50, completionTokens: 10 });

    const byFile = stats.byFile();
    assertEquals(byFile.get("(unknown)")!.callCount, 1);
});

Deno.test("MoonshotClient with stats logs and records on success", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const client = new MoonshotClient(
            "key",
            "model",
            mockFetchWithUsage("helperFunc", 150, 10),
            stats,
        );
        const name = await client.nameFunction("code", ["x", "y"]);
        assertEquals(name, "helperFunc");

        assert(
            messages.some((m) =>
                m.includes("naming function") && m.includes("x, y")
            ),
        );
        assert(
            messages.some((m) =>
                m.includes("150 in") && m.includes("10 out") &&
                m.includes("helperFunc")
            ),
        );

        assertEquals(stats.callCount, 1);
        assertEquals(stats.totalPromptTokens, 150);
        assertEquals(stats.totalCompletionTokens, 10);
        assert(stats.totalDurationMs >= 0);
    } finally {
        console.error = orig;
    }
});

Deno.test("MoonshotClient with stats logs without usage", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const client = new MoonshotClient(
            "key",
            "model",
            mockFetch("simpleName"),
            stats,
        );
        const name = await client.nameFunction("code", ["a"]);
        assertEquals(name, "simpleName");

        assert(messages.some((m) => m.includes("naming function")));
        assert(messages.some((m) => m.includes("ms") && m.includes("simpleName")));
        assert(!messages.some((m) => m.includes(" in")));
        assert(!messages.some((m) => m.includes(" out")));

        assertEquals(stats.callCount, 1);
        assertEquals(stats.totalPromptTokens, 0);
        assertEquals(stats.totalCompletionTokens, 0);
    } finally {
        console.error = orig;
    }
});

Deno.test("MoonshotClient with stats logs on API error", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const fetchFn = (() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({ error: "bad" }),
                    { status: 401 },
                ),
            )) as unknown as typeof fetch;
        const client = new MoonshotClient("key", "model", fetchFn, stats);
        await assertRejects(
            () => client.nameFunction("code", ["x"]),
            Error,
            "LLM API error 401",
        );

        assert(messages.some((m) => m.includes("API error 401")));
        assertEquals(stats.callCount, 0);
    } finally {
        console.error = orig;
    }
});

Deno.test("MoonshotClient with stats logs on bad response", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const fetchFn = (() =>
            Promise.resolve(
                new Response(JSON.stringify({})),
            )) as unknown as typeof fetch;
        const client = new MoonshotClient("key", "model", fetchFn, stats);
        await assertRejects(
            () => client.nameFunction("code", ["x"]),
            Error,
            "Unexpected LLM response",
        );

        assert(messages.some((m) => m.includes("bad response")));
        assertEquals(stats.callCount, 0);
    } finally {
        console.error = orig;
    }
});

Deno.test("createLLMClient passes stats to client", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const config = {
            max_function_lines: 75,
            function_splitter_retries: 2,
            provider: "moonshot",
            model: "test-model",
            enabled_refactors: [],
            disabled_refactors: [],
        };
        const client = createLLMClient(config, {
            apiKey: "key",
            fetchFn: mockFetchWithUsage("testName", 100, 5),
            stats,
        });
        assert(client);
        await client.nameFunction("code", ["x"]);

        assert(messages.some((m) => m.includes("naming function")));
        assertEquals(stats.callCount, 1);
    } finally {
        console.error = orig;
    }
});

Deno.test("MoonshotClient nameFunction sends request and returns name", async () => {
    const client = new MoonshotClient(
        "test-key",
        "test-model",
        mockFetch("process_data"),
    );
    const name = await client.nameFunction("some code", ["x", "y"]);
    assertEquals(name, "process_data");
});

Deno.test("MoonshotClient trims whitespace from response", async () => {
    const client = new MoonshotClient(
        "test-key",
        "test-model",
        mockFetch("  handle_items  \n"),
    );
    const name = await client.nameFunction("code", ["items"]);
    assertEquals(name, "handle_items");
});

Deno.test("MoonshotClient sends correct API request", async () => {
    const captured: { req: Request | null } = { req: null };
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
        captured.req = new Request(input as URL, init);
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [
                        { message: { content: "helper" } },
                    ],
                }),
            ),
        );
    }) as unknown as typeof fetch;

    const client = new MoonshotClient("my-key", "my-model", fetchFn);
    await client.nameFunction("ctx", ["a"]);

    assert(captured.req);
    assertEquals(
        captured.req.headers.get("Authorization"),
        "Bearer my-key",
    );
    assertEquals(
        captured.req.headers.get("Content-Type"),
        "application/json",
    );

    const body = await captured.req.json();
    assertEquals(body.model, "my-model");
    assertEquals(body.messages.length, 2);
    assertEquals(body.messages[0].role, "system");
    assertEquals(body.messages[1].role, "user");
    assert(body.messages[1].content.includes("ctx"));
    assert(body.messages[1].content.includes("a"));
});

Deno.test("createLLMClient returns null without API key", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        const original = Deno.env.get("MOONSHOT_API_KEY");
        Deno.env.delete("MOONSHOT_API_KEY");
        const config = {
            max_function_lines: 75,
            function_splitter_retries: 2,
            provider: "moonshot",
            model: "kimi-k2.5",
            enabled_refactors: [],
            disabled_refactors: [],
        };
        const client = createLLMClient(config);
        assertEquals(client, null);
        if (original) Deno.env.set("MOONSHOT_API_KEY", original);
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("createLLMClient uses env var API key", () => {
    const original = Deno.env.get("MOONSHOT_API_KEY");
    Deno.env.set("MOONSHOT_API_KEY", "env-key");
    try {
        const config = {
            max_function_lines: 75,
            function_splitter_retries: 2,
            provider: "moonshot",
            model: "kimi-k2.5",
            enabled_refactors: [],
            disabled_refactors: [],
        };
        const client = createLLMClient(config);
        assert(client instanceof MoonshotClient);
    } finally {
        if (original) {
            Deno.env.set("MOONSHOT_API_KEY", original);
        } else {
            Deno.env.delete("MOONSHOT_API_KEY");
        }
    }
});

Deno.test("createLLMClient uses options API key over env", () => {
    const original = Deno.env.get("MOONSHOT_API_KEY");
    Deno.env.set("MOONSHOT_API_KEY", "env-key");
    try {
        const config = {
            max_function_lines: 75,
            function_splitter_retries: 2,
            provider: "moonshot",
            model: "kimi-k2.5",
            enabled_refactors: [],
            disabled_refactors: [],
        };
        const client = createLLMClient(config, {
            apiKey: "options-key",
        });
        assert(client instanceof MoonshotClient);
    } finally {
        if (original) {
            Deno.env.set("MOONSHOT_API_KEY", original);
        } else {
            Deno.env.delete("MOONSHOT_API_KEY");
        }
    }
});

Deno.test("createLLMClient passes custom fetchFn", async () => {
    const config = {
        max_function_lines: 75,
        function_splitter_retries: 2,
        provider: "moonshot",
        model: "test-model",
        enabled_refactors: [],
        disabled_refactors: [],
    };
    const client = createLLMClient(config, {
        apiKey: "key",
        fetchFn: mockFetch("custom_name"),
    });
    assert(client);
    const name = await client.nameFunction("code", ["x"]);
    assertEquals(name, "custom_name");
});

Deno.test("MoonshotClient throws on non-ok response", async () => {
    const fetchFn = (() =>
        Promise.resolve(
            new Response(
                JSON.stringify({ error: "unauthorized" }),
                { status: 401 },
            ),
        )) as unknown as typeof fetch;
    const client = new MoonshotClient("bad-key", "test-model", fetchFn);
    await assertRejects(
        () => client.nameFunction("code", ["x"]),
        Error,
        "LLM API error 401",
    );
});

Deno.test("MoonshotClient throws on unexpected response shape", async () => {
    const fetchFn = (() =>
        Promise.resolve(
            new Response(JSON.stringify({})),
        )) as unknown as typeof fetch;
    const client = new MoonshotClient("key", "test-model", fetchFn);
    await assertRejects(
        () => client.nameFunction("code", ["x"]),
        Error,
        "Unexpected LLM response",
    );
});

Deno.test("MoonshotClient includes forbidden names in prompt", async () => {
    const captured: { req: Request | null } = { req: null };
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
        captured.req = new Request(input as URL, init);
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [
                        { message: { content: "goodName" } },
                    ],
                }),
            ),
        );
    }) as unknown as typeof fetch;

    const client = new MoonshotClient("key", "test-model", fetchFn);
    await client.nameFunction("ctx", ["a"], ["forbidden1", "forbidden2"]);

    const body = await captured.req!.json();
    assert(body.messages[1].content.includes("Forbidden names"));
    assert(body.messages[1].content.includes("forbidden1"));
    assert(body.messages[1].content.includes("forbidden2"));
});

Deno.test("MoonshotClient omits forbidden names when not provided", async () => {
    const captured: { req: Request | null } = { req: null };
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
        captured.req = new Request(input as URL, init);
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [
                        { message: { content: "goodName" } },
                    ],
                }),
            ),
        );
    }) as unknown as typeof fetch;

    const client = new MoonshotClient("key", "test-model", fetchFn);
    await client.nameFunction("ctx", ["a"]);

    const body = await captured.req!.json();
    assert(!body.messages[1].content.includes("Forbidden names"));
});

function mockToolFetch(
    toolName: string,
    toolArgs: Record<string, unknown>,
    promptTokens = 10,
    completionTokens = 5,
): typeof fetch {
    return (() => {
        const args = JSON.stringify(toolArgs);
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [{
                        message: {
                            content: null,
                            tool_calls: [{
                                function: { name: toolName, arguments: args },
                            }],
                        },
                    }],
                    usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens,
                    },
                }),
            ),
        );
    }) as unknown as typeof fetch;
}

Deno.test("MoonshotClient verifyFunctionMatch returns match result", async () => {
    const client = new MoonshotClient(
        "key",
        "model",
        mockToolFetch("evaluate_match", {
            is_match: true,
            reason: "same logic",
        }),
    );
    const result = await client.verifyFunctionMatch(
        "const x = foo();",
        "function bar() { return foo(); }",
        "full source",
    );
    assertEquals(result.isMatch, true);
    assertEquals(result.reason, "same logic");
});

Deno.test("MoonshotClient verifyFunctionMatch returns no match", async () => {
    const client = new MoonshotClient(
        "key",
        "model",
        mockToolFetch("evaluate_match", {
            is_match: false,
            reason: "different ops",
        }),
    );
    const result = await client.verifyFunctionMatch(
        "const x = 1;",
        "function bar() { return 2; }",
        "source",
    );
    assertEquals(result.isMatch, false);
});

Deno.test("MoonshotClient generateCallReplacement returns replacement", async () => {
    const client = new MoonshotClient(
        "key",
        "model",
        mockToolFetch("generate_call", {
            replacement: "    sendGreeting(conn);\n",
        }),
    );
    const result = await client.generateCallReplacement(
        "conn.send('hi');",
        "sendGreeting",
        "function sendGreeting(c) { c.send('hi'); }",
        "source",
    );
    assertEquals(result, "    sendGreeting(conn);\n");
});

Deno.test("MoonshotClient reviewChange accepts", async () => {
    const client = new MoonshotClient(
        "key",
        "model",
        mockToolFetch("review", { accepted: true, feedback: "" }),
    );
    const result = await client.reviewChange(
        "original",
        "proposed",
        "test change",
    );
    assertEquals(result.accepted, true);
    assertEquals(result.feedback, "");
});

Deno.test("MoonshotClient reviewChange rejects with feedback", async () => {
    const client = new MoonshotClient(
        "key",
        "model",
        mockToolFetch("review", {
            accepted: false,
            feedback: "wrong indentation",
        }),
    );
    const result = await client.reviewChange(
        "original",
        "proposed",
        "test change",
    );
    assertEquals(result.accepted, false);
    assertEquals(result.feedback, "wrong indentation");
});

Deno.test("MoonshotClient callWithTool throws on API error", async () => {
    const fetchFn = (() =>
        Promise.resolve(
            new Response(JSON.stringify({ error: "bad" }), { status: 429 }),
        )) as unknown as typeof fetch;
    const client = new MoonshotClient("key", "model", fetchFn);
    await assertRejects(
        () => client.verifyFunctionMatch("code", "func", "file"),
        Error,
        "LLM API error 429",
    );
});

Deno.test("MoonshotClient callWithTool throws on missing tool call", async () => {
    const fetchFn = (() =>
        Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "no tool", tool_calls: [] } }],
                }),
            ),
        )) as unknown as typeof fetch;
    const client = new MoonshotClient("key", "model", fetchFn);
    await assertRejects(
        () => client.verifyFunctionMatch("code", "func", "file"),
        Error,
        "Unexpected LLM response",
    );
});

Deno.test("MoonshotClient callWithTool logs API error with stats", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const fetchFn = (() =>
        Promise.resolve(
            new Response(JSON.stringify({ error: "bad" }), { status: 429 }),
        )) as unknown as typeof fetch;
    const client = new MoonshotClient(
        "key",
        "model",
        fetchFn,
        stats,
        (...args: unknown[]) => messages.push(args.join(" ")),
    );
    await assertRejects(
        () => client.verifyFunctionMatch("code", "func", "file"),
        Error,
        "LLM API error 429",
    );
    assert(messages.some((m) => m.includes("API error 429")));
});

Deno.test("MoonshotClient callWithTool logs missing tool call with stats", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const fetchFn = (() =>
        Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: "no tool", tool_calls: [] } }],
                }),
            ),
        )) as unknown as typeof fetch;
    const client = new MoonshotClient(
        "key",
        "model",
        fetchFn,
        stats,
        (...args: unknown[]) => messages.push(args.join(" ")),
    );
    await assertRejects(
        () => client.verifyFunctionMatch("code", "func", "file"),
        Error,
        "Unexpected LLM response",
    );
    assert(messages.some((m) => m.includes("no tool response")));
});

Deno.test("MoonshotClient callWithTool with stats logs and records", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));
    try {
        const client = new MoonshotClient(
            "key",
            "model",
            mockToolFetch("evaluate_match", { is_match: true, reason: "" }, 50, 20),
            stats,
            (...args: unknown[]) => messages.push(args.join(" ")),
        );
        const result = await client.verifyFunctionMatch(
            "code",
            "func",
            "file",
        );
        assertEquals(result.isMatch, true);
        assertEquals(stats.callCount, 1);
        assertEquals(stats.totalPromptTokens, 50);
        assertEquals(stats.totalCompletionTokens, 20);
        assert(messages.some((m) => m.includes("verify function match")));
    } finally {
        console.error = orig;
    }
});

Deno.test("MoonshotClient callWithTool handles missing usage in response", async () => {
    const stats = new LLMStats();
    const messages: string[] = [];
    const fetchFn = (() =>
        Promise.resolve(
            new Response(
                JSON.stringify({
                    choices: [{
                        message: {
                            content: null,
                            tool_calls: [{
                                function: {
                                    name: "evaluate_match",
                                    arguments: JSON.stringify({
                                        is_match: true,
                                        reason: "",
                                    }),
                                },
                            }],
                        },
                    }],
                }),
            ),
        )) as unknown as typeof fetch;
    const client = new MoonshotClient(
        "key",
        "model",
        fetchFn,
        stats,
        (...args: unknown[]) => messages.push(args.join(" ")),
    );
    const result = await client.verifyFunctionMatch("code", "func", "file");
    assertEquals(result.isMatch, true);
    assertEquals(stats.callCount, 1);
    assertEquals(stats.totalPromptTokens, 0);
    assertEquals(stats.totalCompletionTokens, 0);
});

Deno.test("MoonshotClient verifyFunctionMatch truncates long file source", async () => {
    const stats = new LLMStats();
    const fetchFn = mockToolFetch("evaluate_match", {
        is_match: false,
        reason: "",
    });
    const client = new MoonshotClient("key", "model", fetchFn, stats);
    const longSource = "x".repeat(5000);
    const result = await client.verifyFunctionMatch("code", "func", longSource);
    assertEquals(result.isMatch, false);
});

Deno.test("MoonshotClient generateCallReplacement truncates long file source", async () => {
    const stats = new LLMStats();
    const fetchFn = mockToolFetch("generate_call", { replacement: "foo()" });
    const client = new MoonshotClient("key", "model", fetchFn, stats);
    const longSource = "x".repeat(5000);
    const result = await client.generateCallReplacement(
        "code",
        "foo",
        "func",
        longSource,
    );
    assertEquals(result, "foo()");
});
