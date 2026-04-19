import { assert, assertEquals } from "@std/assert";
import { readStream, run, runInDir } from "../src/main.ts";

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
        } finally {
            console.error = original;
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
