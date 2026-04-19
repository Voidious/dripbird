// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import {
    collectAllBindings,
    collectIdentifiers,
    collectPatternBindings,
    createFunctionSplitter,
    getParamName,
    getTailCode,
} from "../../src/refactors/function_splitter.ts";
import type { LLMClient } from "../../src/llm.ts";
import { parse } from "recast";
import * as babelParser from "@babel/parser";

function mockLLM(name: string): LLMClient {
    return {
        // deno-lint-ignore require-await
        async nameFunction(_context: string, _params: string[]) {
            return name;
        },
    };
}

function makeLongFunction(lines: number): string {
    const bodyLines = [];
    for (let i = 0; i < lines; i++) {
        bodyLines.push(`    const v${i} = ${i};`);
    }
    return `function longFunc(a, b) {\n${bodyLines.join("\n")}\n    return v${
        lines - 1
    };\n}\n`;
}

function makeSource(fnCode: string): string {
    return fnCode;
}

const defaultConfig = {
    max_function_lines: 10,
    provider: "moonshot",
    model: "kimi-k2.5",
    enabled_refactors: [],
    disabled_refactors: [],
};

function fixedRandom(values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length];
}

Deno.test("function splitter skips function below max lines", async () => {
    const source = makeSource(`function short() {\n    return 1;\n}\n`);
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 3 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter skips async function", async () => {
    const source = makeLongFunction(50);
    const asyncSource = source.replace(
        "function longFunc",
        "async function longFunc",
    );
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(asyncSource, [{ start: 1, end: 52 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter skips generator function", async () => {
    const source = makeLongFunction(50);
    const genSource = source.replace(
        "function longFunc",
        "function* longFunc",
    );
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(genSource, [{ start: 1, end: 52 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter skips function with nested function declaration", async () => {
    const source = `function outer(a, b) {
    const x = a + b;
    const y = x * 2;
    const z = y + a;
    function inner() { return 1; }
    const w = z + b;
    const v = w + a;
    const u = v + b;
    const t = u + a;
    const s = t + b;
    const r = s + a;
    const q = r + b;
    return q;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 14 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter skips function using this", async () => {
    const source = `function usesThis(a, b) {
    const x = a + b;
    const y = x * 2;
    const z = y + a;
    const w = z + b;
    const v = w + this.name;
    const u = v + b;
    const t = u + a;
    const s = t + b;
    const r = s + a;
    const q = r + b;
    return q;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 12 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter splits long function with return", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`    const v${i} = ${i};`);
    }
    const source = `function longFunc(a, b) {\n${
        lines.join("\n")
    }\n    return v19;\n}\n`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("process_values"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 23 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("process_values"));
    assert(result.source.includes("return process_values("));
    assert(result.description.includes("split function"));
});

Deno.test("function splitter splits function without return", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`    console.log(${i});`);
    }
    const source = `function longFunc(a, b) {\n${lines.join("\n")}\n}\n`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("log_values"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 22 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("log_values"));
    assert(!result.source.includes("return log_values"));
    assert(result.source.includes("log_values("));
});

Deno.test("function splitter passes free variables as params", async () => {
    const source = `function longFunc(a, b) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + a;
    const l = k + b;
    const m = l + a;
    const n = m + b;
    return n + c;
}
`;
    let capturedParams: string[] = [];
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction(_ctx: string, params: string[]) {
            capturedParams = params;
            return "helper";
        },
    };
    const splitter = createFunctionSplitter(
        defaultConfig,
        llm,
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 15 }]);
    assertEquals(result.changed, true);
    assert(capturedParams.length > 0);
    assert(result.source.includes("function helper("));
});

function parseStmts(code: string): any[] {
    const ast = parse(code, {
        parser: {
            parse(code: string) {
                return babelParser.parse(code, {
                    sourceType: "module",
                    plugins: ["typescript", "jsx"],
                });
            },
        },
    });
    return ast.program.body;
}

Deno.test("collectPatternBindings handles null pattern", () => {
    const bindings = new Set<string>();
    collectPatternBindings(null, bindings);
    assertEquals(bindings.size, 0);
});

Deno.test("collectPatternBindings handles ObjectPattern RestElement", () => {
    const bindings = new Set<string>();
    const stmts = parseStmts("const { x, ...rest } = obj;");
    collectPatternBindings((stmts[0] as any).declarations[0].id, bindings);
    assertEquals(bindings.has("x"), true);
    assertEquals(bindings.has("rest"), true);
});

Deno.test("collectPatternBindings handles ArrayPattern", () => {
    const bindings = new Set<string>();
    const stmts = parseStmts("const [a, b, , c] = arr;");
    collectPatternBindings((stmts[0] as any).declarations[0].id, bindings);
    assertEquals(bindings.has("a"), true);
    assertEquals(bindings.has("b"), true);
    assertEquals(bindings.has("c"), true);
});

Deno.test("collectPatternBindings handles AssignmentPattern", () => {
    const bindings = new Set<string>();
    const stmts = parseStmts("const { x = 5 } = obj;");
    collectPatternBindings((stmts[0] as any).declarations[0].id, bindings);
    assertEquals(bindings.has("x"), true);
});

Deno.test("collectPatternBindings handles RestElement", () => {
    const bindings = new Set<string>();
    const stmts = parseStmts("const [...rest] = arr;");
    collectPatternBindings((stmts[0] as any).declarations[0].id, bindings);
    assertEquals(bindings.has("rest"), true);
});

Deno.test("collectAllBindings finds FunctionDeclaration name", () => {
    const stmts = parseStmts("function foo() { const x = 1; }");
    const bindings = collectAllBindings(stmts);
    assertEquals(bindings.has("foo"), true);
});

Deno.test("collectAllBindings finds ClassDeclaration name", () => {
    const stmts = parseStmts("class Foo { method() {} }");
    const bindings = collectAllBindings(stmts);
    assertEquals(bindings.has("Foo"), true);
});

Deno.test("collectAllBindings stops at function expressions", () => {
    const stmts = parseStmts("const fn = function() { const inner = 1; };");
    const bindings = collectAllBindings(stmts);
    assertEquals(bindings.has("fn"), true);
    assertEquals(bindings.has("inner"), false);
});

Deno.test("collectAllBindings stops at arrow functions", () => {
    const stmts = parseStmts("const fn = () => { const inner = 1; };");
    const bindings = collectAllBindings(stmts);
    assertEquals(bindings.has("fn"), true);
    assertEquals(bindings.has("inner"), false);
});

Deno.test("collectIdentifiers filters non-computed ObjectProperty keys", () => {
    const stmts = parseStmts("const x = { myKey: value };");
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("value"), true);
    assertEquals(ids.has("myKey"), false);
});

Deno.test("collectIdentifiers keeps shorthand ObjectProperty", () => {
    const stmts = parseStmts("const x = { a };");
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("a"), true);
});

Deno.test("collectIdentifiers filters ObjectMethod keys", () => {
    const stmts = parseStmts("const x = { method() { return y; } };");
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("y"), true);
    assertEquals(ids.has("method"), false);
});

Deno.test("collectIdentifiers filters ClassMethod keys", () => {
    const stmts = parseStmts("class Foo { myMethod() { return z; } }");
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("z"), true);
    assertEquals(ids.has("myMethod"), false);
});

Deno.test("collectIdentifiers filters LabeledStatement labels", () => {
    const stmts = parseStmts("myLabel: for (let i = 0; i < 10; i++) {}");
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("myLabel"), false);
});

Deno.test("collectIdentifiers filters ExportSpecifier", () => {
    const stmts = parseStmts("const x = 1; export { x };");
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("x"), true);
});

Deno.test("collectIdentifiers filters ImportSpecifier local", () => {
    const stmts = parseStmts('import { foo as bar } from "mod";');
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("bar"), false);
});

Deno.test("collectIdentifiers includes computed member expressions", () => {
    const stmts = parseStmts("obj[prop];");
    const ids = collectIdentifiers(stmts);
    assertEquals(ids.has("prop"), true);
});

Deno.test("getParamName returns null for destructured param", () => {
    assertEquals(getParamName({ type: "ObjectPattern" }), null);
});

Deno.test("getParamName handles AssignmentPattern", () => {
    assertEquals(
        getParamName({
            type: "AssignmentPattern",
            left: { type: "Identifier", name: "x" },
        }),
        "x",
    );
});

Deno.test("getParamName handles RestElement", () => {
    assertEquals(
        getParamName({
            type: "RestElement",
            argument: { type: "Identifier", name: "rest" },
        }),
        "rest",
    );
});

Deno.test("getParamName handles TSParameterProperty", () => {
    assertEquals(
        getParamName({
            type: "TSParameterProperty",
            parameter: { type: "Identifier", name: "prop" },
        }),
        "prop",
    );
});

Deno.test("getTailCode returns empty string when tail has no loc", () => {
    assertEquals(getTailCode("source", [{}], {}), "");
});

Deno.test("function splitter skips function with 2 stmts below max lines", async () => {
    const source = [
        "function short(a, b) {",
        "    const c = a + b;",
        "    return c;",
        "}",
    ].join("\n") + "\n";
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 4 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles no valid split points", async () => {
    const longExpr = Array(15).fill("a").join(" +\n        ");
    const source = [
        "function longFunc(a, b) {",
        `    const x = ${longExpr};`,
        `    const y = ${longExpr};`,
        "    return y;",
        "}",
    ].join("\n") + "\n";
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 50 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter with few split points returns all", async () => {
    const source = [
        "function longFunc(a, b) {",
        "    const c = a +",
        "        b +",
        "        1;",
        "    const d = c +",
        "        a +",
        "        2;",
        "    const e = d +",
        "        b +",
        "        3;",
        "    return e;",
        "}",
    ].join("\n") + "\n";
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 13 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter skips function outside changed range", async () => {
    const source = makeLongFunction(50);
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 100, end: 200 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles unparseable source", async () => {
    const source = "this is not valid javascript {{{{";
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 1 }]);
    assertEquals(result.changed, false);
    assertEquals(result.source, source);
});

Deno.test("function splitter handles class method", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`        const v${i} = ${i};`);
    }
    const source = `class Processor {
    process(a, b) {
${lines.join("\n")}
        return v19;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("compute"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 2, end: 24 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("compute"));
    assert(result.source.includes("return Processor.compute("));
    assert(result.source.includes("static compute("));
});

Deno.test("function splitter handles class method with this", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`        const v${i} = ${i};`);
    }
    const source = `class Processor {
    process(a, b) {
${lines.join("\n")}
        this.result = v19;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("compute"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 2, end: 24 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("this.compute()"));
    assert(!result.source.includes("static compute"));
});

Deno.test("function splitter handles static class method when no this in tail", async () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
        lines.push(`        const v${i} = ${i};`);
    }
    const tailLines = [];
    for (let i = 5; i < 20; i++) {
        tailLines.push(`        const v${i} = ${i};`);
    }
    const source = `class Calculator {
    compute(a, b) {
${lines.join("\n")}
${tailLines.join("\n")}
        return v19;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("calc_tail"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 2, end: 24 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter skips constructor", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`        this.v${i} = ${i};`);
    }
    const source = `class Foo {
    constructor(a, b) {
${lines.join("\n")}
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 2, end: 24 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter selects split point with fewest params", async () => {
    const source = `function longFunc(a, b) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + a;
    const l = k + b;
    const m = l + a;
    const n = m + b;
    return n;
}
`;
    let callCount = 0;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction(_ctx: string, _params: string[]) {
            callCount++;
            return "helper";
        },
    };
    const splitter = createFunctionSplitter(
        defaultConfig,
        llm,
        fixedRandom([0, 0.5, 0.99, 0.25, 0.75]),
    );
    const result = await splitter(source, [{ start: 1, end: 15 }]);
    assertEquals(result.changed, true);
    assertEquals(callCount, 1);
});

Deno.test("function splitter handles function with single statement", async () => {
    const source = `function short() {\n    console.log(1);\n}\n`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 3 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles function with no body statements", async () => {
    const source = `function empty() {}\n`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 1, end: 1 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles destructuring patterns", async () => {
    const source = `function longFunc(a, b) {
    const { x, y } = a;
    const [z, ...rest] = b;
    const { w = 10 } = a;
    const m = x + y + z;
    const n = m + rest.length;
    const o = n + w;
    const p = o + a;
    const q = p + b;
    const r = q + a;
    const s = r + b;
    const t = s + a;
    const u = t + b;
    return u + m;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 15 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("helper"));
});

Deno.test("function splitter handles function expressions in body", async () => {
    const source = `function longFunc(a, b) {
    const fn = function() { return a; };
    const arrow = () => b;
    const c = fn() + arrow();
    const d = c + a;
    const e = d + b;
    const f = e + a;
    const g = f + b;
    const h = g + a;
    const i = h + b;
    const j = i + a;
    const k = j + b;
    return k;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 14 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter handles member expressions in tail", async () => {
    const source = `function longFunc(a, b) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + a;
    const l = k + b;
    const m = l + a;
    const n = m + b;
    return n + c;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 15 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter handles default and rest params", async () => {
    const source = `function longFunc(a, b = 10, ...rest) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + rest.length;
    const h = g + a;
    const i = h + b;
    const j = i + a;
    const k = j + b;
    const l = k + a;
    const m = l + b;
    const n = m + a;
    return n;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 15 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter handles object literals in tail", async () => {
    const source = `function longFunc(a, b) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + a;
    const l = k + b;
    const m = l + a;
    const result = { data: m, compute() { return a; } };
    return result;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 15 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter handles labeled statements in tail", async () => {
    const source = `function longFunc(a, b) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + a;
    const l = k + b;
    const m = l + a;
    const n = m + b;
loop:
    for (let x = 0; x < n; x++) {
        if (x > 5) break loop;
    }
    return n;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 17 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter selects random subset with many split points", async () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
        lines.push(`    const v${i} = ${i};`);
    }
    const source = `function longFunc(a, b) {\n${
        lines.join("\n")
    }\n    return v49;\n}\n`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0.1, 0.3, 0.5, 0.7, 0.9]),
    );
    const result = await splitter(source, [{ start: 1, end: 53 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter skips async class method", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`        const v${i} = ${i};`);
    }
    const source = `class Foo {
    async process(a, b) {
${lines.join("\n")}
        return v19;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 2, end: 24 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter skips generator class method", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`        const v${i} = ${i};`);
    }
    const source = `class Foo {
    *generate(a, b) {
${lines.join("\n")}
        yield v19;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 2, end: 24 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter skips class method outside range", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`        const v${i} = ${i};`);
    }
    const source = `class Foo {
    process(a, b) {
${lines.join("\n")}
        return v19;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 100, end: 200 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles class method with single statement", async () => {
    const source = `class Foo {
    process(a, b) {
        return a + b;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 2, end: 4 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles class method with nested function", async () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
        lines.push(`        const v${i} = ${i};`);
    }
    const source = `class Foo {
    process(a, b) {
        function inner() { return 1; }
${lines.join("\n")}
        return v19;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 2, end: 25 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter skips class method below max lines", async () => {
    const source = `class Foo {
    process(a, b) {
        const c = a + b;
        return c;
    }
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
    );
    const result = await splitter(source, [{ start: 2, end: 5 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles export/import specifiers in tail", async () => {
    const source = `import { util } from "helpers";

function longFunc(a, b) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + util(a);
    const l = k + b;
    return l;
}

export { longFunc };
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 3, end: 16 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter handles shorthand object properties", async () => {
    const source = `function longFunc(a, b) {
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + a;
    const l = k + b;
    const m = l + a;
    const n = m + b;
    const obj = { a, b, c: d };
    return n;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 16 }]);
    assertEquals(result.changed, true);
});

Deno.test("function splitter with multiple candidates processes all", async () => {
    const lines1 = [];
    for (let i = 0; i < 20; i++) {
        lines1.push(`    const a${i} = ${i};`);
    }
    const lines2 = [];
    for (let i = 0; i < 20; i++) {
        lines2.push(`    const b${i} = ${i};`);
    }
    const source = `function first(x, y) {\n${
        lines1.join("\n")
    }\n    return a19;\n}\n\nfunction second(x, y) {\n${
        lines2.join("\n")
    }\n    return b19;\n}\n`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [
        { start: 1, end: 23 },
        { start: 25, end: 47 },
    ]);
    assertEquals(result.changed, true);
    assert(result.source.includes("helper"));
});

Deno.test("function splitter skips trivial tail that just returns a variable", async () => {
    const source = `function longFunc(a, b) {
    const x = a + b + a
        + b + a + b
        + a + b + a
        + b + a + b
        + a + b + a
        + b + a + b
        + a + b + a
        + b + a + b
        + a + b + a
        + b + a + b;
    return x;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 13 }]);
    assertEquals(result.changed, false);
});

Deno.test("function splitter handles class expression in body", async () => {
    const source = `function longFunc(a, b) {
    const MyClass = class {};
    const c = a + b;
    const d = c * 2;
    const e = d + a;
    const f = e + b;
    const g = f + a;
    const h = g + b;
    const i = h + a;
    const j = i + b;
    const k = j + a;
    const l = k + b;
    const m = l + a;
    return m;
}
`;
    const splitter = createFunctionSplitter(
        defaultConfig,
        mockLLM("helper"),
        fixedRandom([0]),
    );
    const result = await splitter(source, [{ start: 1, end: 15 }]);
    assertEquals(result.changed, true);
});
