import { assert, assertEquals, assertRejects } from "@std/assert";
import { formatDuration, readStream, run, runInDir } from "../src/main.ts";
import { createLLMClient, LLMStats, MoonshotClient } from "../src/llm.ts";

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

function makeStream(data: string): ReadableStream<Uint8Array> {
    const encoded = new TextEncoder().encode(data);
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoded);
            controller.close();
        },
    });
}

function makeMultiChunkStream(
    ...parts: string[]
): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(new TextEncoder().encode(part));
            }
            controller.close();
        },
    });
}

Deno.test("readStream reads a single chunk", async () => {
    const result = await readStream(makeStream("hello world"));
    assertEquals(result, "hello world");
});

Deno.test("readStream reads empty stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.close();
        },
    });
    const result = await readStream(stream);
    assertEquals(result, "");
});

Deno.test("readStream concatenates multiple chunks", async () => {
    const result = await readStream(
        makeMultiChunkStream("hel", "lo ", "world"),
    );
    assertEquals(result, "hello world");
});

Deno.test("run returns 0 for empty string", async () => {
    assertEquals(await run(""), 0);
});

Deno.test("run returns 0 for whitespace-only input", async () => {
    assertEquals(await run("   \n\t\n  "), 0);
});

Deno.test("run returns 0 for diff with no parseable hunks", async () => {
    assertEquals(await run("some text\nno diff here"), 0);
});

Deno.test(
    "runInDir applies refactors and returns 1",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        await Deno.writeTextFile(
            filePath,
            "if (!a) {\n    b();\n} else {\n    c();\n}\n",
        );

        const diff = [
            "--- a/test.ts",
            "+++ b/test.ts",
            "@@ -1,5 +1,5 @@",
            " if (!a) {",
        ].join("\n");

        const exitCode = await runInDir(diff, tempDir);
        assertEquals(exitCode, 1);

        const modified = await Deno.readTextFile(filePath);
        assert(modified.includes("if (a)"));
        assert(!modified.includes("if (!a)"));

        await Deno.remove(tempDir, { recursive: true });
    },
);

Deno.test(
    "runInDir returns 0 when no refactors apply",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        const original = "const x = 1;\nconsole.log(x);\n";
        await Deno.writeTextFile(filePath, original);

        const diff = [
            "--- a/test.ts",
            "+++ b/test.ts",
            "@@ -1,2 +1,2 @@",
            " const x = 1;",
        ].join("\n");

        const exitCode = await runInDir(diff, tempDir);
        assertEquals(exitCode, 0);

        const content = await Deno.readTextFile(filePath);
        assertEquals(content, original);

        await Deno.remove(tempDir, { recursive: true });
    },
);

Deno.test(
    "runInDir skips files that cannot be read",
    async () => {
        const tempDir = await Deno.makeTempDir();

        const messages: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        try {
            const diff = [
                "--- a/missing.ts",
                "+++ b/missing.ts",
                "@@ -1,3 +1,3 @@",
                " x",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir);
            assertEquals(exitCode, 0);
            assert(
                messages.some((m) => m.includes("skipping")),
            );
        } finally {
            console.error = original;
        }

        await Deno.remove(tempDir, { recursive: true });
    },
);

Deno.test(
    "runInDir processes multiple files",
    async () => {
        const tempDir = await Deno.makeTempDir();

        const messages: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        try {
            await Deno.writeTextFile(
                `${tempDir}/alpha.ts`,
                "if (!a) {\n    b();\n} else {\n    c();\n}\n",
            );
            await Deno.writeTextFile(
                `${tempDir}/beta.ts`,
                "const x = 1;\n",
            );

            const diff = [
                "--- a/alpha.ts",
                "+++ b/alpha.ts",
                "@@ -1,5 +1,5 @@",
                " if (!a) {",
                "--- b/beta.ts",
                "+++ b/beta.ts",
                "@@ -1,1 +1,1 @@",
                " const x",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir);
            assertEquals(exitCode, 1);

            const alpha = await Deno.readTextFile(
                `${tempDir}/alpha.ts`,
            );
            assert(alpha.includes("if (a)"));

            const beta = await Deno.readTextFile(
                `${tempDir}/beta.ts`,
            );
            assertEquals(beta, "const x = 1;\n");

            assert(
                messages.some((m) =>
                    m.includes("alpha.ts") &&
                    m.includes("inverted")
                ),
            );
            assert(
                messages.some((m) =>
                    m.includes("provider:") && m.includes("moonshot")
                ),
            );
            assert(
                messages.some((m) =>
                    m.includes("model:") && m.includes("kimi-k2.5")
                ),
            );
            assert(
                messages.some((m) =>
                    m.includes("max_function_lines:") && m.includes("75")
                ),
            );
            assert(
                messages.some((m) =>
                    m.includes("function_splitter_retries:") &&
                    m.includes("2")
                ),
            );
        } finally {
            console.error = original;
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir logs LLM activity directly after config is printed",
    async () => {
        const tempDir = await Deno.makeTempDir();

        await Deno.writeTextFile(
            `${tempDir}/alpha.ts`,
            "if (!a) {\n    b();\n} else {\n    c();\n}\n",
        );

        const bodyLines = Array(40).fill(null).map((_, i) =>
            `    const v${i} = ${i};`
        );
        const betaSource = [
            "function longFunc(x: number) {",
            ...bodyLines,
            "}",
        ].join("\n") + "\n";
        await Deno.writeTextFile(`${tempDir}/beta.ts`, betaSource);

        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "max_function_lines: 20\n",
        );

        const messages: string[] = [];
        const orig = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        try {
            const diff = [
                "--- a/alpha.ts",
                "+++ b/alpha.ts",
                "@@ -1,5 +1,5 @@",
                " if (!a) {",
                "--- b/beta.ts",
                "+++ b/beta.ts",
                "@@ -1,42 +1,42 @@",
                " function longFunc",
            ].join("\n");

            let callIdx = 0;
            const names = ["helperA", "helperB", "helperC"];
            const fetchFn = (() => {
                const name = names[callIdx % names.length];
                callIdx++;
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            choices: [{ message: { content: name } }],
                            usage: {
                                prompt_tokens: 100,
                                completion_tokens: 5,
                                total_tokens: 105,
                            },
                        }),
                    ),
                );
            }) as unknown as typeof fetch;

            const exitCode = await runInDir(diff, tempDir, {
                apiKey: "test-key",
                fetchFn,
            });

            assertEquals(exitCode, 1);

            const configIdx = messages.findIndex((m) => m.includes("provider:"));
            const llmIdx = messages.findIndex((m) =>
                m.includes("llm: naming function")
            );
            assert(configIdx >= 0);
            assert(llmIdx >= 0);
            assert(configIdx < llmIdx);

            assert(
                messages.some((m) =>
                    m.includes("alpha.ts") && m.includes("inverted")
                ),
            );
            assert(
                messages.some((m) =>
                    m.includes("beta.ts") && m.includes("split function")
                ),
            );
        } finally {
            console.error = orig;
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir works without LLM (no API key)",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        await Deno.writeTextFile(
            filePath,
            "if (!a) {\n    b();\n} else {\n    c();\n}\n",
        );

        const original = Deno.env.get("MOONSHOT_API_KEY");
        Deno.env.delete("MOONSHOT_API_KEY");
        try {
            const diff = [
                "--- a/test.ts",
                "+++ b/test.ts",
                "@@ -1,5 +1,5 @@",
                " if (!a) {",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir);
            assertEquals(exitCode, 1);

            const modified = await Deno.readTextFile(filePath);
            assert(modified.includes("if (a)"));
        } finally {
            if (original) Deno.env.set("MOONSHOT_API_KEY", original);
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir respects enabled_refactors to skip a refactor",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        const original = "if (!a) {\n    b();\n} else {\n    c();\n}\n";
        await Deno.writeTextFile(filePath, original);

        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "enabled_refactors: []\ndisabled_refactors:\n  - if_not_else\n",
        );

        const originalEnv = Deno.env.get("MOONSHOT_API_KEY");
        Deno.env.delete("MOONSHOT_API_KEY");
        try {
            const diff = [
                "--- a/test.ts",
                "+++ b/test.ts",
                "@@ -1,5 +1,5 @@",
                " if (!a) {",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir);
            assertEquals(exitCode, 0);

            const content = await Deno.readTextFile(filePath);
            assertEquals(content, original);
        } finally {
            if (originalEnv) Deno.env.set("MOONSHOT_API_KEY", original);
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir does not print config summary when no changes are made",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        const original = "const x = 1;\nconsole.log(x);\n";
        await Deno.writeTextFile(filePath, original);

        const messages: string[] = [];
        const orig = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        try {
            const diff = [
                "--- a/test.ts",
                "+++ b/test.ts",
                "@@ -1,2 +1,2 @@",
                " const x = 1;",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir);
            assertEquals(exitCode, 0);
            assertEquals(messages.length, 0);
        } finally {
            console.error = orig;
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir config summary reflects dripbird.yml values",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        await Deno.writeTextFile(
            filePath,
            "if (!a) {\n    b();\n} else {\n    c();\n}\n",
        );

        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "max_function_lines: 30\nprovider: openai\nmodel: gpt-4\nfunction_splitter_retries: 5\n",
        );

        const messages: string[] = [];
        const orig = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        const originalEnv = Deno.env.get("MOONSHOT_API_KEY");
        Deno.env.delete("MOONSHOT_API_KEY");
        try {
            const diff = [
                "--- a/test.ts",
                "+++ b/test.ts",
                "@@ -1,5 +1,5 @@",
                " if (!a) {",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir);
            assertEquals(exitCode, 1);

            const providerLine = messages.find((m) => m.includes("provider:"));
            assert(providerLine);
            assert(providerLine.includes("openai"));
            assert(
                messages.some((m) => m.includes("model:") && m.includes("gpt-4")),
            );
            assert(
                messages.some((m) =>
                    m.includes("max_function_lines:") && m.includes("30")
                ),
            );
            assert(
                messages.some((m) =>
                    m.includes("function_splitter_retries:") &&
                    m.includes("5")
                ),
            );
        } finally {
            console.error = orig;
            if (originalEnv) Deno.env.set("MOONSHOT_API_KEY", originalEnv);
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir verbose mode prints config and summary even with no changes",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        const original = "const x = 1;\nconsole.log(x);\n";
        await Deno.writeTextFile(filePath, original);

        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "verbose: true\n",
        );

        const messages: string[] = [];
        const orig = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        const originalEnv = Deno.env.get("MOONSHOT_API_KEY");
        Deno.env.delete("MOONSHOT_API_KEY");
        try {
            const diff = [
                "--- a/test.ts",
                "+++ b/test.ts",
                "@@ -1,2 +1,2 @@",
                " const x = 1;",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir);
            assertEquals(exitCode, 0);
            assert(messages.some((m) => m.includes("provider:")));
            assert(messages.some((m) => m.includes("test.ts: no changes")));
            assert(messages.some((m) => m.includes("summary:")));
        } finally {
            console.error = orig;
            if (originalEnv) Deno.env.set("MOONSHOT_API_KEY", originalEnv);
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir verbose mode passes log to refactors",
    async () => {
        const tempDir = await Deno.makeTempDir();
        const filePath = `${tempDir}/test.ts`;
        const original = [
            "function greet(name) {",
            '    return "Hello, " + name;',
            "}",
            "",
            "function run() {",
            '    const a = "Hello, " + x;',
            "}",
        ].join("\n") + "\n";
        await Deno.writeTextFile(filePath, original);

        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "verbose: true\nenabled_refactors: ['function_matcher']\n",
        );

        const messages: string[] = [];
        const orig = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        const toolResponse = JSON.stringify({
            choices: [{
                message: {
                    content: null,
                    tool_calls: [{
                        function: {
                            name: "evaluate_match",
                            arguments: '{"is_match":false,"reason":"test reject"}',
                        },
                    }],
                },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });

        const fetchFn = (() =>
            Promise.resolve(
                new Response(toolResponse),
            )) as unknown as typeof fetch;

        try {
            const diff = [
                "--- a/test.ts",
                "+++ b/test.ts",
                "@@ -5,3 +5,3 @@",
                " function run()",
            ].join("\n");

            const exitCode = await runInDir(diff, tempDir, {
                apiKey: "test-key",
                fetchFn,
            });
            assertEquals(exitCode, 0);
            assert(
                messages.some((m) =>
                    m.includes("function_matcher:") && m.includes("found")
                ),
            );
            assert(
                messages.some((m) => m.includes("LLM rejected match")),
            );
        } finally {
            console.error = orig;
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test("formatDuration formats milliseconds and seconds", () => {
    assertEquals(formatDuration(0), "0ms");
    assertEquals(formatDuration(500), "500ms");
    assertEquals(formatDuration(999), "999ms");
    assertEquals(formatDuration(1000), "1.0s");
    assertEquals(formatDuration(1500), "1.5s");
    assertEquals(formatDuration(12345), "12.3s");
});

Deno.test(
    "runInDir prints summary with LLM stats and per-file breakdown",
    async () => {
        const tempDir = await Deno.makeTempDir();

        const bodyLines = Array(40).fill(null).map((_, i) =>
            `    const v${i} = ${i};`
        );
        const source = [
            "function longFunc(x: number) {",
            ...bodyLines,
            "}",
        ].join("\n") + "\n";
        await Deno.writeTextFile(`${tempDir}/code.ts`, source);

        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "max_function_lines: 20\n",
        );

        const messages: string[] = [];
        const orig = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        try {
            const diff = [
                "--- a/code.ts",
                "+++ b/code.ts",
                "@@ -1,42 +1,42 @@",
                " function longFunc",
            ].join("\n");

            let callIdx = 0;
            const names = ["helperA", "helperB", "helperC"];
            const fetchFn = (() => {
                const name = names[callIdx % names.length];
                callIdx++;
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            choices: [{ message: { content: name } }],
                            usage: {
                                prompt_tokens: 100,
                                completion_tokens: 5,
                                total_tokens: 105,
                            },
                        }),
                    ),
                );
            }) as unknown as typeof fetch;

            const exitCode = await runInDir(diff, tempDir, {
                apiKey: "test-key",
                fetchFn,
            });

            assertEquals(exitCode, 1);

            assert(messages.some((m) => m.includes("naming function")));
            assert(messages.some((m) => m.includes("100 in")));
            assert(messages.some((m) => m.includes("summary:")));
            assert(messages.some((m) => m.includes("by refactor:")));
            assert(messages.some((m) => m.includes("function_splitter")));
            assert(messages.some((m) => m.includes("by file:")));
            assert(
                messages.some((m) =>
                    m.includes("code.ts") && m.includes("llm call")
                ),
            );

            const modified = await Deno.readTextFile(`${tempDir}/code.ts`);
            assert(modified.includes("helperA"));
        } finally {
            console.error = orig;
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test(
    "runInDir summary shows singular llm call with one split",
    async () => {
        const tempDir = await Deno.makeTempDir();

        const bodyLines = Array(25).fill(null).map((_, i) =>
            `    const v${i} = ${i};`
        );
        const source = [
            "function medFunc(x: number) {",
            ...bodyLines,
            "}",
        ].join("\n") + "\n";
        await Deno.writeTextFile(`${tempDir}/code.ts`, source);

        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "max_function_lines: 20\n",
        );

        const messages: string[] = [];
        const orig = console.error;
        console.error = (...args: unknown[]) => messages.push(args.join(" "));

        try {
            const diff = [
                "--- a/code.ts",
                "+++ b/code.ts",
                "@@ -1,27 +1,27 @@",
                " function medFunc",
            ].join("\n");

            const fetchFn = (() =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            choices: [{ message: { content: "helperOne" } }],
                            usage: {
                                prompt_tokens: 80,
                                completion_tokens: 5,
                                total_tokens: 85,
                            },
                        }),
                    ),
                )) as unknown as typeof fetch;

            const exitCode = await runInDir(diff, tempDir, {
                apiKey: "test-key",
                fetchFn,
            });

            assertEquals(exitCode, 1);
            assert(
                messages.some((m) =>
                    m.includes("code.ts") && m.includes("1 llm call,")
                ),
            );
        } finally {
            console.error = orig;
            await Deno.remove(tempDir, { recursive: true });
        }
    },
);

Deno.test("LLMStats and MoonshotClient full coverage in main process", async () => {
    const stats = new LLMStats();
    stats.setFile("a.ts");
    stats.add({ durationMs: 100, promptTokens: 50, completionTokens: 10 });
    stats.setFile("a.ts");
    stats.add({ durationMs: 50, promptTokens: 0, completionTokens: 0 });
    stats.setFile(null);
    stats.add({ durationMs: 25, promptTokens: 25, completionTokens: 5 });

    assertEquals(stats.callCount, 3);
    assertEquals(stats.totalDurationMs, 175);
    assertEquals(stats.totalPromptTokens, 75);
    assertEquals(stats.totalCompletionTokens, 15);

    const byFile = stats.byFile();
    assertEquals(byFile.size, 2);
    assertEquals(byFile.get("a.ts")!.callCount, 2);
    assertEquals(byFile.get("(unknown)")!.callCount, 1);

    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const client = new MoonshotClient(
            "key",
            "model",
            mockFetchWithUsage("testName", 100, 8),
            stats,
        );
        const name = await client.nameFunction("ctx", ["x"], ["bad"]);
        assertEquals(name, "testName");
        assert(messages.some((m) => m.includes("naming function")));
        assert(messages.some((m) => m.includes("100 in") && m.includes("8 out")));

        const errClient = new MoonshotClient(
            "key",
            "model",
            (() =>
                Promise.resolve(
                    new Response(JSON.stringify({}), { status: 500 }),
                )) as unknown as typeof fetch,
            stats,
        );
        await assertRejects(
            () => errClient.nameFunction("c", ["a"]),
            Error,
            "LLM API error 500",
        );
        assert(messages.some((m) => m.includes("API error 500")));

        const badClient = new MoonshotClient(
            "key",
            "model",
            (() =>
                Promise.resolve(
                    new Response(JSON.stringify({})),
                )) as unknown as typeof fetch,
            stats,
        );
        await assertRejects(
            () => badClient.nameFunction("c", ["a"]),
            Error,
            "Unexpected LLM response",
        );
        assert(messages.some((m) => m.includes("bad response")));

        const noUsageClient = new MoonshotClient(
            "key",
            "model",
            (() =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            choices: [{ message: { content: "noUsage" } }],
                        }),
                    ),
                )) as unknown as typeof fetch,
            stats,
        );
        const noUsageName = await noUsageClient.nameFunction("c", ["a"]);
        assertEquals(noUsageName, "noUsage");
        assert(messages.some((m) => m.includes("ms") && !m.includes(" in")));
    } finally {
        console.error = orig;
    }

    const noStatsClient = new MoonshotClient(
        "key",
        "model",
        (() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        choices: [{ message: { content: "plain" } }],
                    }),
                ),
            )) as unknown as typeof fetch,
    );
    const plainName = await noStatsClient.nameFunction("c", ["a"]);
    assertEquals(plainName, "plain");

    const config = {
        max_function_lines: 75,
        function_splitter_retries: 2,
        provider: "moonshot",
        model: "m",
        enabled_refactors: [],
        disabled_refactors: [],
        verbose: false,
    };
    const fromFactory = createLLMClient(config, {
        apiKey: "k",
        fetchFn: mockFetchWithUsage("factory", 1, 1),
        stats,
    });
    assert(fromFactory);
    assertEquals(await fromFactory.nameFunction("c", ["a"]), "factory");
});
