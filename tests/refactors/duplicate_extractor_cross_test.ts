import { assert, assertEquals } from "@std/assert";
import {
    createCrossFileDuplicateExtractor,
    findCrossFileDuplicateGroups,
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
});
