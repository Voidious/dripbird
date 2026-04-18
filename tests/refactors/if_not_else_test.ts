import { assert, assertEquals } from "@std/assert";
import { ifNotElse, inRange } from "../../src/refactors/if_not_else.ts";

const FULL_RANGE = [{ start: 1, end: 100 }];

Deno.test("inRange returns true when node overlaps range", () => {
    assertEquals(inRange(3, 5, [{ start: 1, end: 4 }]), true);
});

Deno.test("inRange returns false when node is outside range", () => {
    assertEquals(inRange(10, 15, [{ start: 1, end: 5 }]), false);
});

Deno.test("inRange returns false for empty ranges", () => {
    assertEquals(inRange(1, 5, []), false);
});

Deno.test("ifNotElse flips simple if-not-else with braces", () => {
    const source = "if (!a) {\n    b();\n} else {\n    c();\n}\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, true);
    assert(result.source.includes("if (a)"));
    assert(!result.source.includes("if (!a)"));
    assert(result.description.includes("line 1"));
});

Deno.test("ifNotElse no change without else clause", () => {
    const source = "if (!a) {\n    b();\n}\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, false);
    assertEquals(result.source, source);
});

Deno.test("ifNotElse no change for else-if chain", () => {
    const source = "if (!a) {\n    b();\n} else if (c) {\n    d();\n}\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, false);
});

Deno.test("ifNotElse no change for non-negated condition", () => {
    const source = "if (a) {\n    b();\n} else {\n    c();\n}\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, false);
});

Deno.test("ifNotElse no change when outside range", () => {
    const source = "if (!a) {\n    b();\n} else {\n    c();\n}\n";
    const result = ifNotElse(source, [{ start: 100, end: 200 }]);
    assertEquals(result.changed, false);
});

Deno.test("ifNotElse flips complex negated expression", () => {
    const source = "if (!(a && b)) {\n    c();\n} else {\n    d();\n}\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, true);
    assert(!result.source.includes("!"));
    assert(result.source.includes("d()"));
    assert(result.source.includes("c()"));
});

Deno.test("ifNotElse handles syntax errors gracefully", () => {
    const source = "this is not valid JS {{}}\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, false);
    assertEquals(result.source, source);
});

Deno.test("ifNotElse flips nested if-not-else in single pass", () => {
    const source = [
        "if (!a) {",
        "    if (!b) {",
        "        c();",
        "    } else {",
        "        d();",
        "    }",
        "} else {",
        "    e();",
        "}",
    ].join("\n");
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, true);
    assert(result.source.includes("if (a)"));
    assert(result.source.includes("if (b)"));
});

Deno.test(
    "ifNotElse skips unary operators that are not !",
    () => {
        const source =
            "if (typeof x === 'undefined') {\n    b();\n} else {\n    c();\n}\n";
        const result = ifNotElse(source, FULL_RANGE);
        assertEquals(result.changed, false);
    },
);

Deno.test("ifNotElse flips single-line if-not-else", () => {
    const source = "if (!a) b(); else c();\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, true);
    assert(result.source.includes("if (a)"));
});

Deno.test("ifNotElse flips method call negation", () => {
    const source = "if (!obj.method()) {\n    x();\n} else {\n    y();\n}\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, true);
    assert(result.source.includes("if (obj.method())"));
});

Deno.test("ifNotElse no change for file with no matching patterns", () => {
    const source = "const x = 1;\nconsole.log(x);\n";
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, false);
    assertEquals(result.source, source);
});

Deno.test("ifNotElse flips multiple if-not-else in same file", () => {
    const source = [
        "if (!a) {",
        "    b();",
        "} else {",
        "    c();",
        "}",
        "if (!d) {",
        "    e();",
        "} else {",
        "    f();",
        "}",
    ].join("\n");
    const result = ifNotElse(source, FULL_RANGE);
    assertEquals(result.changed, true);
    assert(result.source.includes("if (a)"));
    assert(result.source.includes("if (d)"));
});
