import { assertEquals } from "@std/assert";
import { loadConfig } from "../src/config.ts";

Deno.test("loadConfig returns defaults with no config files", () => {
    const tempDir = Deno.makeTempDirSync();
    try {
        const config = loadConfig(tempDir);
        assertEquals(config, {
            max_function_lines: 75,
            provider: "moonshot",
            model: "kimi-k2.5",
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
