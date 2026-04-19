import { assertEquals } from "@std/assert";
import { filterRefactors, loadConfig } from "../src/config.ts";
import type { Config, NamedRefactor } from "../src/config.ts";
import type { Refactor } from "../src/engine.ts";

const noop: Refactor = (_source, _ranges) => ({
    changed: false,
    source: _source,
    description: "",
});

function partialConfig(
    opts: Partial<Pick<Config, "enabled_refactors" | "disabled_refactors">>,
): Config {
    return {
        max_function_lines: 75,
        provider: "moonshot",
        model: "kimi-k2.5",
        enabled_refactors: opts.enabled_refactors ?? [],
        disabled_refactors: opts.disabled_refactors ?? [],
    };
}

Deno.test("loadConfig returns defaults with no config files", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        const config = loadConfig(tempDir);
        assertEquals(config, {
            max_function_lines: 75,
            provider: "moonshot",
            model: "kimi-k2.5",
            enabled_refactors: [],
            disabled_refactors: [],
        });
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig reads from dripbird.yml", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "max_function_lines: 50\nprovider: openai\n",
        );
        const config = loadConfig(tempDir);
        assertEquals(config.max_function_lines, 50);
        assertEquals(config.provider, "openai");
        assertEquals(config.model, "kimi-k2.5");
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig local override wins over committed", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "max_function_lines: 50\nprovider: openai\n",
        );
        Deno.writeTextFileSync(
            `${tempDir}/.dripbird.yml`,
            "model: gpt-4\n",
        );
        const config = loadConfig(tempDir);
        assertEquals(config.max_function_lines, 50);
        assertEquals(config.provider, "openai");
        assertEquals(config.model, "gpt-4");
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig ignores invalid yaml", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "not: valid: yaml: [",
        );
        const config = loadConfig(tempDir);
        assertEquals(config.max_function_lines, 75);
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig ignores non-object yaml", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(`${tempDir}/dripbird.yml`, "42");
        const config = loadConfig(tempDir);
        assertEquals(config.max_function_lines, 75);
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig ignores yaml array", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(`${tempDir}/dripbird.yml`, "- foo\n- bar\n");
        const config = loadConfig(tempDir);
        assertEquals(config.max_function_lines, 75);
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig ignores wrong types for fields", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            'max_function_lines: "not a number"\nprovider: 123\n',
        );
        const config = loadConfig(tempDir);
        assertEquals(config.max_function_lines, 75);
        assertEquals(config.provider, "moonshot");
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig reads enabled_refactors", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "enabled_refactors:\n  - if_not_else\n",
        );
        const config = loadConfig(tempDir);
        assertEquals(config.enabled_refactors, ["if_not_else"]);
        assertEquals(config.disabled_refactors, []);
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig reads disabled_refactors", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "disabled_refactors:\n  - function_splitter\n",
        );
        const config = loadConfig(tempDir);
        assertEquals(config.enabled_refactors, []);
        assertEquals(config.disabled_refactors, ["function_splitter"]);
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("loadConfig ignores non-string arrays for refactor lists", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        Deno.writeTextFileSync(
            `${tempDir}/dripbird.yml`,
            "enabled_refactors:\n  - 123\n  - foo\n",
        );
        const config = loadConfig(tempDir);
        assertEquals(config.enabled_refactors, []);
    } finally {
        Deno.removeSync(tempDir, { recursive: true });
    }
});

Deno.test("filterRefactors returns all when both lists empty", () => {
    const refactors: NamedRefactor[] = [
        { name: "if_not_else", refactor: noop },
        { name: "function_splitter", refactor: noop },
    ];
    const result = filterRefactors(refactors, partialConfig({}));
    assertEquals(result.length, 2);
});

Deno.test("filterRefactors filters by enabled_refactors", () => {
    const refactors: NamedRefactor[] = [
        { name: "if_not_else", refactor: noop },
        { name: "function_splitter", refactor: noop },
    ];
    const result = filterRefactors(
        refactors,
        partialConfig({ enabled_refactors: ["if_not_else"] }),
    );
    assertEquals(result.length, 1);
});

Deno.test("filterRefactors filters by disabled_refactors", () => {
    const refactors: NamedRefactor[] = [
        { name: "if_not_else", refactor: noop },
        { name: "function_splitter", refactor: noop },
    ];
    const result = filterRefactors(
        refactors,
        partialConfig({ disabled_refactors: ["function_splitter"] }),
    );
    assertEquals(result.length, 1);
});

Deno.test("filterRefactors enabled takes precedence over disabled", () => {
    const refactors: NamedRefactor[] = [
        { name: "if_not_else", refactor: noop },
        { name: "function_splitter", refactor: noop },
    ];
    const result = filterRefactors(
        refactors,
        partialConfig({
            enabled_refactors: ["if_not_else"],
            disabled_refactors: ["if_not_else"],
        }),
    );
    assertEquals(result.length, 0);
});
