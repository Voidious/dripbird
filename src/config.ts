import { parse as parseYaml } from "@std/yaml";
import type { NamedRefactor } from "./engine.ts";

export interface Config {
    max_function_lines: number;
    function_splitter_retries: number;
    function_matcher_retries: number;
    duplicate_extractor_min_lines: number;
    duplicate_extractor_max_lines: number;
    duplicate_extractor_retries: number;
    provider: string;
    model: string;
    enabled_refactors: string[];
    disabled_refactors: string[];
    verbose: boolean;
}

export function filterRefactors(
    refactors: NamedRefactor[],
    config: Config,
): NamedRefactor[] {
    const { enabled_refactors, disabled_refactors } = config;
    let filtered: NamedRefactor[] = refactors;
    if (enabled_refactors.length > 0) {
        const enabled = new Set(enabled_refactors);
        filtered = filtered.filter((r) => enabled.has(r.name));
    }
    if (disabled_refactors.length > 0) {
        const disabled = new Set(disabled_refactors);
        filtered = filtered.filter((r) => !disabled.has(r.name));
    }
    return filtered;
}

const DEFAULTS: Config = {
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

function isStringArray(val: unknown): val is string[] {
    return Array.isArray(val) && val.every((v) => typeof v === "string");
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
        if (typeof override.function_splitter_retries === "number") {
            result.function_splitter_retries = override.function_splitter_retries;
        }
        if (typeof override.function_matcher_retries === "number") {
            result.function_matcher_retries = override.function_matcher_retries;
        }
        if (typeof override.duplicate_extractor_min_lines === "number") {
            result.duplicate_extractor_min_lines =
                override.duplicate_extractor_min_lines;
        }
        if (typeof override.duplicate_extractor_max_lines === "number") {
            result.duplicate_extractor_max_lines =
                override.duplicate_extractor_max_lines;
        }
        if (typeof override.duplicate_extractor_retries === "number") {
            result.duplicate_extractor_retries =
                override.duplicate_extractor_retries;
        }
        if (typeof override.provider === "string") {
            result.provider = override.provider;
        }
        if (typeof override.model === "string") {
            result.model = override.model;
        }
        if (isStringArray(override.enabled_refactors)) {
            result.enabled_refactors = override.enabled_refactors;
        }
        if (isStringArray(override.disabled_refactors)) {
            result.disabled_refactors = override.disabled_refactors;
        }
        if (typeof override.verbose === "boolean") {
            result.verbose = override.verbose;
        }
    }
    return result;
}

export function loadConfig(baseDir: string): Config {
    const committed = readYamlFile(`${baseDir}/dripbird.yml`);
    const local = readYamlFile(`${baseDir}/.dripbird.yml`);
    return mergeConfig(DEFAULTS, committed, local);
}
