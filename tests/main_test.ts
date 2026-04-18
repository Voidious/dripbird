import { assert, assertEquals } from "@std/assert";
import { readStream, run } from "../src/main.ts";

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

Deno.test("run returns 0 and prints summary for valid diff", () => {
    const messages: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const diff = [
            "--- a/foo.ts",
            "+++ b/foo.ts",
            "@@ -1,3 +1,4 @@",
            " hello",
            "+world",
        ].join("\n");
        assertEquals(run(diff), 0);
        assert(messages[0].includes("1 hunk(s)"));
        assert(messages[0].includes("1 file(s)"));
        assert(messages[1].includes("no refactors"));
    } finally {
        console.error = original;
    }
});

Deno.test("run counts multiple files in summary", async () => {
    const messages: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));

    try {
        const diff = [
            "--- a/alpha.ts",
            "+++ b/alpha.ts",
            "@@ -1,2 +1,3 @@",
            " a",
            "--- b/beta.ts",
            "+++ b/beta.ts",
            "@@ -5,3 +5,4 @@",
            " b",
        ].join("\n");
        assertEquals(await run(diff), 0);
        assert(messages[0].includes("2 hunk(s)"));
        assert(messages[0].includes("2 file(s)"));
    } finally {
        console.error = original;
    }
});
