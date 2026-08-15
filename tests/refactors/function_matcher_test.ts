import { assert, assertEquals } from "@std/assert";
import { parse } from "recast";
import * as babelParser from "@babel/parser";
import { createFunctionMatcher } from "../../src/refactors/function_matcher.ts";
import type {
    FunctionMatchResult,
    LLMClient,
    ReviewResult,
} from "../../src/llm.ts";
import type { Config } from "../../src/config.ts";

const testConfig: Config = {
    max_function_lines: 75,
    function_splitter_retries: 2,
    function_matcher_retries: 2,
    duplicate_extractor_min_lines: 2,
    duplicate_extractor_max_lines: 12,
    duplicate_extractor_retries: 2,
    provider: "moonshot",
    model: "kimi-k2.5",
    enabled_refactors: [],
    disabled_refactors: [],
    verbose: false,
};

function mockLLM(options: {
    verifyResult?: FunctionMatchResult;
    replacement?: string;
    reviewResult?: ReviewResult;
}): LLMClient {
    return {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch(): Promise<FunctionMatchResult> {
            return options.verifyResult ?? { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(): Promise<string> {
            return options.replacement ?? "mockCall();\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return options.reviewResult ?? {
                accepted: true,
                feedback: "",
            };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };
}

const acceptAll = mockLLM({});

Deno.test("function matcher: no match when no functions in file", async () => {
    const source = `const x = 1;\nconst y = 2;\n`;
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 1, end: 2 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: body match of static method inside another class method", async () => {
    const source = [
        "class Formatter {",
        "    static pad(text) {",
        "        const trimmed = text.trim();",
        '        return trimmed.padStart(40, " ");',
        "    }",
        "}",
        "",
        "class Report {",
        "    renderHeader(title) {",
        '        db.insert("logs", { title });',
        "        const t = title.trim();",
        '        return t.padStart(40, " ");',
        "    }",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 13 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Formatter.pad(title)"));
});

Deno.test("function matcher: matches identical body with different variable names", async () => {
    const source = [
        "function sendGreeting(connection) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        '    connection.send("We come in peace.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        '    conn.send("We come in peace.");',
        "}",
    ].join("\n");

    const llm = mockLLM({
        replacement: "    sendGreeting(conn);\n",
    });

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 11 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("sendGreeting(conn)"));
    assert(!result.source.includes('conn.send("Hello,")'));
});

Deno.test("function matcher: skips self-matching (same function scope)", async () => {
    const source = [
        "function greet(name) {",
        '    console.log("Hello, " + name);',
        "}",
        "",
        "function other() {",
        "    greet('test');",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 1, end: 3 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: skips when LLM verification rejects", async () => {
    const source = [
        "function sendGreeting(connection) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const llm = mockLLM({
        verifyResult: { isMatch: false, reason: "not a real match" },
    });

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 9 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: skips when LLM review rejects", async () => {
    const source = [
        "function sendGreeting(connection) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const llm = mockLLM({
        reviewResult: {
            accepted: false,
            feedback: "wrong indentation",
        },
    });

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 9 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: matches expression-level with return/assignment", async () => {
    const source = [
        "function clean(s) {",
        "    return s.trim().toLowerCase();",
        "}",
        "",
        "function run() {",
        "    const input = getUserInput();",
        "    const sanitized = input.trim().toLowerCase();",
        "}",
    ].join("\n");

    const llm = mockLLM({
        replacement: "    const sanitized = clean(input);\n",
    });

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("clean(input)"));
});

Deno.test("function matcher: algorithmic replacement for zero-arg function", async () => {
    const source = [
        "function getGreeting() {",
        '    return "Hello, World!";',
        "}",
        "",
        "function run() {",
        '    const msg = "Hello, World!";',
        "    console.log(msg);",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("getGreeting()"));
});

Deno.test("function matcher: skips async functions", async () => {
    const source = [
        "async function fetchData(url) {",
        "    const response = fetch(url);",
        "    return response;",
        "}",
        "",
        "function run() {",
        "    const response = fetch('/api');",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 7 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: skips generator functions", async () => {
    const source = [
        "function* generateItems(count) {",
        "    for (let i = 0; i < count; i++) {",
        "        yield i;",
        "    }",
        "}",
        "",
        "function run() {",
        "    for (let i = 0; i < 5; i++) { yield i; }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: handles multiple matches bottom-to-top", async () => {
    const source = [
        "function greet(name) {",
        '    console.log("Hello, " + name);',
        "}",
        "",
        "function run() {",
        '    greet("Alice");',
        '    greet("Bob");',
        "}",
    ].join("\n");

    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement() {
            return "mock();\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(
            _original: string,
            proposed: string,
        ): Promise<ReviewResult> {
            try {
                parse(proposed, {
                    parser: {
                        parse(code: string) {
                            return babelParser.parse(code, {
                                sourceType: "module",
                                plugins: ["typescript", "jsx"],
                            });
                        },
                    },
                });
                return { accepted: true, feedback: "" };
            } catch {
                return {
                    accepted: false,
                    feedback: "parse error",
                };
            }
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: doesn't match across different string literals", async () => {
    const source = [
        "function greetA(name) {",
        '    console.log("Hello A, " + name);',
        "}",
        "",
        "function run() {",
        '    console.log("Hello B, " + userName);',
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: no fingerprint match without log callback", async () => {
    const source = [
        "function greet(name) {",
        "    console.log(name);",
        "}",
        "",
        "const x = 1;",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 5 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: verbose logging covers no-functions path", async () => {
    const logs: string[] = [];
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    await matcher("const x = 1;", [{ start: 1, end: 1 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("no functions found")));
});

Deno.test("function matcher: verbose logging covers functions-found path", async () => {
    const logs: string[] = [];
    const source = [
        "function greet(name) {",
        '    return "Hello, " + name;',
        "}",
        "",
        "function run() {",
        '    const a = "Hello, " + x;',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    await matcher(source, [{ start: 1, end: 6 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("found 2 function(s)")));
    assert(logs.some((l) => l.includes("expression match")));
});

Deno.test("function matcher: verbose logging covers match and reject paths", async () => {
    const logs: string[] = [];
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    const result = x * 2;",
        "}",
    ].join("\n");
    const llm = mockLLM({
        verifyResult: { isMatch: false, reason: "not same" },
    });
    const matcher = createFunctionMatcher(testConfig, llm);
    await matcher(source, [{ start: 5, end: 6 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("expression match")));
    assert(logs.some((l) => l.includes("candidate lines")));
    assert(logs.some((l) => l.includes("LLM rejected match")));
    assert(logs.some((l) => l.includes("not same")));
});

Deno.test("function matcher: verbose logging covers body match candidate", async () => {
    const logs: string[] = [];
    const source = [
        "function logMsg() {",
        '    console.log("hi");',
        "}",
        "",
        "function run() {",
        '    console.log("hi");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    await matcher(source, [{ start: 5, end: 6 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("body match")));
    assert(logs.some((l) => l.includes("candidate lines")));
});

Deno.test("function matcher: verbose logging covers parse failure", async () => {
    const logs: string[] = [];
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    obj.prop = x * 2;",
        "}",
    ].join("\n");
    const llm = mockLLM({
        replacement: "}}}}INVALID",
    });
    const matcher = createFunctionMatcher(testConfig, llm);
    await matcher(source, [{ start: 5, end: 6 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("replacement didn't parse")));
});

Deno.test("function matcher: verbose logging covers review rejection", async () => {
    const logs: string[] = [];
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    const result = x * 2;",
        "}",
    ].join("\n");
    const llm = mockLLM({
        reviewResult: { accepted: false, feedback: "wrong semantics" },
    });
    const matcher = createFunctionMatcher(testConfig, llm);
    await matcher(source, [{ start: 5, end: 6 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("LLM review rejected")));
    assert(logs.some((l) => l.includes("wrong semantics")));
});

Deno.test("function matcher: skips invalid replacement that doesn't parse", async () => {
    const source = [
        "function sendGreeting(connection, mode) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const llm = mockLLM({
        replacement: "this is not valid javascript {{{\n",
    });

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 9 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: algorithmic replacement for single-param expression match", async () => {
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    const result = count * 2;",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("double(count)"));
});

Deno.test("function matcher: preserves variable declaration keyword in expression match", async () => {
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    let result = count * 2;",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("let result = double(count)"));
});

Deno.test("function matcher: matches function with default params", async () => {
    const source = [
        "function greet(name, prefix) {",
        '    return prefix + " " + name;',
        "}",
        "",
        "function run() {",
        '    const msg = title + " " + user;',
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("greet(user, title)"));
});

Deno.test("function matcher: matches function with rest param", async () => {
    const source = [
        "function joinItems(items) {",
        "    return items.join(', ');",
        "}",
        "",
        "function run() {",
        "    const result = names.join(', ');",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("joinItems(names)"));
});

Deno.test("function matcher: handles object property context in normalization", async () => {
    const source = [
        "function processItem(item) {",
        "    const x = item.name;",
        "    const y = item.value;",
        "    return x + y;",
        "}",
        "",
        "function run() {",
        "    const a = obj.name;",
        "    const b = obj.value;",
        "    return a + b;",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 10 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("processItem(obj)"));
});

Deno.test("function matcher: handles code with object literals", async () => {
    const source = [
        "function buildConfig(host) {",
        "    return { host: host, port: 8080 };",
        "}",
        "",
        "function run() {",
        "    const cfg = { host: server, port: 8080 };",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("buildConfig(server)"));
});

Deno.test("function matcher: handles function with nested arrow function in body", async () => {
    const source = [
        "function apply(items) {",
        "    return items.map(x => x * 2);",
        "}",
        "",
        "function run() {",
        "    const result = data.map(y => y * 2);",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("apply(data)"));
});

Deno.test("function matcher: handles expression match with assignment expression", async () => {
    const source = [
        "function toUpper(s) {",
        "    return s.toUpperCase();",
        "}",
        "",
        "function run() {",
        "    let output = input.toUpperCase();",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("output = toUpper(input)"));
});

Deno.test("function matcher: no match for function body inside its own scope", async () => {
    const source = [
        "function greet(name) {",
        '    console.log("Hello, " + name);',
        "}",
        "",
        "function greet(name) {",
        '    console.log("Hi, " + name);',
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 1, end: 6 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: handles multi-param function match", async () => {
    const source = [
        "function formatGreeting(name, greeting) {",
        '    return greeting + ", " + name + "!";',
        "}",
        "",
        "function run() {",
        '    const msg = salutation + ", " + person + "!";',
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("formatGreeting(person, salutation)"));
});

Deno.test("function matcher: skips when algo replacement returns null and LLM replacement parses badly", async () => {
    const source = [
        "function complexOp(a, b) {",
        "    return a + b * 2;",
        "}",
        "",
        "function run() {",
        "    let obj = {};",
        "    obj.result = x + y * 2;",
        "}",
    ].join("\n");

    const llm = mockLLM({
        replacement: "INVALID {{{\n",
    });

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 7 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: handles source with unparseable code", async () => {
    const source = "function foo( { invalid syntax {{{";
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 1, end: 1 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: no match when no sequences overlap diff", async () => {
    const source = [
        "function greet(name) {",
        '    console.log("Hello, " + name);',
        "}",
        "",
        "function run() {",
        "    const x = 1;",
        '    greet("world");',
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 6 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: covers isPropertyContext ObjectMethod", async () => {
    const source = [
        "function foo(a) {",
        "    const obj = { calc() { return a; } };",
        "    return obj;",
        "}",
        "",
        "function bar() {",
        "    const obj = { calc() { return b; } };",
        "    return obj;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("foo(b)"));
});

Deno.test("function matcher: covers isPropertyContext ClassMethod", async () => {
    const source = [
        "function foo(a) {",
        "    class A { process() { return a; } }",
        "    return new A();",
        "}",
        "",
        "function bar() {",
        "    class B { process() { return b; } }",
        "    return new B();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("foo(b)"));
});

Deno.test("function matcher: covers isPropertyContext LabeledStatement", async () => {
    const source = [
        "function foo(a) {",
        "    loop: for (let i = 0; i < a; i++) { break loop; }",
        "    return a;",
        "}",
        "",
        "function bar() {",
        "    loop: for (let i = 0; i < b; i++) { break loop; }",
        "    return b;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("foo(b)"));
});

Deno.test("function matcher: covers getParamNames with default param", async () => {
    const source = [
        "function greet(name, prefix = 'Hello') {",
        '    return prefix + " " + name;',
        "}",
        "",
        "function run() {",
        '    const msg = title + " " + user;',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("greet(user, title)"));
});

Deno.test("function matcher: covers getParamNames with rest param", async () => {
    const source = [
        "function sum(first, ...rest) {",
        "    return first + rest.length;",
        "}",
        "",
        "function run() {",
        "    const total = x + arr.length;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("sum(x, arr)"));
});

Deno.test("function matcher: covers getParamNames with TS parameter property", async () => {
    const source = [
        "function greet(public name: string, greeting: string) {",
        '    return greeting + " " + name;',
        "}",
        "",
        "function run() {",
        '    const msg = title + " " + user;',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(typeof result.changed, "boolean");
});

Deno.test("function matcher: covers collectFunctions no-id (anonymous)", async () => {
    const source = [
        'export default function() { return "hello"; }',
        "",
        "function run() {",
        '    const x = "hello";',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 3, end: 4 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: covers collectFunctions empty body", async () => {
    const source = [
        "function noop() {}",
        "",
        "function run() {",
        "    const x = 1;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 3, end: 4 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: covers visitFunctionExpression in all visitors", async () => {
    const source = [
        "function foo(a) {",
        "    const fn = function() { return a; };",
        "    return fn();",
        "}",
        "",
        "function bar() {",
        "    const fn = function() { return b; };",
        "    return fn();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("foo(b)"));
});

Deno.test("function matcher: covers visitArrowFunctionExpression in all visitors", async () => {
    const source = [
        "function foo(a) {",
        "    const fn = (x) => a + x;",
        "    return fn(1);",
        "}",
        "",
        "function bar() {",
        "    const fn = (x) => b + x;",
        "    return fn(1);",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("foo(b)"));
});

Deno.test("function matcher: covers collectSequences FunctionDeclaration skip", async () => {
    const source = [
        "function foo(a) {",
        "    function helper() {}",
        "    return a + 1;",
        "}",
        "",
        "function run() {",
        "    return 1;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 7 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: covers findBodyMatches dedup", async () => {
    const source = [
        "function greet(name) {",
        '    return "Hello, " + name;',
        "}",
        "",
        "function run() {",
        '    const a = "Hello, " + x;',
        '    const b = "Hello, " + y;',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("greet("));
});

Deno.test("function matcher: covers findExpressionMatches bodyMatchedRanges", async () => {
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function foo(x) {",
        "    return x * 2;",
        "}",
        "",
        "function run() {",
        "    return input * 2;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 9, end: 10 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("double(input)") ||
            result.source.includes("foo(input)"),
    );
});

Deno.test("function matcher: covers findExpressionMatches self-match scope", async () => {
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    const result = x * 2;",
        "    return result;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("double(x)"));
});

Deno.test("function matcher: covers findExpressionMatches anonymous function", async () => {
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    const result = x * 2;",
        "}",
        "",
        "export default function() { return 1; }",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("double(x)"));
});

Deno.test("function matcher: covers getIndent with blank-only source", async () => {
    const source = [
        "function logMsg() {",
        '    console.log("hi");',
        "}",
        "",
        "function run() {",
        '    console.log("hi");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logMsg()"));
});

Deno.test("function matcher: covers buildCallFromMapping with unused param", async () => {
    const source = [
        "function foo(a, unused) {",
        "    return a + 1;",
        "}",
        "",
        "function run() {",
        "    const result = x + 1;",
        "}",
    ].join("\n");
    const llm = mockLLM({
        replacement: "    const result = foo(x);\n",
    });
    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("foo(x)"));
});

Deno.test("function matcher: covers buildAssignmentCall with assignment expression Identifier target", async () => {
    const source = [
        "function toUpper(s) {",
        "    return s.toUpperCase();",
        "}",
        "",
        "function run() {",
        "    let output;",
        "    output = input.toUpperCase();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("output = toUpper(input)"));
});

Deno.test("function matcher: covers buildAssignmentCall unused param", async () => {
    const source = [
        "function foo(a, unused) {",
        "    return a + 1;",
        "}",
        "",
        "function run() {",
        "    const result = x + 1;",
        "}",
    ].join("\n");
    const llm = mockLLM({
        replacement: "    const result = foo(x);\n",
    });
    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
});

Deno.test("function matcher: covers zero-arg body match with return", async () => {
    const source = [
        "function getVal() {",
        '    return "hello";',
        "}",
        "",
        "function run() {",
        '    return "hello";',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("return getVal()"));
});

Deno.test("function matcher: covers zero-arg body match without return", async () => {
    const source = [
        "function logHi() {",
        '    console.log("hi");',
        "}",
        "",
        "function run() {",
        '    console.log("hi");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logHi()"));
    assert(!result.source.includes("return logHi()"));
});

Deno.test("function matcher: covers overlapping range skip", async () => {
    const source = [
        "function greet(name) {",
        '    return "Hello, " + name;',
        "}",
        "",
        "function foo(x) {",
        '    return "Hello, " + x;',
        "}",
        "",
        "function run() {",
        '    return "Hello, " + person;',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 9, end: 10 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("greet(person)") ||
            result.source.includes("foo(person)"),
    );
});

Deno.test("function matcher: covers getParamNames with destructured param returning null", async () => {
    const source = [
        "function foo({ a, b }) {",
        "    return a + b;",
        "}",
        "",
        "function bar() {",
        "    return x + y;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assert(result.changed);
});

Deno.test("function matcher: covers getIndent returning empty for no-indent source", async () => {
    const source = [
        "function noop() {}",
        "function go() {",
        "console.log('hi');",
        "}",
        "function run() {",
        "console.log('hi');",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("go()"));
});

Deno.test("function matcher: covers getIndent with blank line in sequence source", async () => {
    const source = [
        "function logStuff() {",
        '    console.log("a");',
        "",
        '    console.log("b");',
        "}",
        "",
        "function run() {",
        '    console.log("a");',
        "",
        '    console.log("b");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 10 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logStuff()"));
});

Deno.test("function matcher: covers findExpressionMatches visitFunctionExpression guard", async () => {
    const source = [
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    const fn = function() { return 1; };",
        "    const x = val * 2;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("double(val)"));
});

Deno.test("function matcher: expression match with const in function body", async () => {
    const source = [
        "function greet(name) {",
        '    return "Hello, " + name;',
        "}",
        "",
        "function run() {",
        '    const a = "Hello, " + x;',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("greet(x)"));
});

Deno.test("function matcher: buildAssignmentCall at column zero", async () => {
    const source = [
        "function toUpper(s) {",
        "    return s.toUpperCase();",
        "}",
        "function run() {",
        "let output;",
        "output = input.toUpperCase();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 4, end: 6 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("output = toUpper(input)"));
});

Deno.test("function matcher: buildAssignmentCall variable declaration at column zero", async () => {
    const source = [
        "function toUpper(s) {",
        "    return s.toUpperCase();",
        "}",
        "function run() {",
        "let output = input.toUpperCase();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 4, end: 5 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("output = toUpper(input)"));
});

Deno.test("function matcher: getParamNames with destructured default param", async () => {
    const source = [
        "function foo({ a, b } = {}) {",
        "    return a + b;",
        "}",
        "",
        "function run() {",
        "    return x + y;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assert(result.changed);
});

Deno.test("function matcher: getParamNames with array rest destructured", async () => {
    const source = [
        "function foo(...[a, b]) {",
        "    return a + b;",
        "}",
        "",
        "function run() {",
        "    return x + y;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assert(result.changed);
});

Deno.test("function matcher: matches static method body in function", async () => {
    const source = [
        "class Utils {",
        "    static sendGreeting(connection) {",
        '        connection.send("Hello,");',
        '        connection.send("I am from Earth.");',
        "    }",
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const llm = mockLLM({
        replacement: "    Utils.sendGreeting(conn);\n",
    });

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 8, end: 11 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Utils.sendGreeting(conn)"));
    assert(!result.source.includes('conn.send("Hello,")'));
});

Deno.test("function matcher: expression match with static method", async () => {
    const source = [
        "class Str {",
        "    static clean(s) {",
        "        return s.trim().toLowerCase();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const sanitized = input.trim().toLowerCase();",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Str.clean(input)"));
});

Deno.test("function matcher: static method skips self-matching", async () => {
    const source = [
        "class Utils {",
        "    static logMsg() {",
        '        console.log("hi");',
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 2, end: 3 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: static method matches another static method body", async () => {
    const source = [
        "class Utils {",
        "    static logMsg() {",
        '        console.log("hi");',
        "    }",
        "",
        "    static run() {",
        '        console.log("hi");',
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Utils.logMsg()"));
});

Deno.test("function matcher: instance method not matched from a free function (no this)", async () => {
    // The instance method is collected as a target, but reaching it needs
    // either `this.` (same-class instance method) or an in-scope instance
    // reference (typed param / `new C()` before the call site). This free
    // function has neither, so the match is gated out.
    const source = [
        "class Utils {",
        "    clean(s) {",
        "        return s.trim().toLowerCase();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const result = input.trim().toLowerCase();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: skips async static method", async () => {
    const source = [
        "class Foo {",
        "    static async fetchData(url) {",
        "        return fetch(url);",
        "    }",
        "}",
        "",
        "function run() {",
        "    const response = fetch('/api');",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: matches sequence in instance method with static method", async () => {
    const source = [
        "class Processor {",
        "    static clean(s) {",
        "        return s.trim().toLowerCase();",
        "    }",
        "",
        "    process(input) {",
        "        const sanitized = input.trim().toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Processor.clean(input)"));
});

Deno.test("function matcher: instance method body matched within another instance method", async () => {
    const source = [
        "class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "",
        "    process(input) {",
        "        const sanitized = input.trim();",
        "        return sanitized.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 9 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("return this.clean(input);"),
        "expected a this.clean(input) call site",
    );
});

Deno.test("function matcher: instance method body (no return) matched within instance", async () => {
    const source = [
        "class Logger {",
        "    emit(msg) {",
        "        const upper = msg.toUpperCase();",
        "        console.log(upper);",
        "    }",
        "",
        "    announce(title) {",
        "        const loud = title.toUpperCase();",
        "        console.log(loud);",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 9 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("this.emit(title);"),
        "expected a this.emit(title) call site",
    );
});

Deno.test("function matcher: instance method not matched from a static method of same class", async () => {
    // `this` inside a static method is the class constructor, not an
    // instance, so an instance-method target can't be called via `this.`.
    const source = [
        "class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "",
        "    static process(input) {",
        "        const sanitized = input.trim();",
        "        return sanitized.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 9 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: instance method not matched from a different class", async () => {
    const source = [
        "class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "}",
        "",
        "class Report {",
        "    process(input) {",
        "        const sanitized = input.trim();",
        "        return sanitized.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 10, end: 11 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: instance method expression match within instance", async () => {
    const source = [
        "class Scorer {",
        "    bonus(points) {",
        "        return points * 2;",
        "    }",
        "",
        "    total(p) {",
        "        const extra = p * 2;",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 7 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("const extra = this.bonus(p);"),
        "expected a const extra = this.bonus(p) call site",
    );
});

Deno.test("function matcher: zero-arg instance method algo replacement uses this", async () => {
    const source = [
        "class Greeter {",
        "    greeting() {",
        '        return "hi";',
        "    }",
        "",
        "    welcome() {",
        '        return "hi";',
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 7 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("return this.greeting();"),
        "expected a return this.greeting() call site",
    );
});

Deno.test("function matcher: getters and setters are skipped as match targets", async () => {
    // If the getter were collected, `const x = this._n;` would be rewritten to
    // `const x = this.size();` -- calling a getter as a method. Skipping
    // getters/setters prevents that.
    const source = [
        "class Box {",
        "    get size() {",
        "        return this._n;",
        "    }",
        "",
        "    read() {",
        "        const x = this._n;",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 7 }]);
    assertEquals(result.changed, false);
    assert(!result.source.includes("this.size()"));
});

Deno.test("function matcher: instance method body matched externally via `new` ref in free function", async () => {
    // `fmt` is constructed before the duplicate window, so it's an in-scope
    // instance reference and the call site becomes `fmt.clean(input)`.
    const source = [
        "class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const fmt = new Formatter();",
        "    const sanitized = input.trim();",
        "    return sanitized.toLowerCase();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 12 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("return fmt.clean(input);"),
        "expected a fmt.clean(input) call site",
    );
});

Deno.test("function matcher: instance method body matched externally via typed param", async () => {
    // `fmt: Formatter` parameter is an in-scope instance reference inside
    // another class's method -> `fmt.clean(input)`.
    const source = [
        "class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "}",
        "",
        "class Report {",
        "    process(fmt: Formatter, input) {",
        "        const sanitized = input.trim();",
        "        return sanitized.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 9, end: 12 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("return fmt.clean(input);"),
        "expected a fmt.clean(input) call site",
    );
});

Deno.test("function matcher: zero-arg instance method matched externally via `new` ref", async () => {
    const source = [
        "class Greeter {",
        "    greeting() {",
        '        return "hi";',
        "    }",
        "}",
        "",
        "function run() {",
        "    const g = new Greeter();",
        '    return "hi";',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 10 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("return g.greeting();"),
        "expected a g.greeting() call site",
    );
});

Deno.test("function matcher: instance method expression match externally via `new` ref", async () => {
    const source = [
        "class Scorer {",
        "    bonus(points) {",
        "        return points * 2;",
        "    }",
        "}",
        "",
        "function run() {",
        "    const s = new Scorer();",
        "    const extra = p * 2;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 10 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("const extra = s.bonus(p);"),
        "expected a const extra = s.bonus(p) call site",
    );
});

Deno.test("function matcher: external instance ref must be declared before the call site", async () => {
    // `new Scorer()` is declared AFTER the duplicate statement, so it is not in
    // scope at the call site (temporal gate) and the match is skipped.
    const source = [
        "class Scorer {",
        "    bonus(points) {",
        "        return points * 2;",
        "    }",
        "}",
        "",
        "function run() {",
        "    const extra = p * 2;",
        "    const s = new Scorer();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 9 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: typed param of a different class is not an instance ref", async () => {
    // `fmt: Other` does not name an instance of Formatter, so there is no
    // reachable ref and the instance-method target is gated out.
    const source = [
        "class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "}",
        "",
        "class Other {",
        "    process(fmt: Other, input) {",
        "        const sanitized = input.trim();",
        "        return sanitized.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 9, end: 12 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: `new` ref detection ignores member-callee and destructuring declarators", async () => {
    // Defensive guards in instance-ref collection: a namespaced
    // `new Lib.Formatter()` (non-Identifier callee) and a destructuring
    // `const { x } = new Formatter()` (non-Identifier binding) must not be
    // recorded as refs. Only the plain `const f = new Formatter()` qualifies,
    // so the call site resolves to `f.clean(input)`.
    const source = [
        "class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const noise = new Lib.Formatter();",
        "    const { x } = new Formatter();",
        "    const f = new Formatter();",
        "    const sanitized = input.trim();",
        "    return sanitized.toLowerCase();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 13 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("return f.clean(input);"),
        "expected the plain `new Formatter()` ref to resolve to f.clean(input)",
    );
});

Deno.test("function matcher: this-using instance method not matched from external context", async () => {
    // `clean` reads `this.prefix` — its `this` is the Formatter instance.
    // From Report.process (a different class) the call site's `this` is a
    // Report, so `fmt.clean(...)` would retarget `this.prefix` onto the
    // Formatter ref. Even though `fmt: Formatter` is a valid in-scope ref,
    // the target is gated out of external matching because its `this` can't
    // be the call site's `this` (the bodies fingerprint-match only because
    // both write `this.prefix`, which is exactly the divergent case).
    const source = [
        "class Formatter {",
        '    prefix = ">>";',
        "    clean(s) {",
        "        return this.prefix + s.trim();",
        "    }",
        "}",
        "",
        "class Report {",
        '    prefix = "<<";',
        "    process(fmt: Formatter, input) {",
        "        return this.prefix + input.trim();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 10, end: 12 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: this-using instance method still matched within same class", async () => {
    // Counterpart to the external guard: a `this`-using instance method is
    // safe to match from another instance method of the SAME class, where the
    // call site's `this` and the target's `this` are the same instance. The
    // call site becomes `this.greet(who)`. (`announce` has an extra statement
    // so it isn't itself a single-statement target, keeping the match
    // one-directional.)
    const source = [
        "class Greeter {",
        '    label = "hi";',
        "    greet(name) {",
        "        return this.label + name.trim();",
        "    }",
        "    announce(who) {",
        '        console.log("start");',
        "        return this.label + who.trim();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 8 }]);
    assertEquals(result.changed, true);
    assert(
        result.source.includes("return this.greet(who);"),
        "expected a this.greet(who) call site (within-instance, this-safe)",
    );
});

Deno.test("function matcher: skips constructor in static method collection", async () => {
    const source = [
        "class Foo {",
        "    constructor(x) {",
        "        this.x = x;",
        "    }",
        "    static logX(x) {",
        "        console.log(x);",
        "    }",
        "}",
        "",
        "function run() {",
        "    console.log(val);",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 10, end: 11 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Foo.logX(val)"));
});

Deno.test("function matcher: algorithmic replacement for zero-arg static method", async () => {
    const source = [
        "class Config {",
        "    static getGreeting() {",
        '        return "Hello, World!";',
        "    }",
        "}",
        "",
        "function run() {",
        '    const msg = "Hello, World!";',
        "    console.log(msg);",
        "}",
    ].join("\n");

    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 9 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Config.getGreeting()"));
});

Deno.test("function matcher: skips generator static method", async () => {
    const source = [
        "class Foo {",
        "    static* generateItems(count) {",
        "        for (let i = 0; i < count; i++) { yield i; }",
        "    }",
        "}",
        "",
        "function run() {",
        "    for (let i = 0; i < 5; i++) { yield i; }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: skips empty body static method", async () => {
    const source = [
        "class Foo {",
        "    static noop() {}",
        "}",
        "",
        "function run() {",
        "    const x = 1;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: skips computed key static method", async () => {
    const source = [
        "const methodName = 'clean';",
        "class Foo {",
        "    static [methodName](s) {",
        "        return s.trim();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const result = input.trim();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 9 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: skips static method on anonymous class", async () => {
    const source = [
        "export default class {",
        "    static clean(s) {",
        "        return s.trim();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const result = input.trim();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: expression match inside class method body", async () => {
    const source = [
        "class Str {",
        "    static clean(s) {",
        "        return s.trim().toLowerCase();",
        "    }",
        "}",
        "",
        "class Processor {",
        "    run() {",
        "        const sanitized = input.trim().toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 8, end: 9 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Str.clean(input)"));
});

Deno.test("function matcher: skips static method with string literal key", async () => {
    const source = [
        "class Foo {",
        '    static "myMethod"(s) {',
        "        return s.trim();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const result = input.trim();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: expression search skips computed key class method", async () => {
    const source = [
        "class Foo {",
        "    static clean(s) {",
        "        return s.trim();",
        "    }",
        "    [computedMethod](s) {",
        "        const result = s.trim();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const result = input.trim();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 10, end: 11 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("Foo.clean(input)"));
});

Deno.test("function matcher: anonymous class method skipped in expression search", async () => {
    const source = [
        "function clean(s) {",
        "    return s.trim().toLowerCase();",
        "}",
        "",
        "export default class {",
        "    run() {",
        "        const sanitized = input.trim().toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 6, end: 7 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: retries on review rejection and succeeds on second attempt", async () => {
    const source = [
        "function sendGreeting(connection, mode) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    let callCount = 0;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(): Promise<string> {
            return "    sendGreeting(conn, 'default');\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            callCount++;
            if (callCount === 1) {
                return { accepted: false, feedback: "missing mode parameter" };
            }
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 9 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("sendGreeting(conn, 'default')"));
});

Deno.test("function matcher: retries on parse failure then succeeds via LLM", async () => {
    const source = [
        "function sendGreeting(connection, mode) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    let generateCount = 0;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(): Promise<string> {
            generateCount++;
            if (generateCount === 1) {
                return "}}}}INVALID";
            }
            return "    sendGreeting(conn, 'default');\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const logs: string[] = [];
    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 9 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, true);
    assert(result.source.includes("sendGreeting(conn, 'default')"));
    assert(logs.some((l) => l.includes("replacement didn't parse")));
    assert(logs.some((l) => l.includes("attempt 1/3")));
});

Deno.test("function matcher: gives up after retries exhausted", async () => {
    const source = [
        "function sendGreeting(connection, mode) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(): Promise<string> {
            return "}}}}INVALID";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: false, feedback: "bad" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const logs: string[] = [];
    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 9 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, false);
    assert(logs.some((l) => l.includes("attempt 1/3")));
    assert(logs.some((l) => l.includes("attempt 2/3")));
    assert(logs.some((l) => l.includes("attempt 3/3")));
});

Deno.test("function matcher: no retry when function_matcher_retries is 0", async () => {
    const noRetryConfig: Config = {
        ...testConfig,
        function_matcher_retries: 0,
    };
    const source = [
        "function sendGreeting(connection, mode) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(): Promise<string> {
            return "}}}}INVALID";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: false, feedback: "bad" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const logs: string[] = [];
    const matcher = createFunctionMatcher(noRetryConfig, llm);
    const result = await matcher(source, [{ start: 7, end: 9 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, false);
    assert(logs.some((l) => l.includes("attempt 1/1")));
    assert(!logs.some((l) => l.includes("attempt 2")));
});

Deno.test("function matcher: passes feedback to LLM on retry", async () => {
    const source = [
        "function sendGreeting(connection, mode) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const feedbacks: (string | undefined)[] = [];
    const _llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(
            _codeBlock: string,
            _funcName: string,
            _funcSource: string,
            _fileSource: string,
            previousFeedback?: string,
        ): Promise<string> {
            feedbacks.push(previousFeedback);
            return "    sendGreeting(conn, 'default');\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const logs: string[] = [];
    let reviewCallCount = 0;
    const llmWithReview: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(
            _codeBlock: string,
            _funcName: string,
            _funcSource: string,
            _fileSource: string,
            previousFeedback?: string,
        ): Promise<string> {
            feedbacks.push(previousFeedback);
            return "    sendGreeting(conn, 'default');\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            reviewCallCount++;
            if (reviewCallCount === 1) {
                return { accepted: false, feedback: "wrong indentation" };
            }
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const matcher = createFunctionMatcher(testConfig, llmWithReview);
    const result = await matcher(source, [{ start: 7, end: 9 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, true);
    assertEquals(feedbacks.length, 2);
    assertEquals(feedbacks[0], undefined);
    assertEquals(feedbacks[1], "wrong indentation");
});

Deno.test("function matcher: algo replacement uses LLM on retry after parse failure", async () => {
    const source = [
        "function getGreeting() {",
        '    return "Hello, World!";',
        "}",
        "",
        "function run() {",
        '    const msg = "Hello, World!";',
        "    console.log(msg);",
        "}",
    ].join("\n");

    let generateCalled = false;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(): Promise<string> {
            generateCalled = true;
            return "    return getGreeting();\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const noRetryConfig: Config = {
        ...testConfig,
        function_matcher_retries: 1,
    };
    const matcher = createFunctionMatcher(noRetryConfig, llm);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("getGreeting()"));
    assert(!generateCalled);
});

Deno.test("function matcher: algo replacement retries via LLM after review rejection", async () => {
    const source = [
        "function getGreeting() {",
        '        return "Hello, World!";',
        "}",
        "",
        "function run() {",
        '    const msg = "Hello, World!";',
        "    console.log(msg);",
        "}",
    ].join("\n");

    let generateCalled = false;
    let reviewCallCount = 0;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: true, reason: "test" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement(): Promise<string> {
            generateCalled = true;
            return "    const msg = getGreeting();\n";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            reviewCallCount++;
            if (reviewCallCount === 1) {
                return { accepted: false, feedback: "should use return" };
            }
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch() {
            return { isMatch: false, excludeIndices: [], reason: "" };
        },
        // deno-lint-ignore require-await
        async generateExtraction() {
            return { helperName: "", helperFunction: "", callSites: [] };
        },
    };

    const logs: string[] = [];
    const matcher = createFunctionMatcher(testConfig, llm);
    const result = await matcher(source, [{ start: 5, end: 7 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, true);
    assert(generateCalled);
    assert(logs.some((l) => l.includes("LLM review rejected")));
    assert(logs.some((l) => l.includes("attempt 1/3")));
    assert(logs.some((l) => l.includes("should use return")));
});

// ---------------------------------------------------------------------------
// Cross-file matching
// ---------------------------------------------------------------------------

const utilSource = [
    "export function sendGreeting(connection) {",
    '    connection.send("Hello,");',
    '    connection.send("I am from Earth.");',
    "}",
    "",
    "function notExported(x) {",
    '    console.log("private", x);',
    "}",
].join("\n");

function crossFileContext(
    files: Record<string, string>,
    currentPath = "/proj/a.ts",
): {
    filePath: string;
    readFile: (p: string) => Promise<string | null>;
    log: (m: string) => void;
    logs: string[];
} {
    const logs: string[] = [];
    return {
        filePath: currentPath,
        // deno-lint-ignore require-await
        readFile: async (p: string) => files[p] ?? null,
        log: (m: string) => {
            logs.push(m);
        },
        logs,
    };
}

Deno.test("function matcher: cross-file body match via named import", async () => {
    const source = [
        'import { sendGreeting } from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");

    const verifiedSources: string[] = [];
    const llm = mockLLM({});
    const capturingLLM: LLMClient = {
        ...llm,
        // deno-lint-ignore require-await
        async verifyFunctionMatch(_block: string, funcSource: string) {
            verifiedSources.push(funcSource);
            return { isMatch: true, reason: "test" };
        },
    };

    const context = crossFileContext({ "/proj/util.ts": utilSource });
    const matcher = createFunctionMatcher(testConfig, capturingLLM);
    const result = await matcher(source, [{ start: 4, end: 7 }], context);
    assertEquals(result.changed, true);
    assert(result.source.includes("sendGreeting(conn);"));
    assert(
        result.source.includes('import { sendGreeting } from "./util";'),
        "import must be left untouched",
    );
    assert(
        result.description.includes("(imported from ./util)"),
        "description should note the import origin",
    );
    assert(context.logs.some((l) => l.includes("callable function(s)")));
    assert(
        verifiedSources[0].includes("// imported from ./util"),
        "LLM should see the import provenance header",
    );
    assert(
        verifiedSources[0].includes('connection.send("I am from Earth.");'),
        "LLM should see the target function source from the other file",
    );
});

Deno.test("function matcher: cross-file match uses aliased import binding", async () => {
    const source = [
        'import { sendGreeting as greet } from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 7 }],
        crossFileContext({ "/proj/util.ts": utilSource }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("greet(conn);"));
});

Deno.test("function matcher: cross-file match via namespace import", async () => {
    const source = [
        'import * as util from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 7 }],
        crossFileContext({ "/proj/util.ts": utilSource }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("util.sendGreeting(conn);"));
});

Deno.test("function matcher: cross-file match via default import", async () => {
    const target = [
        "export default function sendGreeting(connection) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
    ].join("\n");
    const source = [
        'import greet from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 7 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("greet(conn);"));
});

Deno.test("function matcher: cross-file expression match", async () => {
    const target = [
        "export function double(n) {",
        "    return n * 2;",
        "}",
    ].join("\n");
    const source = [
        'import { double } from "./util";',
        "",
        "function run() {",
        "    const result = count * 2;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 4 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("const result = double(count);"));
});

Deno.test("function matcher: cross-file static method via named class import", async () => {
    const target = [
        "export class Str {",
        "    static clean(s) {",
        "        return s.trim().toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const source = [
        'import { Str } from "./util";',
        "",
        "function run() {",
        "    const sanitized = input.trim().toLowerCase();",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 4 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("const sanitized = Str.clean(input);"));
});

Deno.test("function matcher: cross-file pure instance method via in-scope ref", async () => {
    const target = [
        "export class Scorer {",
        "    bonus(points) {",
        "        return points * 2;",
        "    }",
        "}",
    ].join("\n");
    const source = [
        'import { Scorer } from "./util";',
        "",
        "function run() {",
        "    const s = new Scorer();",
        "    const extra = p * 2;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 5, end: 5 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("const extra = s.bonus(p);"));
});

Deno.test("function matcher: cross-file this-using instance method never matched", async () => {
    const target = [
        "export class Formatter {",
        '    prefix = ">>";',
        "    clean(s) {",
        "        return this.prefix + s.trim();",
        "    }",
        "}",
    ].join("\n");
    const source = [
        'import { Formatter } from "./util";',
        "",
        "class Report {",
        '    prefix = "<<";',
        "    process(fmt: Formatter, input) {",
        "        return this.prefix + input.trim();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 6, end: 6 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, false);
});

Deno.test("function matcher: cross-file pure instance method not matched via this", async () => {
    // The current file's class is named identically to the imported class,
    // but it is a different class: `this.clean(...)` would dispatch to the
    // local Report.clean (undefined), so the cross-file target must not be
    // resolved through the same-class branch.
    const target = [
        "export class Formatter {",
        "    clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const source = [
        'import { Formatter as Other } from "./util";',
        "",
        "class Formatter {",
        "    process(input) {",
        "        const sanitized = input.trim();",
        "        return sanitized.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 5, end: 6 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, false);
});

Deno.test("function matcher: no match without an existing import edge (no new imports)", async () => {
    // The identical function exists in util.ts, but a.ts does not import it.
    // dripbird must not add an import — that could create a circular
    // dependency — so there is no match.
    const source = [
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 2, end: 4 }],
        crossFileContext({ "/proj/util.ts": utilSource }),
    );
    assertEquals(result.changed, false);
    assert(!result.source.includes("import"));
});

Deno.test("function matcher: type-only imports are not callable bindings", async () => {
    const source = [
        'import type { sendGreeting } from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 6 }],
        crossFileContext({ "/proj/util.ts": utilSource }),
    );
    assertEquals(result.changed, false);
});

Deno.test("function matcher: non-exported imported functions are not candidates", async () => {
    const source = [
        'import { other } from "./util";',
        "",
        "function run() {",
        '    console.log("private", value);',
        "}",
    ].join("\n");
    const target = utilSource + "\nexport const other = 1;\n";
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 4 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, false);
});

Deno.test("function matcher: unresolved import is skipped with a log", async () => {
    const source = [
        'import { sendGreeting } from "./missing";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const context = crossFileContext({ "/proj/util.ts": utilSource });
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 4, end: 6 }], context);
    assertEquals(result.changed, false);
    assert(
        context.logs.some((l) => l.includes("could not resolve import ./missing")),
    );
});

Deno.test("function matcher: unparseable imported file is skipped with a log", async () => {
    const source = [
        'import { sendGreeting } from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const context = crossFileContext({
        "/proj/util.ts": "function broken( {{{ invalid",
    });
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 4, end: 6 }], context);
    assertEquals(result.changed, false);
    assert(
        context.logs.some((l) => l.includes("could not parse import ./util")),
    );
});

Deno.test("function matcher: local function preferred over identical imported one", async () => {
    const target = [
        "export function double(n) {",
        "    return n * 2;",
        "}",
    ].join("\n");
    const source = [
        'import { double as d2 } from "./util";',
        "",
        "function double(n) {",
        "    return n * 2;",
        "}",
        "",
        "function run() {",
        "    const result = count * 2;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 8, end: 8 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("const result = double(count);"));
    assert(!result.source.includes("d2(count)"));
});

Deno.test("function matcher: imported function with the enclosing scope's name is not self-skipped", async () => {
    // The duplicate lives in `run`, and the imported target is also named
    // `run` (bound locally as `step`). A different file's `run` can never be
    // the same function, so the self-skip must not apply.
    const target = [
        "export function run(connection) {",
        '    connection.send("Hello,");',
        '    connection.send("I am from Earth.");',
        "}",
    ].join("\n");
    const source = [
        'import { run as step } from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(
        source,
        [{ start: 4, end: 6 }],
        crossFileContext({ "/proj/util.ts": target }),
    );
    assertEquals(result.changed, true);
    assert(result.source.includes("step(conn);"));
});

Deno.test("function matcher: cross-file disabled without readFile in context", async () => {
    const source = [
        'import { sendGreeting } from "./util";',
        "",
        "function run() {",
        "    const conn = getConnection();",
        '    conn.send("Hello,");',
        '    conn.send("I am from Earth.");',
        "}",
    ].join("\n");
    const logs: string[] = [];
    const matcher = createFunctionMatcher(testConfig, acceptAll);
    const result = await matcher(source, [{ start: 4, end: 6 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, false);
    assert(logs.some((l) => l.includes("found 1 function(s)")));
});
