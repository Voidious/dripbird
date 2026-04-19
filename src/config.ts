import { parse as parseYaml } from "@std/yaml";

export interface Config {
    max_function_lines: number;
    provider: string;
    model: string;
}

const DEFAULTS: Config = {
    max_function_lines: 75,
    provider: "moonshot",
    model: "kimi-k2.5",
};

function readYamlFile(filePath: string): Record<string, unknown> | null {
    try {
        const text = Deno.readTextFileSync(filePath);
        const parsed = parseYaml(text);
        if (
            typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}

function mergeConfig(
    base: Config,
    ...overrides: (Record<string, unknown> | null)[]
): Config {
    const result = { ...base };
    for (const override of overrides) {
        if (!override) continue;
        if (typeof override.max_function_lines === "number") {
            result.max_function_lines = override.max_function_lines;
        }
        if (typeof override.provider === "string") {
            result.provider = override.provider;
        }
        if (typeof override.model === "string") {
            result.model = override.model;
        }
    }
    return result;
}

export function loadConfig(baseDir: string): Config {
    const committed = readYamlFile(`${baseDir}/dripbird.yml`);
    const local = readYamlFile(`${baseDir}/.dripbird.yml`);
    return mergeConfig(DEFAULTS, committed, local);
}
