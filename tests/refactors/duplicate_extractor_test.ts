import { assert, assertEquals } from "@std/assert";
import { parse as recastParse } from "recast";
import * as babelParser from "@babel/parser";
import {
    collectSequences,
    computeExtractionTarget,
    createDuplicateExtractor,
    findDuplicateGroups,
    insertMethodIntoClass,
    reindentBlock,
} from "../../src/refactors/duplicate_extractor.ts";
import type { SeqInfo } from "../../src/refactors/duplicate_extractor.ts";
import type {
    DuplicateVerifyResult,
    ExtractionResult,
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
    verifyResult?: DuplicateVerifyResult;
    extraction?: ExtractionResult;
    reviewResult?: ReviewResult;
}): LLMClient {
    return {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: false, reason: "mock" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement() {
            return "";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return options.reviewResult ?? {
                accepted: true,
                feedback: "",
            };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch(): Promise<DuplicateVerifyResult> {
            return options.verifyResult ?? {
                isMatch: true,
                excludeIndices: [],
                reason: "test",
            };
        },
        // deno-lint-ignore require-await
        async generateExtraction(): Promise<ExtractionResult> {
            return options.extraction ?? {
                helperName: "extractedHelper",
                helperFunction: "function extractedHelper() {}\n",
                callSites: ["    extractedHelper();\n", "    extractedHelper();\n"],
            };
        },
    };
}

const acceptAll = mockLLM({});

Deno.test("duplicate extractor: no duplicates when no functions", async () => {
    const source = `const x = 1;\nconst y = 2;\n`;
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 1, end: 2 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: no duplicates with single function", async () => {
    const source = [
        "function foo() {",
        "    const a = 1;",
        "    const b = 2;",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 1, end: 4 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: detects identical blocks across functions", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) {\n    console.log('result:', val);\n}\n",
            callSites: [
                "    const x = getValue();\n    logResult(x);\n",
                "    const y = getValue();\n    logResult(y);\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logResult"));
});

Deno.test("duplicate extractor: skips when LLM verification rejects", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        verifyResult: {
            isMatch: false,
            excludeIndices: [],
            reason: "not semantically equivalent",
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips when LLM review rejects", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        reviewResult: {
            accepted: false,
            feedback: "wrong indentation",
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips when no blocks overlap diff range", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 5, end: 5 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: filters out excluded blocks", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
        "",
        "function baz() {",
        "    const z = getOther();",
        '    console.log("other:", z);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        verifyResult: {
            isMatch: true,
            excludeIndices: [2],
            reason: "third block is different",
        },
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) {\n    console.log('result:', val);\n}\n",
            callSites: [
                "    const x = getValue();\n    logResult(x);\n",
                "    const y = getValue();\n    logResult(y);\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logResult"));
});

Deno.test("duplicate extractor: skips extraction with call site count mismatch", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) {\n    console.log('result:', val);\n}\n",
            callSites: ["    logResult(x);\n"],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips when generated code doesn't parse", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "badFunc",
            helperFunction: "INVALID {{{\n",
            callSites: ["    INVALID\n", "    INVALID\n"],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: respects min_lines config", async () => {
    const minLinesConfig = {
        ...testConfig,
        duplicate_extractor_min_lines: 5,
    };

    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(minLinesConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: respects max_lines config", async () => {
    const maxLinesConfig = {
        ...testConfig,
        duplicate_extractor_max_lines: 1,
    };

    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(maxLinesConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips async functions", async () => {
    const source = [
        "async function foo() {",
        "    const x = await getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "async function bar() {",
        "    const y = await getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips generator functions", async () => {
    const source = [
        "function* foo() {",
        "    const x = getValue();",
        "    yield x;",
        "}",
        "",
        "function* bar() {",
        "    const y = getValue();",
        "    yield y;",
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: handles unparseable source", async () => {
    const source = "function foo( { invalid syntax {{{";
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 1, end: 1 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: verbose logging covers no-sequences path", async () => {
    const logs: string[] = [];
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    await extractor("const x = 1;", [{ start: 1, end: 1 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("no sequences collected")));
});

Deno.test("duplicate extractor: verbose logging covers no-groups path", async () => {
    const logs: string[] = [];
    const source = [
        "function foo() {",
        "    const x = 1;",
        "    const y = 2;",
        "}",
        "",
        "function bar() {",
        "    const a = getValue();",
        "    const b = transform(a);",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    await extractor(source, [{ start: 1, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("no duplicate groups")));
});

Deno.test("duplicate extractor: verbose logging covers candidate and acceptance", async () => {
    const logs: string[] = [];
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) {\n    console.log('result:', val);\n}\n",
            callSites: [
                "    const x = getValue();\n    logResult(x);\n",
                "    const y = getValue();\n    logResult(y);\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("duplicate group(s) found")));
    assert(logs.some((l) => l.includes("candidate group")));
});

Deno.test("duplicate extractor: verbose logging covers LLM rejection", async () => {
    const logs: string[] = [];
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        verifyResult: {
            isMatch: false,
            excludeIndices: [],
            reason: "different behavior",
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("LLM rejected group")));
    assert(logs.some((l) => l.includes("different behavior")));
});

Deno.test("duplicate extractor: verbose logging covers review rejection", async () => {
    const logs: string[] = [];
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        reviewResult: {
            accepted: false,
            feedback: "wrong semantics",
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("LLM review rejected")));
    assert(logs.some((l) => l.includes("wrong semantics")));
});

Deno.test("duplicate extractor: verbose logging covers parse failure", async () => {
    const logs: string[] = [];
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "badFunc",
            helperFunction: "INVALID {{{\n",
            callSites: ["    INVALID\n", "    INVALID\n"],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assert(logs.some((l) => l.includes("result didn't parse")));
});

Deno.test("duplicate extractor: retries on review rejection then succeeds", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    let reviewCount = 0;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: false, reason: "" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement() {
            return "";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            reviewCount++;
            if (reviewCount === 1) {
                return { accepted: false, feedback: "missing return" };
            }
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch(): Promise<DuplicateVerifyResult> {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateExtraction(): Promise<ExtractionResult> {
            return {
                helperName: "logResult",
                helperFunction:
                    "function logResult(val) {\n    console.log('result:', val);\n}\n",
                callSites: [
                    "    const x = getValue();\n    logResult(x);\n",
                    "    const y = getValue();\n    logResult(y);\n",
                ],
            };
        },
    };

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logResult"));
});

Deno.test("duplicate extractor: gives up after retries exhausted", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: false, reason: "" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement() {
            return "";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: false, feedback: "always bad" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch(): Promise<DuplicateVerifyResult> {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateExtraction(): Promise<ExtractionResult> {
            return {
                helperName: "bad",
                helperFunction: "INVALID {{{\n",
                callSites: ["INVALID\n", "INVALID\n"],
            };
        },
    };

    const logs: string[] = [];
    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, false);
    assert(logs.some((l) => l.includes("attempt 1/3")));
    assert(logs.some((l) => l.includes("attempt 3/3")));
});

Deno.test("duplicate extractor: no retry when retries is 0", async () => {
    const noRetryConfig = {
        ...testConfig,
        duplicate_extractor_retries: 0,
    };

    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: false, reason: "" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement() {
            return "";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: false, feedback: "bad" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch(): Promise<DuplicateVerifyResult> {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateExtraction(): Promise<ExtractionResult> {
            return {
                helperName: "bad",
                helperFunction: "INVALID {{{\n",
                callSites: ["INVALID\n", "INVALID\n"],
            };
        },
    };

    const logs: string[] = [];
    const extractor = createDuplicateExtractor(noRetryConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, false);
    assert(logs.some((l) => l.includes("attempt 1/1")));
    assert(!logs.some((l) => l.includes("attempt 2")));
});

Deno.test("duplicate extractor: matches identical blocks in static methods", async () => {
    const source = [
        "class Foo {",
        "    static process() {",
        "        const x = getValue();",
        '        console.log("result:", x);',
        "    }",
        "}",
        "",
        "class Bar {",
        "    static handle() {",
        "        const y = getValue();",
        '        console.log("result:", y);',
        "    }",
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) {\n    console.log('result:', val);\n}\n",
            callSites: [
                "        const x = getValue();\n        logResult(x);\n",
                "        const y = getValue();\n        logResult(y);\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 9, end: 11 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logResult"));
});

Deno.test("duplicate extractor: normalizes call site indentation from LLM", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) {\n    console.log('result:', val);\n}\n",
            callSites: [
                "const x = getValue();\nlogResult(x);\n",
                "const y = getValue();\nlogResult(y);\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("    const x = getValue();"));
    assert(result.source.includes("    logResult(x);"));
});

Deno.test("duplicate extractor: no match for single-line blocks when min_lines is 2", async () => {
    const source = [
        "function foo() {",
        '    console.log("hello");',
        "}",
        "",
        "function bar() {",
        '    console.log("hello");',
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: detects multi-statement duplicates", async () => {
    const source = [
        "function foo() {",
        "    const x = getData();",
        "    const y = transform(x);",
        "    return y;",
        "}",
        "",
        "function bar() {",
        "    const a = getData();",
        "    const b = transform(a);",
        "    return b;",
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "getAndTransform",
            helperFunction:
                "function getAndTransform() {\n    const val = getData();\n    return transform(val);\n}\n",
            callSites: [
                "    return getAndTransform();\n",
                "    return getAndTransform();\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 7, end: 10 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("getAndTransform"));
});

Deno.test("duplicate extractor: skips overlapping claimed ranges", async () => {
    const source = [
        "function foo() {",
        "    const x = getData();",
        "    const y = transform(x);",
        "    return y;",
        "}",
        "",
        "function bar() {",
        "    const a = getData();",
        "    const b = transform(a);",
        "    return b;",
        "}",
    ].join("\n");

    let extractionCount = 0;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: false, reason: "" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement() {
            return "";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch(): Promise<DuplicateVerifyResult> {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateExtraction(): Promise<ExtractionResult> {
            extractionCount++;
            return {
                helperName: `helper${extractionCount}`,
                helperFunction: `function helper${extractionCount}() {}\n`,
                callSites: [
                    "    helper" + `${extractionCount}();\n`,
                    "    helper" + `${extractionCount}();\n`,
                ],
            };
        },
    };

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 1, end: 10 }]);
    assertEquals(result.changed, true);
});

Deno.test("duplicate extractor: passes feedback on retry", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const feedbacks: (string | undefined)[] = [];
    let reviewCount = 0;
    const llm: LLMClient = {
        // deno-lint-ignore require-await
        async nameFunction() {
            return "mock";
        },
        // deno-lint-ignore require-await
        async verifyFunctionMatch() {
            return { isMatch: false, reason: "" };
        },
        // deno-lint-ignore require-await
        async generateCallReplacement() {
            return "";
        },
        // deno-lint-ignore require-await
        async reviewChange(): Promise<ReviewResult> {
            reviewCount++;
            if (reviewCount === 1) {
                return { accepted: false, feedback: "missing param" };
            }
            return { accepted: true, feedback: "" };
        },
        // deno-lint-ignore require-await
        async verifyDuplicateMatch(): Promise<DuplicateVerifyResult> {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateExtraction(
            _blocks: string[],
            _file: string,
            _forbidden: string[],
            previousFeedback?: string,
        ): Promise<ExtractionResult> {
            feedbacks.push(previousFeedback);
            return {
                helperName: "logResult",
                helperFunction:
                    "function logResult(val) {\n    console.log('result:', val);\n}\n",
                callSites: [
                    "    const x = getValue();\n    logResult(x);\n",
                    "    const y = getValue();\n    logResult(y);\n",
                ],
            };
        },
    };

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assertEquals(feedbacks.length, 2);
    assertEquals(feedbacks[0], undefined);
    assertEquals(feedbacks[1], "missing param");
});

Deno.test("duplicate extractor: instance methods without this extract to a top-level function", async () => {
    const source = [
        "class Foo {",
        "    process() {",
        "        const x = getValue();",
        '        console.log("result:", x);',
        "    }",
        "}",
        "",
        "class Bar {",
        "    handle() {",
        "        const y = getValue();",
        '        console.log("result:", y);',
        "    }",
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 9, end: 11 }]);
    assertEquals(result.changed, true);
    // No `this` in the blocks -> helper is a top-level function, not a method.
    assert(result.source.includes("function extractedHelper"));
});

Deno.test("duplicate extractor: extracts duplicate code into an instance method", async () => {
    const source = [
        "class Logger {",
        "    prefix: string;",
        "    logOrder(id: string) {",
        "        const entry = `[${this.prefix}] ${id}`;",
        "        console.log(entry);",
        "    }",
        "    logPayment(id: string) {",
        "        const entry = `[${this.prefix}] ${id}`;",
        "        console.log(entry);",
        "    }",
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "formatEntry",
            helperFunction:
                "formatEntry(id: string): string {\n    return `[${this.prefix}] ${id}`;\n}\n",
            callSites: [
                "        const entry = this.formatEntry(id);\n        console.log(entry);\n",
                "        const entry = this.formatEntry(id);\n        console.log(entry);\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    // Helper placed inside the class body as a method, not appended at file end.
    const classEnd = result.source.lastIndexOf("}");
    const helperIdx = result.source.indexOf("formatEntry(id: string): string");
    assert(helperIdx > -1, "helper method should be present");
    assert(helperIdx < classEnd, "helper should be inside the class body");
    assert(
        result.source.includes("this.formatEntry(id)"),
        "call sites should use this.helper",
    );
    assert(
        !/\nfunction formatEntry/.test(result.source),
        "should not emit a top-level function declaration",
    );
});

Deno.test("duplicate extractor: skips this-using blocks across different classes", async () => {
    const source = [
        "class Foo {",
        "    prefix: string;",
        "    run() {",
        "        const x = `[${this.prefix}]`;",
        "        console.log(x);",
        "    }",
        "}",
        "",
        "class Bar {",
        "    prefix: string;",
        "    run() {",
        "        const y = `[${this.prefix}]`;",
        "        console.log(y);",
        "    }",
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 3, end: 5 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips this-using block mixed with a free function", async () => {
    const source = [
        "class Foo {",
        "    prefix: string;",
        "    run() {",
        "        const x = `[${this.prefix}]`;",
        "        console.log(x);",
        "    }",
        "}",
        "",
        "function helper() {",
        "        const x = `[default]`;",
        "        console.log(x);",
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 3, end: 5 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: computeExtractionTarget picks function when no this", () => {
    const stmts = babelParser.parse("const x = 1;\nconsole.log(x);", {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    }).program.body;
    const seqs: SeqInfo[] = [
        {
            statements: stmts,
            startLine: 3,
            endLine: 5,
            source: "",
            fingerprint: "a",
            scope: "foo",
            kind: "function",
        },
        {
            statements: stmts,
            startLine: 7,
            endLine: 9,
            source: "",
            fingerprint: "a",
            scope: "bar",
            kind: "method",
            isStatic: false,
            className: "Foo",
        },
    ];
    assertEquals(computeExtractionTarget(seqs), { kind: "function" });
});

Deno.test("duplicate extractor: computeExtractionTarget picks instance method for same-class this-using blocks", () => {
    const stmts = babelParser.parse("const x = this.prefix;", {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    }).program.body;
    const seqs: SeqInfo[] = [
        {
            statements: stmts,
            startLine: 3,
            endLine: 5,
            source: "",
            fingerprint: "a",
            scope: "Logger.logOrder",
            kind: "method",
            isStatic: false,
            className: "Logger",
        },
        {
            statements: stmts,
            startLine: 7,
            endLine: 9,
            source: "",
            fingerprint: "a",
            scope: "Logger.logPayment",
            kind: "method",
            isStatic: false,
            className: "Logger",
        },
    ];
    assertEquals(
        computeExtractionTarget(seqs),
        { kind: "instanceMethod", className: "Logger" },
    );
});

Deno.test("duplicate extractor: computeExtractionTarget returns null for this-using blocks across classes", () => {
    const stmts = babelParser.parse("const x = this.prefix;", {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    }).program.body;
    const seqs: SeqInfo[] = [
        {
            statements: stmts,
            startLine: 3,
            endLine: 5,
            source: "",
            fingerprint: "a",
            scope: "Foo.run",
            kind: "method",
            isStatic: false,
            className: "Foo",
        },
        {
            statements: stmts,
            startLine: 7,
            endLine: 9,
            source: "",
            fingerprint: "a",
            scope: "Bar.run",
            kind: "method",
            isStatic: false,
            className: "Bar",
        },
    ];
    assertEquals(computeExtractionTarget(seqs), null);
});

Deno.test("duplicate extractor: insertMethodIntoClass places method inside the class", () => {
    const source = [
        "class Foo {",
        "    run() {",
        "        this.work();",
        "    }",
        "}",
    ].join("\n");
    const method = "helper() {\n    return this.work();\n}";
    const result = insertMethodIntoClass(source, "Foo", method);
    assert(result !== null);
    const lines = result!.split("\n");
    // Method inserted before the class closing brace.
    assertEquals(lines[lines.length - 1], "}");
    assertEquals(lines[lines.length - 2], "    }");
    assertEquals(lines[lines.length - 3], "        return this.work();");
    assertEquals(lines[lines.length - 4], "    helper() {");
});

Deno.test("duplicate extractor: insertMethodIntoClass returns null when class is missing", () => {
    const source = "class Foo { run() {} }\n";
    assertEquals(insertMethodIntoClass(source, "Bar", "helper() {}"), null);
});

Deno.test("duplicate extractor: insertMethodIntoClass returns null on unparseable source", () => {
    assertEquals(
        insertMethodIntoClass("class Foo {{{{", "Foo", "helper() {}"),
        null,
    );
});

Deno.test("duplicate extractor: reindentBlock handles blank, base, and mixed-indent lines", () => {
    // Blank lines pass through as empty.
    const blank = reindentBlock("foo()\n\nbar()", "    ");
    assertEquals(blank, "    foo()\n\n    bar()");

    // Common base indent is stripped then target applied, preserving depth.
    const indented = reindentBlock("    foo()\n        body()", "    ");
    assertEquals(indented, "    foo()\n        body()");

    // Mixed indentation (tab vs spaces): the detected base is the shorter run,
    // so a line that does not start with it is trimmed before re-indenting.
    const mixed = reindentBlock("  foo()\n\tbar()", "    ");
    assertEquals(mixed, "    foo()\n    bar()");
});

Deno.test("duplicate extractor: retries when instance-method placement fails to parse", async () => {
    const source = [
        "class Logger {",
        "    prefix: string;",
        "    logOrder(id: string) {",
        "        const entry = `[${this.prefix}] ${id}`;",
        "        console.log(entry);",
        "    }",
        "    logPayment(id: string) {",
        "        const entry = `[${this.prefix}] ${id}`;",
        "        console.log(entry);",
        "    }",
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "formatEntry",
            // Valid method text, but the call sites corrupt the source so it
            // won't parse after the text edits -> insertMethodIntoClass's
            // internal parse throws -> returns null -> retry feedback loop.
            helperFunction:
                "formatEntry(id: string): string {\n    return `[${this.prefix}] ${id}`;\n}\n",
            callSites: [
                "        this.formatEntry(id); {{\n",
                "        this.formatEntry(id); {{\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    // Every attempt fails placement; nothing is applied.
    assertEquals(result.changed, false);
    assert(!result.source.includes("formatEntry"));
});

Deno.test("duplicate extractor: skips empty function bodies", async () => {
    const source = [
        "function foo() {}",
        "",
        "function bar() {}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 1, end: 3 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: handles anonymous function declarations", async () => {
    const source = [
        "export default function() {",
        "    const x = 1;",
        "}",
    ].join("\n");

    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 1, end: 3 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: covers isPropertyContext ObjectProperty shorthand", async () => {
    const source = [
        "function foo(a) {",
        "    const obj = { name: a };",
        "    return obj;",
        "}",
        "",
        "function bar() {",
        "    const obj = { name: b };",
        "    return obj;",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: covers isPropertyContext ObjectMethod", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: covers isPropertyContext ClassMethod", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: covers isPropertyContext LabeledStatement", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: covers FunctionDeclaration skip in processBody", async () => {
    const source = [
        "function foo(a) {",
        "    function helper() {}",
        "    const x = a + 1;",
        "    const y = a + 2;",
        "    return x + y;",
        "}",
        "",
        "function bar() {",
        "    function helper() {}",
        "    const x = b + 1;",
        "    const y = b + 2;",
        "    return x + y;",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 8, end: 12 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: covers visitFunctionExpression guard", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: covers visitArrowFunctionExpression guard", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: skips constructor in collectSequences", async () => {
    const source = [
        "class Foo {",
        "    constructor(x) {",
        "        this.x = x;",
        "    }",
        "    static logX(x) {",
        "        console.log(x);",
        "        return x;",
        "    }",
        "}",
        "",
        "function run() {",
        "    console.log(val);",
        "    return val;",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 11, end: 13 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: skips async static method in collectSequences", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips generator static method in collectSequences", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips empty body static method in collectSequences", async () => {
    const source = [
        "class Foo {",
        "    static noop() {}",
        "}",
        "",
        "function run() {",
        "    const x = 1;",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 5, end: 6 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips computed key static method in collectSequences", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 8, end: 9 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: skips static method on anonymous class in collectSequences", async () => {
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
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: exclusion leaves too few blocks", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
        "",
        "function baz() {",
        "    const z = getValue();",
        '    console.log("result:", z);',
        "}",
    ].join("\n");

    const logs: string[] = [];
    const llm = mockLLM({
        verifyResult: {
            isMatch: true,
            excludeIndices: [0, 1, 2],
            reason: "none match",
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, false);
    assert(logs.some((l) => l.includes("too few blocks after exclusion")));
});

Deno.test("duplicate extractor: exclusion with some remaining blocks", async () => {
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
        "",
        "function baz() {",
        "    const z = getOther();",
        '    console.log("other:", z);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        verifyResult: {
            isMatch: true,
            excludeIndices: [2],
            reason: "third block is different",
        },
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) {\n    console.log('result:', val);\n}\n",
            callSites: [
                "    const x = getValue();\n    logResult(x);\n",
                "    const y = getValue();\n    logResult(y);\n",
            ],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("logResult"));
});

Deno.test("duplicate extractor: covers non-static class method in collectSequences visitor", async () => {
    const source = [
        "class Foo {",
        "    process(input) {",
        "        const sanitized = input.trim().toLowerCase();",
        "    }",
        "}",
        "",
        "function run() {",
        "    const x = 1;",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 7, end: 8 }]);
    assertEquals(result.changed, false);
});

Deno.test("duplicate extractor: static method body matches another static method", async () => {
    const source = [
        "class Processor {",
        "    static clean(s) {",
        "        const trimmed = s.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "",
        "    static process(input) {",
        "        const trimmed = input.trim();",
        "        return trimmed.toLowerCase();",
        "    }",
        "}",
    ].join("\n");
    const extractor = createDuplicateExtractor(testConfig, acceptAll);
    const result = await extractor(source, [{ start: 7, end: 9 }]);
    assertEquals(result.changed, true);
    assert(result.source.includes("extractedHelper"));
});

Deno.test("duplicate extractor: verbose logging covers call site mismatch", async () => {
    const logs: string[] = [];
    const source = [
        "function foo() {",
        "    const x = getValue();",
        '    console.log("result:", x);',
        "}",
        "",
        "function bar() {",
        "    const y = getValue();",
        '    console.log("result:", y);',
        "}",
    ].join("\n");

    const llm = mockLLM({
        extraction: {
            helperName: "logResult",
            helperFunction:
                "function logResult(val) { console.log('result:', val); }\n",
            callSites: ["    logResult(x);\n"],
        },
    });

    const extractor = createDuplicateExtractor(testConfig, llm);
    const result = await extractor(source, [{ start: 6, end: 8 }], {
        filePath: "test.ts",
        log: (msg) => logs.push(msg),
    });
    assertEquals(result.changed, false);
    assert(logs.some((l) => l.includes("call sites count mismatch")));
});

Deno.test("collectSequences skips statements without loc", () => {
    const source = [
        "function foo() {",
        "    const x = 1;",
        "    const y = 2;",
        "}",
    ].join("\n");
    const ast = recastParse(source, {
        parser: {
            parse(code: string) {
                return babelParser.parse(code, {
                    sourceType: "module",
                    plugins: ["typescript", "jsx"],
                });
            },
        },
    });
    const body = ast.program.body[0].body.body;
    body.splice(1, 0, { type: "EmptyStatement" });
    const sourceLines = source.split("\n");
    const seqs = collectSequences(ast, sourceLines, 2, 12);
    assert(seqs.length > 0);
    for (const seq of seqs) {
        assert(seq.startLine >= 1);
    }
});

Deno.test("findDuplicateGroups skips groups with all sequences at same location", () => {
    const seqs: SeqInfo[] = [
        {
            statements: [],
            startLine: 2,
            endLine: 3,
            source: "const x = 1;",
            fingerprint: "fp_a",
            scope: "foo",
            kind: "function",
        },
        {
            statements: [],
            startLine: 2,
            endLine: 3,
            source: "const x = 1;",
            fingerprint: "fp_a",
            scope: "bar",
            kind: "function",
        },
    ];
    const ranges = [{ start: 1, end: 5 }];
    const groups = findDuplicateGroups(seqs, ranges);
    assertEquals(groups.length, 0);
});
