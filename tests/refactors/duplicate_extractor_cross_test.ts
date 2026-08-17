import { assert, assertEquals } from "@std/assert";
import * as BABEL from "@babel/parser";
import type {
    DuplicateVerifyResult,
    ExtractionResult,
    LLMClient,
    ReviewResult,
} from "../../src/llm.ts";
import {
    createCrossFileDuplicateExtractor,
    findCrossFileDuplicateGroups,
    gateCrossFileGroups,
    insertImport,
    resolveLocalBinding,
    resolveModulePath,
    sharedDirCandidates,
} from "../../src/refactors/duplicate_extractor_cross.ts";
import type { Config } from "../../src/config.ts";
import { TypeCheckerImpl } from "../../src/type_checker.ts";

const testConfig: Config = {
    max_function_lines: 75,
    function_splitter_retries: 2,
    function_matcher_retries: 2,
    duplicate_extractor_min_lines: 2,
    duplicate_extractor_max_lines: 12,
    duplicate_extractor_retries: 2,
    duplicate_extractor_shared_dir: "common",
    duplicate_extractor_cross_file: true,
    provider: "moonshot",
    model: "kimi-k2.5",
    enabled_refactors: [],
    disabled_refactors: [],
    verbose: false,
};

const ALL_LINES = [{ start: 1, end: 1000 }];

function filesOf(
    entries: Array<
        {
            file: string;
            source: string;
            ranges?: Array<{ start: number; end: number }>;
        }
    >,
) {
    return entries.map((e) => ({
        file: e.file,
        source: e.source,
        ranges: e.ranges ?? ALL_LINES,
    }));
}

const sourceA = [
    "function alpha(user) {",
    "    const line = `Hi ${user}`;",
    "    logger.log(line);",
    "}",
].join("\n");

// Same statements, different identifiers: identical AST fingerprint.
const sourceB = [
    "function greetCustomer(name) {",
    "    const entry = `Hi ${name}`;",
    "    logger.log(entry);",
    "}",
].join("\n");

Deno.test("findCrossFileDuplicateGroups groups blocks across files", () => {
    const groups = findCrossFileDuplicateGroups(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        2,
        12,
    );

    assertEquals(groups.length, 1);
    const files = new Set(groups[0].blocks.map((b) => b.file));
    assertEquals(files.size, 2);
    assert(files.has("a.ts"));
    assert(files.has("b.ts"));
});

Deno.test("findCrossFileDuplicateGroups requires two distinct files", () => {
    const source = [
        "function one() {",
        "    const line = `Hi ${x}`;",
        "    logger.log(line);",
        "}",
        "",
        "function two() {",
        "    const entry = `Hi ${y}`;",
        "    logger.log(entry);",
        "}",
    ].join("\n");

    const groups = findCrossFileDuplicateGroups(
        filesOf([{ file: "a.ts", source }]),
        2,
        12,
    );

    // Within one file, cross-file detection reports nothing: that is the
    // single-file extractor's job.
    assertEquals(groups.length, 0);
});

Deno.test("findCrossFileDuplicateGroups requires diff overlap", () => {
    const groups = findCrossFileDuplicateGroups(
        filesOf([
            { file: "a.ts", source: sourceA, ranges: [{ start: 99, end: 100 }] },
            { file: "b.ts", source: sourceB, ranges: [{ start: 99, end: 100 }] },
        ]),
        2,
        12,
    );

    assertEquals(groups.length, 0);
});

Deno.test("findCrossFileDuplicateGroups needs overlap in only one file", () => {
    const groups = findCrossFileDuplicateGroups(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB, ranges: [{ start: 99, end: 100 }] },
        ]),
        2,
        12,
    );

    // File a's blocks overlap the diff; file b participates as a call site
    // even though its own copy is out of range — mirroring the single-file
    // gate (one overlapping block qualifies the whole fingerprint).
    assertEquals(groups.length, 1);
    assertEquals(groups[0].blocks.length, 2);
});

Deno.test("findCrossFileDuplicateGroups skips this-using groups", () => {
    const thisA = [
        "class A {",
        "    run() {",
        "        const line = `Hi ${this.user}`;",
        "        logger.log(line);",
        "    }",
        "}",
    ].join("\n");
    const thisB = [
        "class B {",
        "    run() {",
        "        const entry = `Hi ${this.user}`;",
        "        logger.log(entry);",
        "    }",
        "}",
    ].join("\n");

    const groups = findCrossFileDuplicateGroups(
        filesOf([
            { file: "a.ts", source: thisA },
            { file: "b.ts", source: thisB },
        ]),
        2,
        12,
    );

    assertEquals(groups.length, 0);
});

Deno.test("findCrossFileDuplicateGroups reduces overlapping blocks per file", () => {
    // Three identical consecutive statements in file A yield overlapping
    // windows (s1,s2) and (s2,s3) with the same fingerprint; only a
    // disjoint set may be rewritten.
    const tripleA = [
        "function report() {",
        "    ping(one);",
        "    ping(two);",
        "    ping(three);",
        "}",
    ].join("\n");
    const pairB = [
        "function track() {",
        "    ping(four);",
        "    ping(five);",
        "}",
    ].join("\n");

    const groups = findCrossFileDuplicateGroups(
        filesOf([
            { file: "a.ts", source: tripleA },
            { file: "b.ts", source: pairB },
        ]),
        2,
        12,
    );

    assertEquals(groups.length, 1);
    const fileABlocks = groups[0].blocks.filter((b) => b.file === "a.ts");
    assertEquals(fileABlocks.length, 1);
    const fileBBlocks = groups[0].blocks.filter((b) => b.file === "b.ts");
    assertEquals(fileBBlocks.length, 1);
});

Deno.test("findCrossFileDuplicateGroups skips unparseable files", () => {
    const groups = findCrossFileDuplicateGroups(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "broken.ts", source: "function {{{ not valid" },
            { file: "b.ts", source: sourceB },
        ]),
        2,
        12,
    );

    assertEquals(groups.length, 1);
    const files = new Set(groups[0].blocks.map((b) => b.file));
    assert(!files.has("broken.ts"));
});

Deno.test("cross-file extractor rejects groups the LLM refutes", async () => {
    const logs: string[] = [];
    const refactor = createCrossFileDuplicateExtractor(
        testConfig,
        rejectingLLM,
    );
    const result = await refactor(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        {
            baseDir: "/tmp",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(result.changed, false);
    assertEquals(result.modified.size, 0);
    assertEquals(result.created.size, 0);
    // Placement was resolved and logged, then the LLM rejected the group.
    assert(
        logs.some((m) =>
            m.includes("cross-file group") && m.includes("/tmp/common")
        ),
    );
    assert(logs.some((m) => m.includes("LLM rejected cross-file group")));
});

Deno.test("cross-file extractor extracts into a new shared module", async () => {
    const files = filesOf([
        { file: "a.ts", source: sourceA },
        { file: "b.ts", source: sourceB },
    ]);

    const calls: string[] = [];
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
        async reviewChange() {
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
        // deno-lint-ignore require-await
        async verifyCrossFileDuplicateMatch() {
            calls.push("verify");
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateCrossFileExtraction() {
            calls.push("generate");
            return {
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    logger.log(line);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            };
        },
        // deno-lint-ignore require-await
        async reviewCrossFileChange() {
            calls.push("review");
            return { accepted: true, feedback: "" };
        },
    };

    const logs: string[] = [];
    const result = await createCrossFileDuplicateExtractor(testConfig, llm)(
        files,
        {
            baseDir: "/base",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(calls, ["verify", "generate", "review"]);
    assertEquals(result.changed, true);

    assertEquals(
        result.created.get("common/greetUser.ts"),
        [
            "export function greetUser(user) {",
            "    const line = `Hi ${user}`;",
            "    logger.log(line);",
            "}",
            "",
        ].join("\n"),
    );

    assertEquals(
        result.modified.get("a.ts"),
        [
            'import { greetUser } from "./common/greetUser";',
            "",
            "function alpha(user) {",
            "    greetUser(user);",
            "}",
        ].join("\n"),
    );
    assertEquals(
        result.modified.get("b.ts"),
        [
            'import { greetUser } from "./common/greetUser";',
            "",
            "function greetCustomer(name) {",
            "    greetUser(name);",
            "}",
        ].join("\n"),
    );
    assert(
        result.description.includes("common/greetUser.ts"),
    );
});

Deno.test("cross-file extractor aliases the binding on name collision", async () => {
    // Both files already bind `greetUser` at the top level, so the imported
    // helper must be aliased and the call sites renamed to the alias.
    const collides = (fnName: string) =>
        [
            `function ${fnName}(x) {`,
            "    return x;",
            "}",
        ].join("\n");
    const files = filesOf([
        { file: "a.ts", source: `${collides("greetUser")}\n${sourceA}` },
        { file: "b.ts", source: `${collides("greetUser")}\n${sourceB}` },
    ]);

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
        async reviewChange() {
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
        // deno-lint-ignore require-await
        async verifyCrossFileDuplicateMatch() {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateCrossFileExtraction() {
            return {
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    logger.log(line);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            };
        },
        // deno-lint-ignore require-await
        async reviewCrossFileChange() {
            return { accepted: true, feedback: "" };
        },
    };

    const result = await createCrossFileDuplicateExtractor(testConfig, llm)(
        files,
        {
            baseDir: "/base",
            log: () => {},
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(result.changed, true);
    assertEquals(
        result.modified.get("a.ts"),
        [
            'import { greetUser as greetUser2 } from "./common/greetUser";',
            "",
            "function greetUser(x) {",
            "    return x;",
            "}",
            "function alpha(user) {",
            "    greetUser2(user);",
            "}",
        ].join("\n"),
    );
});

Deno.test("cross-file extractor moves imports into the shared module", async () => {
    const withLog = (fnName: string) =>
        [
            'import { log } from "./log";',
            "",
            `function ${fnName}(user) {`,
            "    const line = `Hi ${user}`;",
            "    log(line);",
            "}",
        ].join("\n");
    const files = filesOf([
        { file: "a.ts", source: withLog("alpha") },
        { file: "b.ts", source: withLog("greetCustomer") },
    ]);

    const readFile = (p: string) =>
        Promise.resolve(
            p === "/base/log.ts" ? "export const log = 1;\n" : null,
        );

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
        async reviewChange() {
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
        // deno-lint-ignore require-await
        async verifyCrossFileDuplicateMatch() {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateCrossFileExtraction() {
            return {
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    log(line);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            };
        },
        // deno-lint-ignore require-await
        async reviewCrossFileChange() {
            return { accepted: true, feedback: "" };
        },
    };

    const result = await createCrossFileDuplicateExtractor(testConfig, llm)(
        files,
        {
            baseDir: "/base",
            log: () => {},
            readFile,
        },
    );

    assertEquals(result.changed, true);
    assertEquals(
        result.created.get("common/greetUser.ts"),
        [
            'import { log } from "../log";',
            "",
            "export function greetUser(user) {",
            "    const line = `Hi ${user}`;",
            "    log(line);",
            "}",
            "",
        ].join("\n"),
    );
    assertEquals(
        result.modified.get("a.ts"),
        [
            'import { log } from "./log";',
            'import { greetUser } from "./common/greetUser";',
            "",
            "function alpha(user) {",
            "    greetUser(user);",
            "}",
        ].join("\n"),
    );
});

Deno.test("cross-file extractor retries on rejected reviews then gives up", async () => {
    const files = filesOf([
        { file: "a.ts", source: sourceA },
        { file: "b.ts", source: sourceB },
    ]);

    let generateCount = 0;
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
        async reviewChange() {
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
        // deno-lint-ignore require-await
        async verifyCrossFileDuplicateMatch() {
            return { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateCrossFileExtraction() {
            generateCount++;
            return {
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    logger.log(line);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            };
        },
        // deno-lint-ignore require-await
        async reviewCrossFileChange() {
            reviewCount++;
            return { accepted: false, feedback: "wiring is wrong" };
        },
    };

    const logs: string[] = [];
    const result = await createCrossFileDuplicateExtractor(testConfig, llm)(
        files,
        {
            baseDir: "/base",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
        },
    );

    // retries (2) + 1 initial attempts, all rejected by review.
    assertEquals(generateCount, 3);
    assertEquals(reviewCount, 3);
    assertEquals(result.changed, false);
    assert(logs.some((m) => m.includes("LLM review rejected")));
    assert(logs.some((m) => m.includes("wiring is wrong")));
});

Deno.test("cross-file extractor handles LLM exclusion that keeps two files", async () => {
    // Three files with the same duplicate; the LLM excludes one file's
    // block, leaving two — still extractable.
    const files = filesOf([
        { file: "a.ts", source: sourceA },
        { file: "b.ts", source: sourceB },
        { file: "c.ts", source: sourceA.replace("alpha", "gamma") },
    ]);

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
        async reviewChange() {
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
        // deno-lint-ignore require-await
        async verifyCrossFileDuplicateMatch() {
            // Exclude the block that came from c.ts.
            return { isMatch: true, excludeIndices: [2], reason: "odd one" };
        },
        // deno-lint-ignore require-await
        async generateCrossFileExtraction() {
            return {
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    logger.log(line);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            };
        },
        // deno-lint-ignore require-await
        async reviewCrossFileChange() {
            return { accepted: true, feedback: "" };
        },
    };

    const result = await createCrossFileDuplicateExtractor(testConfig, llm)(
        files,
        {
            baseDir: "/base",
            log: () => {},
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(result.changed, true);
    assertEquals(result.modified.has("c.ts"), false);
    assertEquals(result.modified.has("a.ts"), true);
    assertEquals(result.modified.has("b.ts"), true);
});

/** Mock that rejects every cross-file verification. */
const rejectingLLM: LLMClient = {
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
    async reviewChange() {
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
    // deno-lint-ignore require-await
    async verifyCrossFileDuplicateMatch() {
        return { isMatch: false, excludeIndices: [], reason: "not a match" };
    },
    // deno-lint-ignore require-await
    async generateCrossFileExtraction() {
        return { helperName: "", helperFunction: "", callSites: [] };
    },
    // deno-lint-ignore require-await
    async reviewCrossFileChange() {
        return { accepted: true, feedback: "" };
    },
};

Deno.test("resolveLocalBinding returns free names and suffixes collisions", () => {
    const source = [
        'import { helper } from "./x";',
        "const helper2 = 1;",
        "function run() {}",
    ].join("\n");
    const ast = babelParse(source);

    assertEquals(resolveLocalBinding("greet", ast), "greet");
    assertEquals(resolveLocalBinding("helper", ast), "helper3");
    assertEquals(resolveLocalBinding("helper2", ast), "helper22");
    assertEquals(resolveLocalBinding("run", ast), "run2");
});

function babelParse(source: string) {
    return BABEL.parse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });
}

Deno.test("insertImport places the import after the last existing import", () => {
    const source = [
        'import { a } from "./a";',
        'import { b } from "./b";',
        "",
        "function run() {}",
    ].join("\n");

    assertEquals(
        insertImport(source, "./common/helper", "helper", "helper"),
        [
            'import { a } from "./a";',
            'import { b } from "./b";',
            'import { helper } from "./common/helper";',
            "",
            "function run() {}",
        ].join("\n"),
    );
});

Deno.test("insertImport lands at the top of import-free files", () => {
    const source = ["function run() {}", ""].join("\n");

    assertEquals(
        insertImport(source, "./common/helper", "helper", "helper"),
        [
            'import { helper } from "./common/helper";',
            "",
            "function run() {}",
            "",
        ].join("\n"),
    );
});

Deno.test("insertImport keeps leading comments above the import", () => {
    const source = [
        "// deno-lint-ignore-file no-explicit-any",
        "/* header",
        " * middle",
        " * block */",
        "",
        "function run() {}",
        "",
    ].join("\n");

    assertEquals(
        insertImport(source, "./common/helper", "helper", "helper"),
        [
            "// deno-lint-ignore-file no-explicit-any",
            "/* header",
            " * middle",
            " * block */",
            "",
            'import { helper } from "./common/helper";',
            "",
            "function run() {}",
            "",
        ].join("\n"),
    );
});

Deno.test("insertImport aliases when the local name differs", () => {
    const source = 'import { x } from "./x";\n';

    assertEquals(
        insertImport(source, "./common/helper", "helper", "helper2"),
        [
            'import { x } from "./x";',
            'import { helper as helper2 } from "./common/helper";',
            "",
        ].join("\n"),
    );
});

Deno.test("insertImport appends after an all-comment file", () => {
    const source = ["// only comments", "/* nothing else */", ""].join("\n");

    assertEquals(
        insertImport(source, "./common/helper", "helper", "helper"),
        [
            "// only comments",
            "/* nothing else */",
            "",
            'import { helper } from "./common/helper";',
            "",
        ].join("\n"),
    );
});

Deno.test("insertImport returns null for unparseable source", () => {
    assertEquals(
        insertImport("function {{{", "./common/helper", "helper", "helper"),
        null,
    );
});

Deno.test("resolveModulePath suffixes existing files", async () => {
    const existing = new Set<string>();
    const exists = (p: string) => Promise.resolve(existing.has(p));

    assertEquals(
        await resolveModulePath("/base/common", "helper", exists),
        "/base/common/helper.ts",
    );

    existing.add("/base/common/helper.ts");
    assertEquals(
        await resolveModulePath("/base/common", "helper", exists),
        "/base/common/helper2.ts",
    );

    existing.add("/base/common/helper2.ts");
    assertEquals(
        await resolveModulePath("/base/common", "helper", exists),
        "/base/common/helper3.ts",
    );
});

Deno.test("gateCrossFileGroups resolves placement for movable groups", async () => {
    const groups = findCrossFileDuplicateGroups(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        2,
        12,
    );
    assertEquals(groups.length, 1);

    const logs: string[] = [];
    const gated = await gateCrossFileGroups(
        groups,
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        "/base",
        () => Promise.resolve(null),
        (msg) => logs.push(msg),
    );

    assertEquals(gated.length, 1);
    assertEquals(gated[0].sharedDirAbs, "/base/common");
    assertEquals(gated[0].group, groups[0]);
    assert(logs[0].includes("/base/common"));
});

Deno.test("gateCrossFileGroups skips groups with unmovable imports", async () => {
    const withImport = [
        'import { log } from "./missing";',
        "",
        "function alpha(user) {",
        "    const line = `Hi ${user}`;",
        "    log(line);",
        "}",
    ].join("\n");
    const withImportB = [
        'import { log } from "./missing";',
        "",
        "function greetCustomer(name) {",
        "    const entry = `Hi ${name}`;",
        "    log(entry);",
        "}",
    ].join("\n");

    const files = filesOf([
        { file: "a.ts", source: withImport },
        { file: "b.ts", source: withImportB },
    ]);
    const groups = findCrossFileDuplicateGroups(files, 2, 12);
    assertEquals(groups.length, 1);

    const logs: string[] = [];
    const gated = await gateCrossFileGroups(
        groups,
        files,
        "/base",
        () => Promise.resolve(null),
        (msg) => logs.push(msg),
    );

    assertEquals(gated.length, 0);
    assert(
        logs.some((m) =>
            m.includes("skipped cross-file group") &&
            m.includes("./missing")
        ),
    );
});

Deno.test("gateCrossFileGroups passes movable relative imports", async () => {
    const withImport = [
        'import { log } from "./log";',
        "",
        "function alpha(user) {",
        "    const line = `Hi ${user}`;",
        "    log(line);",
        "}",
    ].join("\n");
    const withImportB = [
        'import { log } from "./log";',
        "",
        "function greetCustomer(name) {",
        "    const entry = `Hi ${name}`;",
        "    log(entry);",
        "}",
    ].join("\n");

    const files = filesOf([
        { file: "a.ts", source: withImport },
        { file: "b.ts", source: withImportB },
    ]);
    const groups = findCrossFileDuplicateGroups(files, 2, 12);
    assertEquals(groups.length, 1);

    const readFile = (p: string) =>
        Promise.resolve(p === "/base/log.ts" ? "export const log = 1;\n" : null);

    const logs: string[] = [];
    const gated = await gateCrossFileGroups(
        groups,
        files,
        "/base",
        readFile,
        (msg) => logs.push(msg),
    );

    assertEquals(gated.length, 1);
});

Deno.test("gateCrossFileGroups gates namespace and default imports too", async () => {
    const withNamespace = [
        'import * as log from "./log";',
        "",
        "function alpha(user) {",
        "    const line = `Hi ${user}`;",
        "    log.write(line);",
        "}",
    ].join("\n");
    const withDefault = [
        'import log from "./log";',
        "",
        "function greetCustomer(name) {",
        "    const entry = `Hi ${name}`;",
        "    log(entry);",
        "}",
    ].join("\n");

    const files = filesOf([
        { file: "a.ts", source: withNamespace },
        { file: "b.ts", source: withDefault },
    ]);
    const groups = findCrossFileDuplicateGroups(files, 2, 12);
    // log.write vs log: different member shapes, so no fingerprint match —
    // call each shape against itself instead by pairing same-shaped files.
    const nsFiles = filesOf([
        { file: "a.ts", source: withNamespace },
        { file: "b.ts", source: withNamespace },
    ]);
    const nsGroups = findCrossFileDuplicateGroups(nsFiles, 2, 12);
    assertEquals(nsGroups.length, 1);

    const readFile = (p: string) =>
        Promise.resolve(p === "/base/log.ts" ? "export const log = 1;\n" : null);

    const gated = await gateCrossFileGroups(
        nsGroups,
        nsFiles,
        "/base",
        readFile,
        () => {},
    );
    assertEquals(gated.length, 1);

    const defFiles = filesOf([
        { file: "a.ts", source: withDefault },
        { file: "b.ts", source: withDefault },
    ]);
    const defGroups = findCrossFileDuplicateGroups(defFiles, 2, 12);
    assertEquals(defGroups.length, 1);
    const gatedDef = await gateCrossFileGroups(
        defGroups,
        defFiles,
        "/base",
        readFile,
        () => {},
    );
    assertEquals(gatedDef.length, 1);

    // Silence unused-variable lint for the mismatched-shape grouping above.
    assertEquals(groups.length, 0);
});

Deno.test("gateCrossFileGroups skips when every candidate dir is a file", async () => {
    const files = filesOf([
        { file: "a.ts", source: sourceA },
        { file: "b.ts", source: sourceB },
    ]);
    const groups = findCrossFileDuplicateGroups(files, 2, 12);

    // Every candidate directory path under /base exists as a readable file.
    const readFile = (_p: string) => Promise.resolve("content");

    const logs: string[] = [];
    const gated = await gateCrossFileGroups(
        groups,
        files,
        "/base",
        readFile,
        (msg) => logs.push(msg),
    );

    assertEquals(gated.length, 0);
    assert(
        logs.some((m) => m.includes("no usable shared directory")),
    );
});

Deno.test("sharedDirCandidates puts the configured name first", () => {
    assertEquals(
        sharedDirCandidates(testConfig),
        ["common", "shared", "lib", "util"],
    );
    const custom: Config = {
        ...testConfig,
        duplicate_extractor_shared_dir: "helpers",
    };
    assertEquals(
        sharedDirCandidates(custom),
        ["helpers", "common", "shared", "lib", "util"],
    );
    // A configured backup name must not appear twice.
    const dupe: Config = {
        ...testConfig,
        duplicate_extractor_shared_dir: "lib",
    };
    assertEquals(
        sharedDirCandidates(dupe),
        ["lib", "common", "shared", "util"],
    );
});

Deno.test("gateCrossFileGroups honors custom candidate dirs", async () => {
    const files = filesOf([
        { file: "a.ts", source: sourceA },
        { file: "b.ts", source: sourceB },
    ]);
    const groups = findCrossFileDuplicateGroups(files, 2, 12);

    const logs: string[] = [];
    const gated = await gateCrossFileGroups(
        groups,
        files,
        "/base",
        () => Promise.resolve(null),
        (msg) => logs.push(msg),
        ["helpers", "common"],
    );

    assertEquals(gated.length, 1);
    assertEquals(gated[0].sharedDirAbs, "/base/helpers");
});

Deno.test("cross-file extractor uses the configured shared dir", async () => {
    const config: Config = {
        ...testConfig,
        duplicate_extractor_shared_dir: "helpers",
    };
    const result = await createCrossFileDuplicateExtractor(
        config,
        crossLLM({}),
    )(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        {
            baseDir: "/base",
            log: () => {},
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(result.changed, true);
    assert(result.created.has("helpers/greetUser.ts"));
    assert(
        result.modified.get("a.ts")!.includes(
            'import { greetUser } from "./helpers/greetUser";',
        ),
    );
});

/** Cross-file LLM mock factory: everything accepts by default. */
function crossLLM(overrides: {
    verify?: () => DuplicateVerifyResult;
    generate?: () => ExtractionResult;
    review?: () => ReviewResult;
}): LLMClient {
    return {
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
        async reviewChange() {
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
        // deno-lint-ignore require-await
        async verifyCrossFileDuplicateMatch(): Promise<DuplicateVerifyResult> {
            return overrides.verify?.() ??
                { isMatch: true, excludeIndices: [], reason: "ok" };
        },
        // deno-lint-ignore require-await
        async generateCrossFileExtraction(): Promise<ExtractionResult> {
            return overrides.generate?.() ?? {
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    logger.log(line);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            };
        },
        // deno-lint-ignore require-await
        async reviewCrossFileChange(): Promise<ReviewResult> {
            return overrides.review?.() ??
                { accepted: true, feedback: "" };
        },
    };
}

Deno.test("cross-file extractor carries namespace and default imports to the module", async () => {
    const nsSource = (fnName: string, varName: string) =>
        [
            'import * as log from "./log";',
            'import sink from "./sink";',
            "",
            `function ${fnName}(${varName}) {`,
            `    log.write(\`Hi \${${varName}}\`);`,
            `    sink(${varName});`,
            "}",
        ].join("\n");
    const files = filesOf([
        { file: "a.ts", source: nsSource("alpha", "user") },
        { file: "b.ts", source: nsSource("greetCustomer", "name") },
    ]);

    const readFile = (p: string) =>
        Promise.resolve(
            p === "/base/log.ts" || p === "/base/sink.ts"
                ? "export const x = 1;\n"
                : null,
        );

    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => ({
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    log.write(`Hi ${user}`);\n    sink(user);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            }),
        }),
    )(files, {
        baseDir: "/base",
        log: () => {},
        readFile,
    });

    assertEquals(result.changed, true);
    assertEquals(
        result.created.get("common/greetUser.ts"),
        [
            'import * as log from "../log";',
            'import sink from "../sink";',
            "",
            "export function greetUser(user) {",
            "    log.write(`Hi ${user}`);",
            "    sink(user);",
            "}",
            "",
        ].join("\n"),
    );
});

Deno.test("cross-file extractor skips import-name conflicts across files", async () => {
    const aWith = [
        'import { log } from "./log";',
        "",
        "function alpha(user) {",
        "    const line = `Hi ${user}`;",
        "    log(line);",
        "}",
    ].join("\n");
    const bWith = [
        'import { log } from "./other/log";',
        "",
        "function greetCustomer(name) {",
        "    const entry = `Hi ${name}`;",
        "    log(entry);",
        "}",
    ].join("\n");
    const files = filesOf([
        { file: "a.ts", source: aWith },
        { file: "b.ts", source: bWith },
    ]);

    // Both import targets resolve, so the gate passes; the conflict only
    // surfaces when building the module's imports (same name `log`, two
    // different sources).
    const readFile = (p: string) =>
        Promise.resolve(p.endsWith("log.ts") ? "export const x = 1;\n" : null);

    const logs: string[] = [];
    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({}),
    )(files, {
        baseDir: "/base",
        log: (msg) => logs.push(msg),
        readFile,
    });

    assertEquals(result.changed, false);
    assert(
        logs.some((m) => m.includes("conflicting or unmovable imports")),
    );
});

Deno.test("cross-file extractor ignores imports the blocks do not use", async () => {
    const source = (fnName: string, varName: string) =>
        [
            'import { log, extra } from "./log";',
            'import { gone } from "./gone";',
            "",
            `function ${fnName}(${varName}) {`,
            `    const line = \`Hi \${${varName}}\`;`,
            "    log(line);",
            "}",
        ].join("\n");
    const files = filesOf([
        { file: "a.ts", source: source("alpha", "user") },
        { file: "b.ts", source: source("greetCustomer", "name") },
    ]);
    const readFile = (p: string) =>
        Promise.resolve(
            p === "/base/log.ts" ? "export const log = 1;\n" : null,
        );

    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => ({
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    log(line);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            }),
        }),
    )(files, {
        baseDir: "/base",
        log: () => {},
        readFile,
    });

    assertEquals(result.changed, true);
    // `extra` is imported by both files but unused by the blocks, so the
    // shared module only carries `log`.
    assertEquals(
        result.created.get("common/greetUser.ts"),
        [
            'import { log } from "../log";',
            "",
            "export function greetUser(user) {",
            "    const line = `Hi ${user}`;",
            "    log(line);",
            "}",
            "",
        ].join("\n"),
    );
});

Deno.test("cross-file extractor stops when exclusion leaves one file", async () => {
    const files = filesOf([
        { file: "a.ts", source: sourceA },
        { file: "b.ts", source: sourceB },
        { file: "c.ts", source: sourceA.replace("alpha", "gamma") },
    ]);

    const logs: string[] = [];
    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            verify: () => ({
                isMatch: true,
                excludeIndices: [1, 2],
                reason: "only the first",
            }),
        }),
    )(files, {
        baseDir: "/base",
        log: (msg) => logs.push(msg),
        readFile: () => Promise.resolve(null),
    });

    assertEquals(result.changed, false);
    assert(logs.some((m) => m.includes("too few files after exclusion")));
});

Deno.test("cross-file extractor retries on call-site count mismatch", async () => {
    let generateCount = 0;
    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => {
                generateCount++;
                return {
                    helperName: "greetUser",
                    helperFunction: "function greetUser(user) {}\n",
                    callSites: ["    greetUser(user);\n"],
                };
            },
        }),
    )(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        {
            baseDir: "/base",
            log: () => {},
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(generateCount, 3);
    assertEquals(result.changed, false);
});

Deno.test("cross-file extractor retries on invalid helper names", async () => {
    let generateCount = 0;
    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => {
                generateCount++;
                return {
                    helperName: "not a name!",
                    helperFunction: "function helper() {}\n",
                    callSites: ["    helper(user);\n", "    helper(name);\n"],
                };
            },
        }),
    )(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        {
            baseDir: "/base",
            log: () => {},
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(generateCount, 3);
    assertEquals(result.changed, false);
});

Deno.test("cross-file extractor retries when a rewrite does not parse", async () => {
    let generateCount = 0;
    const logs: string[] = [];
    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => {
                generateCount++;
                return {
                    helperName: "greetUser",
                    helperFunction: "function greetUser(user) {}\n",
                    callSites: ["    this is not typescript (((", "    ok();\n"],
                };
            },
        }),
    )(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        {
            baseDir: "/base",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(generateCount, 3);
    assertEquals(result.changed, false);
    assert(logs.some((m) => m.includes("rewrite failed")));
});

Deno.test("cross-file extractor retries when the module does not parse", async () => {
    let generateCount = 0;
    const logs: string[] = [];
    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => {
                generateCount++;
                return {
                    helperName: "greetUser",
                    helperFunction: "function {{{ not valid",
                    callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
                };
            },
        }),
    )(
        filesOf([
            { file: "a.ts", source: sourceA },
            { file: "b.ts", source: sourceB },
        ]),
        {
            baseDir: "/base",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(generateCount, 3);
    assertEquals(result.changed, false);
    assert(logs.some((m) => m.includes("shared module didn't parse")));
});

Deno.test("cross-file extractor handles several blocks in one file", async () => {
    const doubleA = [
        "function alpha(user) {",
        "    const line = `Hi ${user}`;",
        "    logger.log(line);",
        "}",
        "",
        "function beta(user) {",
        "    const line = `Hi ${user}`;",
        "    logger.log(line);",
        "}",
    ].join("\n");
    const files = filesOf([
        { file: "a.ts", source: doubleA },
        { file: "b.ts", source: sourceB },
    ]);

    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => ({
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    const line = `Hi ${user}`;\n    logger.log(line);\n}\n",
                callSites: [
                    "    greetUser(user);\n",
                    "    greetUser(user);\n",
                    "    greetUser(name);\n",
                ],
            }),
        }),
    )(files, {
        baseDir: "/base",
        log: () => {},
        readFile: () => Promise.resolve(null),
    });

    assertEquals(result.changed, true);
    assertEquals(
        result.modified.get("a.ts"),
        [
            'import { greetUser } from "./common/greetUser";',
            "",
            "function alpha(user) {",
            "    greetUser(user);",
            "}",
            "",
            "function beta(user) {",
            "    greetUser(user);",
            "}",
        ].join("\n"),
    );
});

Deno.test("cross-file extractor suffixes the module when the path exists", async () => {
    const files = filesOf([
        { file: "a.ts", source: sourceA },
        { file: "b.ts", source: sourceB },
    ]);

    const readFile = (p: string) =>
        Promise.resolve(
            p === "/base/common/greetUser.ts" ? "existing module\n" : null,
        );

    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({}),
    )(files, {
        baseDir: "/base",
        log: () => {},
        readFile,
    });

    assertEquals(result.changed, true);
    assert(result.created.has("common/greetUser2.ts"));
    assert(
        result.modified.get("a.ts")!.includes('"./common/greetUser2"'),
    );
});

Deno.test("cross-file extractor preserves aliased named imports in the module", async () => {
    const aliasedSource = (fnName: string, varName: string) =>
        [
            'import { write as log } from "./log";',
            "",
            `function ${fnName}(${varName}) {`,
            `    log(\`Hi \${${varName}}\`);`,
            `    log(\`Bye \${${varName}}\`);`,
            "}",
        ].join("\n");
    const files = filesOf([
        { file: "a.ts", source: aliasedSource("alpha", "user") },
        { file: "b.ts", source: aliasedSource("greetCustomer", "name") },
    ]);
    const readFile = (p: string) =>
        Promise.resolve(
            p === "/base/log.ts" ? "export const write = 1;\n" : null,
        );

    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({
            generate: () => ({
                helperName: "greetUser",
                helperFunction:
                    "function greetUser(user) {\n    log(`Hi ${user}`);\n    log(`Bye ${user}`);\n}\n",
                callSites: ["    greetUser(user);\n", "    greetUser(name);\n"],
            }),
        }),
    )(files, {
        baseDir: "/base",
        log: () => {},
        readFile,
    });

    assertEquals(result.changed, true);
    assertEquals(
        result.created.get("common/greetUser.ts"),
        [
            'import { write as log } from "../log";',
            "",
            "export function greetUser(user) {",
            "    log(`Hi ${user}`);",
            "    log(`Bye ${user}`);",
            "}",
            "",
        ].join("\n"),
    );
});

Deno.test("cross-file extractor re-detects after applying and stops when gated out", async () => {
    // D1: extractable duplicate (a.ts + b.ts). D2: a duplicate whose only
    // import cannot move (a.ts + c.ts), so the gate rejects it on every
    // pass — pass 1 extracts D1, pass 2 re-detects D2, gates it out, stops.
    const aSrc = [
        'import { q } from "./missing";',
        "",
        "function alpha(user) {",
        "    const line = `Hi ${user}`;",
        "    logger.log(line);",
        "}",
        "",
        "function second(x) {",
        "    q(x);",
        "    save(x);",
        "}",
    ].join("\n");
    const bSrc = [
        "function greetCustomer(name) {",
        "    const entry = `Hi ${name}`;",
        "    logger.log(entry);",
        "}",
    ].join("\n");
    const cSrc = [
        'import { q } from "./missing";',
        "",
        "function third(y) {",
        "    q(y);",
        "    save(y);",
        "}",
    ].join("\n");

    const logs: string[] = [];
    const result = await createCrossFileDuplicateExtractor(
        testConfig,
        crossLLM({}),
    )(
        filesOf([
            { file: "a.ts", source: aSrc },
            { file: "b.ts", source: bSrc },
            { file: "c.ts", source: cSrc },
        ]),
        {
            baseDir: "/base",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
        },
    );

    assertEquals(result.changed, true);
    assertEquals(result.modified.has("a.ts"), true);
    assertEquals(result.modified.has("b.ts"), true);
    assertEquals(result.modified.has("c.ts"), false);
    assert(
        logs.some((m) =>
            m.includes('import "./missing"') && m.includes("cannot move")
        ),
    );
});

Deno.test("cross-file extractor moves imports of modules created in the same run", async () => {
    // Pass 1 extracts D1 and creates common/greetUser.ts in memory. The
    // rewritten call sites form a second duplicate group D2 whose blocks
    // use that new import — gating must read the created module from
    // memory (it is not on disk until the refactor returns), or D2 is
    // falsely skipped as unmovable. The type checker is wired so the
    // multi-file gate also sees the in-memory module on every pass.
    const aSrc = [
        "function alpha(user: string) {",
        '    const line = "Hi " + user;',
        "    return line.toUpperCase();",
        "}",
    ].join("\n");
    const bSrc = [
        "function greetCustomer(name: string) {",
        '    const entry = "Hi " + name;',
        "    return entry.toUpperCase();",
        "}",
    ].join("\n");

    let generateCalls = 0;
    const llm = crossLLM({
        generate: () => {
            generateCalls++;
            return generateCalls === 1
                ? {
                    helperName: "greetUser",
                    helperFunction:
                        'function greetUser(user: string): string {\n    const line = "Hi " + user;\n    return line.toUpperCase();\n}\n',
                    callSites: [
                        "    const line = greetUser(user);\n    return line.length > 0;\n",
                        "    const line = greetUser(name);\n    return line.length > 0;\n",
                    ],
                }
                : {
                    helperName: "handleGreeting",
                    helperFunction:
                        "function handleGreeting(user: string): boolean {\n    const line = greetUser(user);\n    return line.length > 0;\n}\n",
                    callSites: [
                        "    return handleGreeting(user);\n",
                        "    return handleGreeting(name);\n",
                    ],
                };
        },
    });

    const logs: string[] = [];
    const typeChecker = new TypeCheckerImpl();
    const result = await createCrossFileDuplicateExtractor(testConfig, llm)(
        filesOf([
            { file: "a.ts", source: aSrc },
            { file: "b.ts", source: bSrc },
        ]),
        {
            baseDir: "/base",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
            typeChecker,
        },
    );
    typeChecker.dispose();

    assertEquals(generateCalls, 2);
    assertEquals(
        result.created.get("common/handleGreeting.ts"),
        [
            'import { greetUser } from "./greetUser";',
            "",
            "export function handleGreeting(user: string): boolean {",
            "    const line = greetUser(user);",
            "    return line.length > 0;",
            "}",
            "",
        ].join("\n"),
    );
    assertEquals(
        result.modified.get("a.ts"),
        [
            'import { greetUser } from "./common/greetUser";',
            'import { handleGreeting } from "./common/handleGreeting";',
            "",
            "function alpha(user: string) {",
            "    return handleGreeting(user);",
            "}",
        ].join("\n"),
    );
    assert(!logs.some((m) => m.includes("cannot move")));
    assert(!logs.some((m) => m.includes("type-check failed")));
});

Deno.test("cross-file extractor type-checks proposals across files", async () => {
    // Attempt 1's call site references `parts`, a binding that does not
    // exist in either rewritten file (the class of build-breaker the LLM
    // review missed in live e2e). The deterministic multi-file type gate
    // must reject it and the retry must be applied.
    const aSrc = [
        "function alpha(user: string) {",
        '    const line = "Hi " + user;',
        "    return line.toUpperCase();",
        "}",
    ].join("\n");
    const bSrc = [
        "function greetCustomer(name: string) {",
        '    const entry = "Hi " + name;',
        "    return entry.toUpperCase();",
        "}",
    ].join("\n");
    // Uninvolved diff file: the type gate re-checks every diff file, not
    // just the rewritten ones.
    const cSrc = [
        "function unrelated(n: number) {",
        "    return n * 2;",
        "}",
    ].join("\n");

    let generateCalls = 0;
    const llm = crossLLM({
        generate: () => {
            generateCalls++;
            return generateCalls === 1
                ? {
                    helperName: "greetUser",
                    helperFunction:
                        'function greetUser(user: string): string {\n    const line = "Hi " + user;\n    return line.toUpperCase();\n}\n',
                    callSites: [
                        "    return greetUser(user, parts);\n",
                        "    return greetUser(name, parts);\n",
                    ],
                }
                : {
                    helperName: "greetUser",
                    helperFunction:
                        'function greetUser(user: string): string {\n    const line = "Hi " + user;\n    return line.toUpperCase();\n}\n',
                    callSites: [
                        "    return greetUser(user);\n",
                        "    return greetUser(name);\n",
                    ],
                };
        },
    });

    const logs: string[] = [];
    const typeChecker = new TypeCheckerImpl();
    const result = await createCrossFileDuplicateExtractor(testConfig, llm)(
        filesOf([
            { file: "a.ts", source: aSrc },
            { file: "b.ts", source: bSrc },
            { file: "c.ts", source: cSrc },
        ]),
        {
            baseDir: "/base",
            log: (msg) => logs.push(msg),
            readFile: () => Promise.resolve(null),
            typeChecker,
        },
    );
    typeChecker.dispose();

    assertEquals(generateCalls, 2);
    assert(logs.some((m) => m.includes("type-check failed")));
    assertEquals(result.modified.has("c.ts"), false);
    assertEquals(
        result.modified.get("a.ts"),
        [
            'import { greetUser } from "./common/greetUser";',
            "",
            "function alpha(user: string) {",
            "    return greetUser(user);",
            "}",
        ].join("\n"),
    );
    assert(result.created.has("common/greetUser.ts"));
});
