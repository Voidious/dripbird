// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
import { parse } from "recast";
import * as babelParser from "@babel/parser";
import {
    collectImportEdges,
    describeExports,
    remapExternalFunctions,
    resolveImportTarget,
    resolveRelativePath,
} from "../../src/refactors/function_matcher_imports.ts";
import type { FunctionInfo } from "../../src/refactors/function_matcher.ts";

function parseSource(source: string): any {
    return parse(source, {
        parser: {
            parse(code: string) {
                return babelParser.parse(code, {
                    sourceType: "module",
                    plugins: ["typescript", "jsx"],
                });
            },
        },
    });
}

function mkFn(overrides: Partial<FunctionInfo>): FunctionInfo {
    return {
        name: "fn",
        kind: "function",
        className: null,
        callName: "fn",
        usesThis: false,
        isLocal: true,
        funcSource: "",
        origin: null,
        node: null,
        bodyStatements: [],
        bodySource: "",
        bodyFingerprint: "",
        params: [],
        returnExprSource: null,
        returnExprFingerprint: null,
        returnExprParamMapping: null,
        ...overrides,
    };
}

Deno.test("collectImportEdges: collects named, alias, namespace, default", () => {
    const ast = parseSource([
        'import { a, b as c } from "./util";',
        'import dflt from "./other";',
        'import * as ns from "./ns";',
        'import side from "./side";',
    ].join("\n"));
    const edges = collectImportEdges(ast);
    assertEquals(edges.length, 4);
    assertEquals(edges[0].specifier, "./util");
    assertEquals(edges[0].named.get("a"), "a");
    assertEquals(edges[0].named.get("b"), "c");
    assertEquals(edges[0].namespaceBinding, null);
    assertEquals(edges[0].defaultBinding, null);
    assertEquals(edges[1].defaultBinding, "dflt");
    assertEquals(edges[2].namespaceBinding, "ns");
});

Deno.test("collectImportEdges: skips non-relative specifiers", () => {
    const ast = parseSource([
        'import { x } from "some-package";',
        'import { y } from "@std/assert";',
        'import { z } from "npm:recast";',
        'import { w } from "/abs/path";',
        'import { v } from "https://example.com/mod.ts";',
    ].join("\n"));
    assertEquals(collectImportEdges(ast), []);
});

Deno.test("collectImportEdges: skips type-only imports and specifiers", () => {
    const ast = parseSource([
        'import type { T } from "./types";',
        'import { type U, keep } from "./mixed";',
    ].join("\n"));
    const edges = collectImportEdges(ast);
    assertEquals(edges.length, 1);
    assertEquals(edges[0].specifier, "./mixed");
    assertEquals(edges[0].named.has("U"), false);
    assertEquals(edges[0].named.get("keep"), "keep");
});

Deno.test("collectImportEdges: skips side-effect imports without bindings", () => {
    const ast = parseSource('import "./side-effect";');
    assertEquals(collectImportEdges(ast), []);
});

Deno.test("collectImportEdges: skips import with non-string source value", () => {
    const ast = {
        program: {
            body: [{ type: "ImportDeclaration", source: { value: null } }],
        },
    };
    assertEquals(collectImportEdges(ast), []);
});

Deno.test("collectImportEdges: tolerates import without specifiers field", () => {
    const ast = {
        program: {
            body: [{
                type: "ImportDeclaration",
                source: { value: "./util" },
            }],
        },
    };
    assertEquals(collectImportEdges(ast), []);
});

Deno.test("collectImportEdges: merges duplicate specifiers", () => {
    const ast = parseSource([
        'import { a } from "./util";',
        'import { b } from "./util";',
    ].join("\n"));
    const edges = collectImportEdges(ast);
    assertEquals(edges.length, 1);
    assertEquals(edges[0].named.get("a"), "a");
    assertEquals(edges[0].named.get("b"), "b");
});

Deno.test("resolveRelativePath: probes extensions then index files", () => {
    assertEquals(resolveRelativePath("/proj/src/a.ts", "./util"), [
        "/proj/src/util",
        "/proj/src/util.ts",
        "/proj/src/util.tsx",
        "/proj/src/util.mts",
        "/proj/src/util.js",
        "/proj/src/util.jsx",
        "/proj/src/util.mjs",
        "/proj/src/util.cjs",
        "/proj/src/util/index.ts",
        "/proj/src/util/index.tsx",
        "/proj/src/util/index.js",
    ]);
});

Deno.test("resolveRelativePath: handles parent traversal and explicit extension", () => {
    assertEquals(
        resolveRelativePath("/proj/src/a.ts", "../lib/util.ts"),
        [
            "/proj/lib/util.ts",
            "/proj/lib/util.ts.ts",
            "/proj/lib/util.ts.tsx",
            "/proj/lib/util.ts.mts",
            "/proj/lib/util.ts.js",
            "/proj/lib/util.ts.jsx",
            "/proj/lib/util.ts.mjs",
            "/proj/lib/util.ts.cjs",
            "/proj/lib/util.ts/index.ts",
            "/proj/lib/util.ts/index.tsx",
            "/proj/lib/util.ts/index.js",
        ],
    );
    assertEquals(
        resolveRelativePath("/proj/a/b/a.ts", "./c/../d")[0],
        "/proj/a/b/d",
    );
});

Deno.test("resolveRelativePath: returns empty when escaping root", () => {
    assertEquals(resolveRelativePath("/x/a.ts", "../../y"), []);
});

Deno.test("resolveRelativePath: handles base path without directory", () => {
    assertEquals(resolveRelativePath("a.ts", "./util")[0], "util");
});

Deno.test("resolveRelativePath: normalizes windows separators", () => {
    const candidates = resolveRelativePath("C:\\proj\\a.ts", "./util");
    assertEquals(candidates[0], "C:/proj/util");
    assertEquals(candidates[1], "C:/proj/util.ts");
});

Deno.test("resolveImportTarget: returns first readable candidate", async () => {
    const reads: string[] = [];
    // deno-lint-ignore require-await
    const readFile = async (path: string) => {
        reads.push(path);
        return path === "/proj/util.ts" ? "export function a() {}" : null;
    };
    assertEquals(
        await resolveImportTarget("/proj/a.ts", "./util", readFile),
        "export function a() {}",
    );
    assertEquals(reads, ["/proj/util", "/proj/util.ts"]);
});

Deno.test("resolveImportTarget: returns null when nothing resolves", async () => {
    assertEquals(
        await resolveImportTarget(
            "/proj/a.ts",
            "./missing",
            // deno-lint-ignore require-await
            async () => null,
        ),
        null,
    );
});

Deno.test("describeExports: inline declarations and alias lists", () => {
    const ast = parseSource([
        "export function foo() {}",
        "export class Bar {}",
        "export const baz = 1;",
        "function qux() {}",
        "export { qux as quux };",
    ].join("\n"));
    const exports = describeExports(ast);
    assertEquals(exports.named.get("foo"), "foo");
    assertEquals(exports.named.get("Bar"), "Bar");
    assertEquals(exports.named.get("baz"), "baz");
    assertEquals(exports.named.get("qux"), "quux");
    assertEquals(exports.defaultLocal, null);
});

Deno.test("describeExports: default declarations", () => {
    const named = parseSource("export default function main() {}");
    assertEquals(describeExports(named).defaultLocal, "main");

    const cls = parseSource("export default class Main {}");
    assertEquals(describeExports(cls).defaultLocal, "Main");

    const anon = parseSource("export default () => {}");
    assertEquals(describeExports(anon).defaultLocal, null);
});

Deno.test("describeExports: ignores string-literal export names", () => {
    const ast = parseSource(
        'function a() {}\nexport { a as "not an identifier" };',
    );
    const exports = describeExports(ast);
    assertEquals(exports.named.size, 0);
});

Deno.test("describeExports: ignores malformed export specifier", () => {
    const ast = {
        program: {
            body: [
                { type: "ExportNamedDeclaration", declaration: null },
                {
                    type: "ExportNamedDeclaration",
                    specifiers: [
                        {
                            local: null,
                            exported: { type: "Identifier", name: "x" },
                        },
                    ],
                },
            ],
        },
    };
    assertEquals(describeExports(ast).named.size, 0);
});

Deno.test("remapExternalFunctions: named import (alias-aware)", () => {
    const edge = {
        specifier: "./util",
        named: new Map([["foo", "f"]]),
        namespaceBinding: null,
        defaultBinding: null,
    };
    const exports = { named: new Map([["foo", "foo"]]), defaultLocal: null };
    const [remapped] = remapExternalFunctions(
        [mkFn({ name: "foo" })],
        edge,
        exports,
        "./util",
    );
    assertEquals(remapped.isLocal, false);
    assertEquals(remapped.callName, "f");
    assertEquals(remapped.origin, "./util");
});

Deno.test("remapExternalFunctions: export alias chains to import binding", () => {
    const edge = {
        specifier: "./util",
        named: new Map([["publicName", "local"]]),
        namespaceBinding: null,
        defaultBinding: null,
    };
    const exports = {
        named: new Map([["impl", "publicName"]]),
        defaultLocal: null,
    };
    const [remapped] = remapExternalFunctions(
        [mkFn({ name: "impl" })],
        edge,
        exports,
        "./util",
    );
    assertEquals(remapped.callName, "local");
});

Deno.test("remapExternalFunctions: default export via default import", () => {
    const edge = {
        specifier: "./util",
        named: new Map(),
        namespaceBinding: null,
        defaultBinding: "main",
    };
    const exports = { named: new Map(), defaultLocal: "run" };
    const [remapped] = remapExternalFunctions(
        [mkFn({ name: "run" })],
        edge,
        exports,
        "./util",
    );
    assertEquals(remapped.callName, "main");
});

Deno.test("remapExternalFunctions: namespace import uses export name", () => {
    const edge = {
        specifier: "./util",
        named: new Map(),
        namespaceBinding: "ns",
        defaultBinding: null,
    };
    const exports = {
        named: new Map([["impl", "publicName"]]),
        defaultLocal: null,
    };
    const [remapped] = remapExternalFunctions(
        [mkFn({ name: "impl" })],
        edge,
        exports,
        "./util",
    );
    assertEquals(remapped.callName, "ns.publicName");
});

Deno.test("remapExternalFunctions: static method gets binding-qualified name", () => {
    const edge = {
        specifier: "./util",
        named: new Map([["Str", "Str"]]),
        namespaceBinding: null,
        defaultBinding: null,
    };
    const exports = { named: new Map([["Str", "Str"]]), defaultLocal: null };
    const [remapped] = remapExternalFunctions(
        [
            mkFn({
                name: "Str.clean",
                kind: "staticMethod",
                className: "Str",
                callName: "Str.clean",
            }),
        ],
        edge,
        exports,
        "./util",
    );
    assertEquals(remapped.name, "Str.clean");
    assertEquals(remapped.callName, "Str.clean");
    assertEquals(remapped.isLocal, false);
});

Deno.test("remapExternalFunctions: instance method remaps className to binding", () => {
    const edge = {
        specifier: "./util",
        named: new Map([["Formatter", "Fmt"]]),
        namespaceBinding: null,
        defaultBinding: null,
    };
    const exports = {
        named: new Map([["Formatter", "Formatter"]]),
        defaultLocal: null,
    };
    const [remapped] = remapExternalFunctions(
        [
            mkFn({
                name: "Formatter.clean",
                kind: "instanceMethod",
                className: "Formatter",
                callName: "this.clean",
            }),
        ],
        edge,
        exports,
        "./util",
    );
    assertEquals(remapped.name, "Fmt.clean");
    assertEquals(remapped.className, "Fmt");
    assertEquals(remapped.callName, "this.clean");
});

Deno.test("remapExternalFunctions: drops functions without a usable binding", () => {
    const edge = {
        specifier: "./util",
        named: new Map([["other", "o"]]),
        namespaceBinding: null,
        defaultBinding: null,
    };
    const exports = { named: new Map([["other", "other"]]), defaultLocal: null };
    assertEquals(
        remapExternalFunctions(
            [mkFn({ name: "notExported" }), mkFn({ name: "other" })],
            edge,
            exports,
            "./util",
        ).length,
        1,
    );
});
