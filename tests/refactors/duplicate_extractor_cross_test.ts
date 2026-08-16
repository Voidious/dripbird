import { assert, assertEquals } from "@std/assert";
import * as BABEL from "@babel/parser";
import {
    createCrossFileDuplicateExtractor,
    findCrossFileDuplicateGroups,
    gateCrossFileGroups,
    insertImport,
    resolveLocalBinding,
    resolveModulePath,
} from "../../src/refactors/duplicate_extractor_cross.ts";
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

Deno.test("cross-file extractor is a detection-only no-op for now", async () => {
    const logs: string[] = [];
    const refactor = createCrossFileDuplicateExtractor(testConfig);
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
    assertEquals(logs.length, 1);
    assert(logs[0].includes("cross-file group"));
    assert(logs[0].includes("a.ts"));
    assert(logs[0].includes("b.ts"));
    // Placement was resolved: the gate reports the shared directory.
    assert(logs[0].includes("/tmp/common"));
});

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
