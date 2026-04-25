// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { parseTypeString, TypeCheckerImpl } from "../src/type_checker.ts";

Deno.test("TypeCheckerImpl returns null before init", () => {
    const checker = new TypeCheckerImpl();
    assertEquals(checker.getTypeAtPosition(1, 0), null);
    checker.dispose();
});

Deno.test("TypeCheckerImpl returns null after dispose", async () => {
    const checker = new TypeCheckerImpl();
    await checker.initForSource("const x = 1;\n");
    checker.dispose();
    assertEquals(checker.getTypeAtPosition(1, 0), null);
});

Deno.test("TypeCheckerImpl handles load failure gracefully", async () => {
    const checker = new TypeCheckerImpl(() => {
        throw new Error("cannot load");
    });
    await checker.initForSource("const x = 1;");
    assertEquals(checker.getTypeAtPosition(1, 6), null);
    await checker.initForSource("const y = 2;");
    assertEquals(checker.getTypeAtPosition(1, 6), null);
});

Deno.test("TypeCheckerImpl handles TS module without default export", async () => {
    const fakeTs = {
        ScriptTarget: { Latest: 99 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        createCompilerHost: () => ({ getSourceFile: () => null }),
        createSourceFile: () => ({}),
        createProgram: () => ({
            getTypeChecker: () => ({
                getTypeAtLocation: () => null,
                typeToString: () => "any",
            }),
            getSourceFile: () => undefined,
        }),
        getPositionOfLineAndCharacter: () => 0,
        forEachChild: () => {},
    };
    const checker = new TypeCheckerImpl(() => {
        return Promise.resolve({ default: undefined, ...fakeTs });
    });
    await checker.initForSource("const x = 1;\n");
    assertEquals(checker.getTypeAtPosition(1, 6), null);
});

Deno.test("TypeCheckerImpl infers Map type from new expression", async () => {
    const checker = new TypeCheckerImpl();
    await checker.initForSource(
        "const m = new Map<string, number>();\n",
    );
    assertEquals(checker.getTypeAtPosition(1, 6), "Map<string, number>");
    checker.dispose();
});

Deno.test("TypeCheckerImpl returns type from explicit annotation", async () => {
    const checker = new TypeCheckerImpl();
    await checker.initForSource("const x: number = 42;\n");
    assertEquals(checker.getTypeAtPosition(1, 6), "number");
    checker.dispose();
});

Deno.test("TypeCheckerImpl infers object type from spread", async () => {
    const checker = new TypeCheckerImpl();
    const source = [
        "interface Config { x: number; y: string; }",
        "function foo(base: Config) {",
        "    const result = { ...base };",
        "    return result;",
        "}",
    ].join("\n");
    await checker.initForSource(source);
    const resultType = checker.getTypeAtPosition(3, 10);
    assert(resultType !== null);
    assert(resultType.includes("x: number"));
    assert(resultType.includes("y: string"));
    checker.dispose();
});

Deno.test("TypeCheckerImpl returns null for any type", async () => {
    const checker = new TypeCheckerImpl();
    await checker.initForSource("function f(x) { return x; }\n");
    assertEquals(checker.getTypeAtPosition(1, 11), null);
    checker.dispose();
});

Deno.test("TypeCheckerImpl returns null for out-of-range position", async () => {
    const checker = new TypeCheckerImpl();
    await checker.initForSource("const x = 1;\n");
    assertEquals(checker.getTypeAtPosition(99, 99), null);
    checker.dispose();
});

Deno.test("TypeCheckerImpl caches TS module across inits", async () => {
    let loadCount = 0;
    const checker = new TypeCheckerImpl(async () => {
        loadCount++;
        const mod = await import("typescript");
        return mod.default ?? mod;
    });
    await checker.initForSource("const a = 1;\n");
    assertEquals(loadCount, 1);
    await checker.initForSource("const b = 2;\n");
    assertEquals(loadCount, 1);
    checker.dispose();
});

Deno.test("TypeCheckerImpl handles program creation failure", async () => {
    const checker = new TypeCheckerImpl(async () => {
        const mod = await import("typescript");
        const ts = mod.default ?? mod;
        const origCreateProgram = ts.createProgram;
        ts.createProgram = () => {
            ts.createProgram = origCreateProgram;
            throw new Error("program failed");
        };
        return ts;
    });
    await checker.initForSource("const x = 1;\n");
    assertEquals(checker.getTypeAtPosition(1, 6), null);
});

Deno.test("TypeCheckerImpl infers string array type", async () => {
    const checker = new TypeCheckerImpl();
    const source = [
        "function f() {",
        '    const items = ["a", "b", "c"];',
        "    return items;",
        "}",
    ].join("\n");
    await checker.initForSource(source);
    assertEquals(checker.getTypeAtPosition(2, 10), "string[]");
    checker.dispose();
});

Deno.test("TypeCheckerImpl infers return type of method call", async () => {
    const checker = new TypeCheckerImpl();
    const source = [
        "class Stats {",
        "    byFile(): Map<string, number> { return new Map(); }",
        "}",
        "function f(s: Stats) {",
        "    const result = s.byFile();",
        "    return result;",
        "}",
    ].join("\n");
    await checker.initForSource(source);
    assertEquals(
        checker.getTypeAtPosition(5, 10),
        "Map<string, number>",
    );
    checker.dispose();
});

Deno.test("TypeCheckerImpl works with real file path", async () => {
    const tmpDir = await Deno.makeTempDir();
    const filePath = `${tmpDir}/test.ts`;
    await Deno.writeTextFile(
        filePath,
        "const x: Map<string, number> = new Map();\n",
    );
    const checker = new TypeCheckerImpl();
    await checker.initForSource(
        "const x: Map<string, number> = new Map();\n",
        filePath,
    );
    assertEquals(checker.getTypeAtPosition(1, 6), "Map<string, number>");
    checker.dispose();
    await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("TypeCheckerImpl returns null when position is before any token", async () => {
    const checker = new TypeCheckerImpl();
    await checker.initForSource("\nconst x = 1;\n");
    assertEquals(checker.getTypeAtPosition(1, 0), null);
    checker.dispose();
});

Deno.test("TypeCheckerImpl returns null when getTypeAtLocation returns falsy", async () => {
    const fakeTs = {
        ScriptTarget: { Latest: 99 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        createCompilerHost: () => ({ getSourceFile: () => null }),
        createSourceFile: (_fn: string, src: string, _lv: number) => {
            const sf = {
                text: src,
                _start: 0,
                _end: src.length,
                getStart: () => 0,
                getEnd: () => src.length,
                forEachChild: () => {},
            };
            return sf;
        },
        createProgram: () => {
            const sf = {
                getStart: () => 0,
                getEnd: () => 20,
                forEachChild: (cb: any) => {
                    cb({
                        getStart: () => 0,
                        getEnd: () => 20,
                        forEachChild: () => {},
                    });
                },
            };
            return {
                getTypeChecker: () => ({
                    getTypeAtLocation: () => undefined,
                    typeToString: () => "string",
                }),
                getSourceFile: () => sf,
            };
        },
        getPositionOfLineAndCharacter: () => 0,
        forEachChild: (node: any, cb: any) => node.forEachChild(cb),
    };
    const checker = new TypeCheckerImpl(() => Promise.resolve(fakeTs));
    await checker.initForSource("const x = 1;\n");
    assertEquals(checker.getTypeAtPosition(1, 6), null);
});

Deno.test("TypeCheckerImpl handles createProgram throwing", async () => {
    const fakeTs = {
        ScriptTarget: { Latest: 99 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        createCompilerHost: () => ({ getSourceFile: () => null }),
        createSourceFile: () => ({}),
        createProgram: () => {
            throw new Error("boom");
        },
        getPositionOfLineAndCharacter: () => 0,
        forEachChild: () => {},
    };
    const checker = new TypeCheckerImpl(() => Promise.resolve(fakeTs));
    await checker.initForSource("const x = 1;\n");
    assertEquals(checker.getTypeAtPosition(1, 6), null);
});

Deno.test("parseTypeString produces number type annotation", () => {
    const annotation = parseTypeString("number");
    assertEquals(annotation.type, "TSTypeAnnotation");
    assertEquals(annotation.typeAnnotation.type, "TSNumberKeyword");
});

Deno.test("parseTypeString produces generic type annotation", () => {
    const annotation = parseTypeString("Map<string, number>");
    assertEquals(annotation.type, "TSTypeAnnotation");
    assertEquals(annotation.typeAnnotation.type, "TSTypeReference");
    assertEquals(annotation.typeAnnotation.typeName.name, "Map");
});

Deno.test("parseTypeString produces array type annotation", () => {
    const annotation = parseTypeString("string[]");
    assertEquals(annotation.type, "TSTypeAnnotation");
    assertEquals(annotation.typeAnnotation.type, "TSArrayType");
});

Deno.test("parseTypeString produces union type annotation", () => {
    const annotation = parseTypeString("string | number");
    assertEquals(annotation.type, "TSTypeAnnotation");
    assertEquals(annotation.typeAnnotation.type, "TSUnionType");
});

Deno.test("parseTypeString throws for invalid type string", () => {
    let threw = false;
    try {
        parseTypeString("!!!invalid!!!");
    } catch {
        threw = true;
    }
    assert(threw);
});
