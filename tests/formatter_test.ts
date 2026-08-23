import { assertEquals } from "@std/assert";
import {
    type CommandRunner,
    createOutputFormatter,
    denoCommandRunner,
    formattableExt,
} from "../src/formatter.ts";

Deno.test("formattableExt allows TypeScript and JavaScript extensions", () => {
    assertEquals(formattableExt("a.ts"), "ts");
    assertEquals(formattableExt("dir/b.tsx"), "tsx");
    assertEquals(formattableExt("x.js"), "js");
    assertEquals(formattableExt("x.jsx"), "jsx");
});

Deno.test("formattableExt rejects other extensions and bare names", () => {
    assertEquals(formattableExt("README.md"), null);
    assertEquals(formattableExt("deno.json"), null);
    assertEquals(formattableExt("script.py"), null);
    assertEquals(formattableExt("Dockerfile"), null);
    assertEquals(formattableExt(".ts"), null);
});

function fakeRunner(
    exitByArgs: (args: string[]) => number | Promise<number>,
): {
    run: CommandRunner;
    calls: Array<{ name: string; options: Deno.CommandOptions }>;
} {
    const calls: Array<{ name: string; options: Deno.CommandOptions }> = [];
    const run: CommandRunner = async (name, options) => {
        calls.push({ name, options });
        return { code: await exitByArgs(options.args ?? []) };
    };
    return { run, calls };
}

Deno.test("createOutputFormatter checks cleanliness via deno fmt --check", async () => {
    const { run, calls } = fakeRunner((args) => args.includes("--check") ? 0 : 1);
    const formatter = createOutputFormatter("/repo", run);

    assertEquals(await formatter.isClean("/repo/src/a.ts"), true);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].name, "deno");
    assertEquals(calls[0].options.args, ["fmt", "--check", "/repo/src/a.ts"]);
    assertEquals(calls[0].options.cwd, "/repo");
});

Deno.test("createOutputFormatter treats a failed check as not clean", async () => {
    const { run } = fakeRunner(() => 1);
    const formatter = createOutputFormatter("/repo", run);
    assertEquals(await formatter.isClean("/repo/src/a.ts"), false);
});

Deno.test("createOutputFormatter formats files via deno fmt", async () => {
    const { run, calls } = fakeRunner((args) => args.includes("--check") ? 1 : 0);
    const formatter = createOutputFormatter("/repo", run);

    assertEquals(await formatter.format("/repo/src/a.ts"), true);
    assertEquals(calls[0].options.args, ["fmt", "/repo/src/a.ts"]);
});

Deno.test("createOutputFormatter reports failed format runs", async () => {
    const { run } = fakeRunner(() => 1);
    const formatter = createOutputFormatter("/repo", run);
    assertEquals(await formatter.format("/repo/src/a.ts"), false);
});

Deno.test("createOutputFormatter never touches non-formattable paths", async () => {
    const { run, calls } = fakeRunner(() => 0);
    const formatter = createOutputFormatter("/repo", run);

    assertEquals(await formatter.isClean("/repo/README.md"), false);
    assertEquals(await formatter.format("/repo/README.md"), false);
    assertEquals(calls.length, 0);
});

Deno.test("createOutputFormatter survives an unspawnable binary", async () => {
    const run: CommandRunner = () => Promise.reject(new Error("no deno"));
    const formatter = createOutputFormatter("/repo", run);
    assertEquals(await formatter.isClean("/repo/src/a.ts"), false);
    assertEquals(await formatter.format("/repo/src/a.ts"), false);
});

Deno.test("denoCommandRunner returns the subprocess exit code", async () => {
    // A real spawn that always fails: `deno fmt` exits non-zero for a
    // file it cannot parse. Also covers the happy path via a clean file.
    const tempDir = await Deno.makeTempDir();
    try {
        const bad = `${tempDir}/bad.ts`;
        await Deno.writeTextFile(bad, "this is not valid (\n");
        assertEquals(
            await denoCommandRunner("deno", {
                args: ["fmt", bad],
                cwd: tempDir,
                stdout: "null",
                stderr: "null",
            }),
            { code: 1 },
        );
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("createOutputFormatter formats and verifies real files", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
        const file = `${tempDir}/a.ts`;
        await Deno.writeTextFile(file, "const a=1;\n");
        const formatter = createOutputFormatter(tempDir);

        assertEquals(await formatter.isClean(file), false);
        assertEquals(await formatter.format(file), true);
        assertEquals(await Deno.readTextFile(file), "const a = 1;\n");
        assertEquals(await formatter.isClean(file), true);
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});
