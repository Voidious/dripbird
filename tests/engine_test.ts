import { assert, assertEquals } from "@std/assert";
import { runRefactors } from "../src/engine.ts";
import type { NamedRefactor, Refactor } from "../src/engine.ts";

const noChangeRefactor: NamedRefactor = {
    name: "no_change",
    refactor: (source, _ranges) => ({
        changed: false,
        source,
        description: "",
    }),
};

const changeRefactor: NamedRefactor = {
    name: "change",
    refactor: (source, _ranges) => ({
        changed: true,
        source: source.replace("old", "new"),
        description: "changed something",
    }),
};

Deno.test(
    "runRefactors returns unchanged when no refactors apply",
    async () => {
        const result = await runRefactors("old code", [], [noChangeRefactor]);
        assertEquals(result.changed, false);
        assertEquals(result.source, "old code");
        assertEquals(result.timings.length, 1);
        assertEquals(result.timings[0].name, "no_change");
        assert(result.timings[0].durationMs >= 0);
    },
);

Deno.test("runRefactors applies a single refactor", async () => {
    const result = await runRefactors("old code", [], [changeRefactor]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "new code");
    assertEquals(result.description, "changed something");
    assertEquals(result.timings.length, 1);
    assertEquals(result.timings[0].name, "change");
});

Deno.test("runRefactors chains multiple refactors", async () => {
    const upperRefactor: NamedRefactor = {
        name: "upper",
        refactor: (source, _ranges) => ({
            changed: true,
            source: source.toUpperCase(),
            description: "uppercased",
        }),
    };
    const result = await runRefactors("old code", [], [
        changeRefactor,
        upperRefactor,
    ]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "NEW CODE");
    assertEquals(result.description, "changed something\nuppercased");
    assertEquals(result.timings.length, 2);
    assertEquals(result.timings[0].name, "change");
    assertEquals(result.timings[1].name, "upper");
});

Deno.test(
    "runRefactors with empty refactors list returns unchanged",
    async () => {
        const result = await runRefactors("code", [], []);
        assertEquals(result.changed, false);
        assertEquals(result.source, "code");
        assertEquals(result.timings.length, 0);
    },
);

Deno.test("runRefactors handles async refactors", async () => {
    // deno-lint-ignore require-await
    const asyncFn: Refactor = async (source, _ranges) => ({
        changed: true,
        source: source.replace("old", "async"),
        description: "async change",
    });
    const asyncRefactor: NamedRefactor = { name: "async", refactor: asyncFn };
    const result = await runRefactors("old code", [], [asyncRefactor]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "async code");
    assertEquals(result.description, "async change");
    assertEquals(result.timings.length, 1);
    assertEquals(result.timings[0].name, "async");
});
