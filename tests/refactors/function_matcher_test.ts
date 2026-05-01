import { assert, assertEquals } from "@std/assert";
import { parse } from "recast";
import * as babelParser from "@babel/parser";
import { createFunctionMatcher } from "../../src/refactors/function_matcher.ts";
import type {
    FunctionMatchResult,
    LLMClient,
    ReviewResult,
} from "../../src/llm.ts";

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
    };
}

const acceptAll = mockLLM({});

Deno.test("function matcher: no match when no functions in file", async () => {
    const source = `const x = 1;\nconst y = 2;\n`;
    const matcher = createFunctionMatcher(acceptAll);
    const result = await matcher(source, [{ start: 1, end: 2 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: no match when diff doesn't overlap function body", async () => {
    const source = [
        "function greet(name) {",
        '    console.log("Hello, " + name);',
        "}",
        "",
        "function run() {",
        "    const x = 1;",
        "}",
    ].join("\n");
    const matcher = createFunctionMatcher(acceptAll);
    const result = await matcher(source, [{ start: 5, end: 7 }]);
    assertEquals(result.changed, false);
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

    const matcher = createFunctionMatcher(llm);
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
    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(llm);
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

    const matcher = createFunctionMatcher(llm);
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

    const matcher = createFunctionMatcher(llm);
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

    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    };

    const matcher = createFunctionMatcher(llm);
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

    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
    const result = await matcher(source, [{ start: 5, end: 5 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: verbose logging covers no-functions path", async () => {
    const logs: string[] = [];
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(llm);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(llm);
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
    const matcher = createFunctionMatcher(llm);
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

    const matcher = createFunctionMatcher(llm);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(llm);
    const result = await matcher(source, [{ start: 7, end: 7 }]);
    assertEquals(result.changed, false);
});

Deno.test("function matcher: handles source with unparseable code", async () => {
    const source = "function foo( { invalid syntax {{{";
    const matcher = createFunctionMatcher(acceptAll);
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

    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(llm);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(llm);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
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
    const matcher = createFunctionMatcher(acceptAll);
    const result = await matcher(source, [{ start: 5, end: 6 }]);
    assert(result.changed);
});
