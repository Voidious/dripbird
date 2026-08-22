import { assertEquals } from "@std/assert";
import * as babelParser from "@babel/parser";
import {
    checkImportMovable,
    collectUsedImportBindings,
    commonAncestorDir,
    moduleReaches,
    pickSharedDir,
    relativeSpecifier,
} from "../../src/refactors/duplicate_extractor_placement.ts";

function filesMap(entries: Record<string, string>) {
    return (path: string) =>
        Promise.resolve(entries[path.replace(/\\/g, "/")] ?? null);
}

Deno.test("commonAncestorDir finds deepest shared directory", () => {
    assertEquals(
        commonAncestorDir(["/base/src/a/x.ts", "/base/src/b/y.ts"]),
        "/base/src",
    );
    assertEquals(
        commonAncestorDir(["/base/a.ts", "/base/common/b.ts"]),
        "/base",
    );
    assertEquals(commonAncestorDir(["/base/a.ts"]), "/base");
    assertEquals(commonAncestorDir(["/a/x.ts", "/b/y.ts"]), "/");
    assertEquals(commonAncestorDir([]), "/");
});

Deno.test("relativeSpecifier builds specifiers between files", () => {
    assertEquals(
        relativeSpecifier("/base/a.ts", "/base/common/helper.ts"),
        "./common/helper.ts",
    );
    assertEquals(
        relativeSpecifier("/base/src/a.ts", "/base/common/helper.ts"),
        "../common/helper.ts",
    );
    assertEquals(
        relativeSpecifier("/base/src/deep/a.ts", "/base/src/util.ts"),
        "../util.ts",
    );
    assertEquals(
        relativeSpecifier("/base/mod1.ts", "/base/mod2.ts"),
        "./mod2.ts",
    );
    assertEquals(
        relativeSpecifier("/base/a.ts", "/base/b/c/d.ts"),
        "./b/c/d.ts",
    );
    // The target's real extension is kept, including .tsx.
    assertEquals(
        relativeSpecifier("/base/a.ts", "/base/b/c.tsx"),
        "./b/c.tsx",
    );
});

Deno.test("pickSharedDir takes the first candidate that is not a file", async () => {
    const blocked = new Set(["/base/common", "/base/shared"]);
    assertEquals(
        await pickSharedDir(
            ["common", "shared", "lib"],
            "/base",
            (p) => Promise.resolve(blocked.has(p)),
        ),
        "lib",
    );
    assertEquals(
        await pickSharedDir(["common"], "/base", () => Promise.resolve(false)),
        "common",
    );
    assertEquals(
        await pickSharedDir(["common"], "/", () => Promise.resolve(false)),
        "common",
    );
    assertEquals(
        await pickSharedDir(
            ["common", "shared"],
            "/base",
            () => Promise.resolve(true),
        ),
        null,
    );
});

Deno.test("checkImportMovable passes bare specifiers through verbatim", async () => {
    assertEquals(
        await checkImportMovable(
            "npm:recast",
            "/base/a.ts",
            "/base/common/helper.ts",
            filesMap({}),
        ),
        { specifier: "npm:recast" },
    );
    assertEquals(
        await checkImportMovable(
            "@std/assert",
            "/base/a.ts",
            "/base/common/helper.ts",
            filesMap({}),
        ),
        { specifier: "@std/assert" },
    );
});

Deno.test("checkImportMovable rewrites relative imports to shared location", async () => {
    // a.ts imports ./util (resolves to /base/src/util.ts); the shared
    // module at /base/common/helper.ts must reach it as ../src/util.ts.
    assertEquals(
        await checkImportMovable(
            "./util",
            "/base/src/a.ts",
            "/base/common/helper.ts",
            filesMap({ "/base/src/util.ts": "export const u = 1;\n" }),
        ),
        { specifier: "../src/util.ts" },
    );
    // Extension candidates are probed in order; the target's real
    // extension is kept in the rewritten specifier.
    assertEquals(
        await checkImportMovable(
            "./util.js",
            "/base/src/a.ts",
            "/base/common/helper.ts",
            filesMap({ "/base/src/util.js": "export const u = 1;\n" }),
        ),
        { specifier: "../src/util.js" },
    );
});

Deno.test("checkImportMovable rejects unresolvable relative imports", async () => {
    assertEquals(
        await checkImportMovable(
            "./missing",
            "/base/src/a.ts",
            "/base/common/helper.ts",
            filesMap({}),
        ),
        null,
    );
});

Deno.test("collectUsedImportBindings finds imports referenced by a block", () => {
    const fileSource = [
        'import { send } from "./net";',
        'import * as log from "./log";',
        'import def from "./def";',
        "const unused = 1;",
        "",
        "function run(c) {",
        "    send(c);",
        "    log.write(c);",
        "    def(c);",
        "    local(c);",
        "}",
    ].join("\n");
    const ast = babelParser.parse(fileSource, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });
    const runDecl = ast.program.body.find(
        (s: { type: string }) => s.type === "FunctionDeclaration",
    ) as unknown as { body: { body: never[] } };

    const used = collectUsedImportBindings(runDecl.body.body, ast);
    assertEquals(used, new Set(["send", "log", "def"]));
});

Deno.test("collectUsedImportBindings ignores property-key identifiers", () => {
    const fileSource = [
        'import { send } from "./net";',
        "",
        "function run(c) {",
        "    const opts = { send: c };",
        "    c.send = 2;",
        "}",
    ].join("\n");
    const ast = babelParser.parse(fileSource, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });
    const runDecl = ast.program.body.find(
        (s: { type: string }) => s.type === "FunctionDeclaration",
    ) as unknown as { body: { body: never[] } };

    // `send` appears only as an object key and a member property, never as
    // a value reference, so the import is not needed by this block.
    assertEquals(collectUsedImportBindings(runDecl.body.body, ast), new Set());
});

Deno.test("moduleReaches walks imports transitively", async () => {
    const helperSource = 'import { a } from "../src/a";\nexport const h = a;\n';
    const read = filesMap({
        "/base/common/helper.ts": helperSource,
        "/base/src/a.ts": "export const a = 1;\n",
    });

    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            helperSource,
            new Set(["/base/src/a.ts"]),
            read,
        ),
        true,
    );

    // Transitive reach: helper -> mid -> target.
    const helper2 = 'import { m } from "./mid";\n';
    const read2 = filesMap({
        "/base/common/helper.ts": helper2,
        "/base/common/mid.ts": 'import { t } from "../src/t";\n',
        "/base/src/t.ts": "export const t = 1;\n",
    });
    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            helper2,
            new Set(["/base/src/t.ts"]),
            read2,
        ),
        true,
    );
});

Deno.test("moduleReaches ignores bare imports and unrelated graphs", async () => {
    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            'import { x } from "npm:pkg";\nexport const h = x;\n',
            new Set(["/base/src/a.ts"]),
            filesMap({ "/base/src/a.ts": "export const a = 1;\n" }),
        ),
        false,
    );

    const helperSource = 'import { u } from "./util";\n';
    const read = filesMap({
        "/base/common/helper.ts": helperSource,
        "/base/common/util.ts": "export const u = 1;\n",
    });
    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            helperSource,
            new Set(["/base/src/a.ts"]),
            read,
        ),
        false,
    );
});

Deno.test("moduleReaches treats unreadable or unparseable modules as no edges", async () => {
    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            null,
            new Set(["/base/src/a.ts"]),
            filesMap({}),
        ),
        false,
    );
    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            "function {{{ not valid",
            new Set(["/base/src/a.ts"]),
            filesMap({}),
        ),
        false,
    );
});

Deno.test("moduleReaches probes extension candidates when resolving imports", async () => {
    // The specifier "./mid" has no extensionless file; only mid.ts exists,
    // so the BFS must skip the failed exact candidate and try .ts.
    const helperSource = 'import { m } from "./mid";\n';
    const read = filesMap({
        "/base/common/helper.ts": helperSource,
        "/base/common/mid.ts": 'import { t } from "../src/t";\n',
        "/base/src/t.ts": "export const t = 1;\n",
    });
    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            helperSource,
            new Set(["/base/src/t.ts"]),
            read,
        ),
        true,
    );
});

Deno.test("moduleReaches terminates on cyclic graphs", async () => {
    // A pre-existing cycle in unrelated files must not hang the BFS; the
    // visited set bounds the walk.
    const helperSource = 'import { x } from "./x";\n';
    const read = filesMap({
        "/base/common/helper.ts": helperSource,
        "/base/common/x.ts": 'import { h } from "./y";\n',
        "/base/common/y.ts": 'import { x2 } from "./x";\n',
    });
    assertEquals(
        await moduleReaches(
            "/base/common/helper.ts",
            helperSource,
            new Set(["/base/src/a.ts"]),
            read,
        ),
        false,
    );
});
