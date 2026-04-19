import { assert, assertEquals, assertRejects } from "@std/assert";
import { createLLMClient, MoonshotClient } from "../src/llm.ts";

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
