import { assertEquals } from "@std/assert";
import { parseDiff } from "../src/diff.ts";

Deno.test("parseDiff returns empty for empty input", () => {
    assertEquals(parseDiff(""), []);
});

Deno.test("parseDiff returns empty for diff with no hunk headers", () => {
    assertEquals(parseDiff("some random text\nmore text"), []);
});

Deno.test("parseDiff ignores hunk header without preceding file header", () => {
    const diff = "@@ -1,3 +1,4 @@\n hello\n+world\n";
    assertEquals(parseDiff(diff), []);
});

Deno.test("parses single file with single hunk", () => {
    const diff = [
        "diff --git a/foo.ts b/foo.ts",
        "index abc..def 100644",
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1,3 +1,4 @@",
        " hello",
        "+world",
    ].join("\n");
    const hunks = parseDiff(diff);
    assertEquals(hunks.length, 1);
    assertEquals(hunks[0].file, "foo.ts");
    assertEquals(hunks[0].oldStart, 1);
    assertEquals(hunks[0].oldCount, 3);
    assertEquals(hunks[0].newStart, 1);
    assertEquals(hunks[0].newCount, 4);
});

Deno.test("defaults count to 1 when omitted in hunk header", () => {
    const diff = [
        "--- a/bar.ts",
        "+++ b/bar.ts",
        "@@ -10 +10 @@",
    ].join("\n");
    const hunks = parseDiff(diff);
    assertEquals(hunks.length, 1);
    assertEquals(hunks[0].oldCount, 1);
    assertEquals(hunks[0].newCount, 1);
});

Deno.test("defaults oldCount to 1 when only newCount is given", () => {
    const diff = [
        "--- a/bar.ts",
        "+++ b/bar.ts",
        "@@ -5 +5,3 @@",
    ].join("\n");
    const hunks = parseDiff(diff);
    assertEquals(hunks[0].oldCount, 1);
    assertEquals(hunks[0].newCount, 3);
});

Deno.test("defaults newCount to 1 when only oldCount is given", () => {
    const diff = [
        "--- a/bar.ts",
        "+++ b/bar.ts",
        "@@ -5,3 +5 @@",
    ].join("\n");
    const hunks = parseDiff(diff);
    assertEquals(hunks[0].oldCount, 3);
    assertEquals(hunks[0].newCount, 1);
});

Deno.test("parses multiple hunks in the same file", () => {
    const diff = [
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1,3 +1,4 @@",
        " hello",
        "@@ -20,5 +21,6 @@",
        " world",
    ].join("\n");
    const hunks = parseDiff(diff);
    assertEquals(hunks.length, 2);
    assertEquals(hunks[0].file, "foo.ts");
    assertEquals(hunks[0].oldStart, 1);
    assertEquals(hunks[1].file, "foo.ts");
    assertEquals(hunks[1].oldStart, 20);
});

Deno.test("parses multiple files", () => {
    const diff = [
        "--- a/alpha.ts",
        "+++ b/alpha.ts",
        "@@ -1,2 +1,3 @@",
        " a",
        "--- b/beta.ts",
        "+++ b/beta.ts",
        "@@ -10,4 +10,5 @@",
        " b",
    ].join("\n");
    const hunks = parseDiff(diff);
    assertEquals(hunks.length, 2);
    assertEquals(hunks[0].file, "alpha.ts");
    assertEquals(hunks[1].file, "beta.ts");
});

Deno.test("ignores --- line (only matches +++)", () => {
    const diff = [
        "--- a/foo.ts",
        "@@ -1,3 +1,4 @@",
        " hello",
    ].join("\n");
    assertEquals(parseDiff(diff), []);
});

Deno.test("handles realistic git diff output", () => {
    const diff = [
        "diff --git a/src/main.ts b/src/main.ts",
        "index abc1234..def5678 100644",
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "@@ -10,7 +10,8 @@ function old() {",
        "     const x = 1;",
        "     const y = 2;",
        "+    const z = 3;",
        "     return x + y;",
        " }",
        "",
        "diff --git a/src/util.ts b/src/util.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/util.ts",
        "@@ -0,0 +1,5 @@",
        "+export function helper() {",
        "+    return 42;",
        "+}",
    ].join("\n");
    const hunks = parseDiff(diff);
    assertEquals(hunks.length, 2);
    assertEquals(hunks[0].file, "src/main.ts");
    assertEquals(hunks[0].oldStart, 10);
    assertEquals(hunks[0].oldCount, 7);
    assertEquals(hunks[0].newStart, 10);
    assertEquals(hunks[0].newCount, 8);
    assertEquals(hunks[1].file, "src/util.ts");
    assertEquals(hunks[1].oldStart, 0);
    assertEquals(hunks[1].oldCount, 0);
    assertEquals(hunks[1].newStart, 1);
    assertEquals(hunks[1].newCount, 5);
});
