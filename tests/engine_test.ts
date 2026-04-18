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
    () => {
        const result = runRefactors("old code", [], [noChangeRefactor]);
        assertEquals(result.changed, false);
        assertEquals(result.source, "old code");
    },
);

Deno.test("runRefactors applies a single refactor", () => {
    const result = runRefactors("old code", [], [changeRefactor]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "new code");
    assertEquals(result.description, "changed something");
});

Deno.test("runRefactors chains multiple refactors", () => {
    const upperRefactor: Refactor = (source, _ranges) => ({
        changed: true,
        source: source.toUpperCase(),
        description: "uppercased",
    });
    const result = runRefactors("old code", [], [
        changeRefactor,
        upperRefactor,
    ]);
    assertEquals(result.changed, true);
    assertEquals(result.source, "NEW CODE");
    assertEquals(result.description, "changed something\nuppercased");
});

Deno.test(
    "runRefactors with empty refactors list returns unchanged",
    () => {
        const result = runRefactors("code", [], []);
        assertEquals(result.changed, false);
        assertEquals(result.source, "code");
    },
);
