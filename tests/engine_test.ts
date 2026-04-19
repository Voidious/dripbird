import { assertEquals } from "@std/assert";
import { runRefactors } from "../src/engine.ts";
import type { Refactor } from "../src/engine.ts";

const noChangeRefactor: Refactor = (source, _ranges) => ({
    changed: false,
    source,
    description: "",
});

const changeRefactor: Refactor = (source, _ranges) => ({
    changed: true,
    source: source.replace("old", "new"),
    description: "changed something",
});

Deno.test(
    "runRefactors returns unchanged when no refactors apply",
    async () => {
        const result = await runRefactors("old code", [], [
            noChangeRefactor,
        ]);
        assertEquals(result.changed, false);
        assertEquals(result.source, "old code");
    },
);

Deno.test("runRefactors applies a single refactor", async () => {
    const result = await runRefactors("old code", [], [changeRefactor]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "new code");
    assertEquals(result.description, "changed something");
});

Deno.test("runRefactors chains multiple refactors", async () => {
    const upperRefactor: Refactor = (source, _ranges) => ({
        changed: true,
        source: source.toUpperCase(),
        description: "uppercased",
    });
    const result = await runRefactors("old code", [], [
        changeRefactor,
        upperRefactor,
    ]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "NEW CODE");
    assertEquals(result.description, "changed something\nuppercased");
});

Deno.test(
    "runRefactors with empty refactors list returns unchanged",
    async () => {
        const result = await runRefactors("code", [], []);
        assertEquals(result.changed, false);
        assertEquals(result.source, "code");
    },
);

Deno.test("runRefactors handles async refactors", async () => {
    // deno-lint-ignore require-await
    const asyncRefactor: Refactor = async (source, _ranges) => ({
        changed: true,
        source: source.replace("old", "async"),
        description: "async change",
    });
    const result = await runRefactors("old code", [], [asyncRefactor]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "async code");
    assertEquals(result.description, "async change");
});
