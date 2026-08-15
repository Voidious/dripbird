// deno-lint-ignore-file no-explicit-any
/**
 * Cross-file support for the function matcher.
 *
 * dripbird only ever calls a function in another file when the current file
 * ALREADY imports that file via a relative specifier (`./` / `../`), and it
 * reuses the existing import binding — it never adds or rewrites imports.
 * Since no new module dependency edge is ever introduced, cross-file matching
 * can never create a circular dependency.
 */
import type { FunctionInfo } from "./function_matcher.ts";

export interface ImportEdge {
    /** Raw module specifier as written in the import statement. */
    specifier: string;
    /** Exported name -> local binding in the importing file. */
    named: Map<string, string>;
    /** Binding for `import * as ns from ...`, else null. */
    namespaceBinding: string | null;
    /** Binding for the default import, else null. */
    defaultBinding: string | null;
}

/**
 * Collect relative import edges from a parsed module. Bare specifiers
 * (`npm:...`, `@std/...`, package names) are skipped: only files whose path
 * can be resolved relative to the importing file are candidates, and only
 * imports that actually bind a name (named, namespace, or default) can be
 * called through. Multiple import statements for the same specifier are
 * merged. Type-only imports are skipped — their bindings have no runtime
 * value.
 */
export function collectImportEdges(ast: any): ImportEdge[] {
    const edges = new Map<string, ImportEdge>();

    for (const stmt of ast.program.body) {
        if (stmt.type !== "ImportDeclaration") continue;
        const specifier = stmt.source?.value;
        if (typeof specifier !== "string") continue;
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
        if (stmt.importKind === "type") continue;

        const edge: ImportEdge = edges.get(specifier) ?? {
            specifier,
            named: new Map<string, string>(),
            namespaceBinding: null,
            defaultBinding: null,
        };

        for (const spec of stmt.specifiers ?? []) {
            if (spec.type === "ImportSpecifier") {
                if (spec.importKind === "type") continue;
                if (
                    spec.imported?.type === "Identifier" &&
                    spec.local?.type === "Identifier"
                ) {
                    edge.named.set(spec.imported.name, spec.local.name);
                }
            } else if (spec.type === "ImportDefaultSpecifier") {
                if (spec.local?.type === "Identifier") {
                    edge.defaultBinding = spec.local.name;
                }
            } else if (spec.type === "ImportNamespaceSpecifier") {
                if (spec.local?.type === "Identifier") {
                    edge.namespaceBinding = spec.local.name;
                }
            }
        }

        if (
            edge.named.size > 0 || edge.namespaceBinding !== null ||
            edge.defaultBinding !== null
        ) {
            edges.set(specifier, edge);
        }
    }

    return [...edges.values()];
}

const EXTENSION_CANDIDATES = [
    "",
    ".ts",
    ".tsx",
    ".mts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
];

const INDEX_CANDIDATES = ["/index.ts", "/index.tsx", "/index.js"];

/**
 * Resolve a relative import specifier against the importing file's path and
 * return the candidate file paths to probe, in TypeScript resolution order
 * (extension variants first, then directory index files). Returns an empty
 * list when the specifier escapes the filesystem root.
 */
export function resolveRelativePath(
    baseFilePath: string,
    specifier: string,
): string[] {
    const base = baseFilePath.replace(/\\/g, "/");
    const isAbsolute = base.startsWith("/");
    const slash = base.lastIndexOf("/");
    const dir = slash === -1 ? "" : base.slice(0, slash);
    const joined = `${dir}/${specifier}`.replace(/\\/g, "/");

    const segments: string[] = [];
    for (const part of joined.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (
                segments.length === 0 ||
                segments[segments.length - 1] === ".."
            ) {
                return [];
            }
            segments.pop();
            continue;
        }
        segments.push(part);
    }

    const path = (isAbsolute ? "/" : "") + segments.join("/");
    return [
        ...EXTENSION_CANDIDATES.map((ext) => `${path}${ext}`),
        ...INDEX_CANDIDATES.map((index) => `${path}${index}`),
    ];
}

/**
 * Read the file a relative import points at, trying each candidate path in
 * order. Returns the file's source, or null when no candidate is readable.
 */
export async function resolveImportTarget(
    baseFilePath: string,
    specifier: string,
    readFile: (path: string) => Promise<string | null>,
): Promise<string | null> {
    for (const candidate of resolveRelativePath(baseFilePath, specifier)) {
        const content = await readFile(candidate);
        if (content !== null) return content;
    }
    return null;
}

export interface ModuleExports {
    /** Target-file local name -> name it is exported under. */
    named: Map<string, string>;
    /** Local name of the default-exported declaration, if any. */
    defaultLocal: string | null;
}

/**
 * Describe what a module exports, as seen from its own top-level export
 * statements: inline `export function/class/const`, `export { a as b }`
 * specifier lists, and `export default function/class name`. Only exported
 * declarations are callable from another file.
 */
export function describeExports(ast: any): ModuleExports {
    const named = new Map<string, string>();
    let defaultLocal: string | null = null;

    for (const stmt of ast.program.body) {
        if (stmt.type === "ExportNamedDeclaration") {
            const decl = stmt.declaration;
            if (decl) {
                if (
                    (decl.type === "FunctionDeclaration" ||
                        decl.type === "ClassDeclaration") && decl.id
                ) {
                    named.set(decl.id.name, decl.id.name);
                } else if (decl.type === "VariableDeclaration") {
                    for (const d of decl.declarations) {
                        if (d.id?.type === "Identifier") {
                            named.set(d.id.name, d.id.name);
                        }
                    }
                }
            }
            for (const spec of stmt.specifiers ?? []) {
                if (
                    spec.local?.type === "Identifier" &&
                    spec.exported?.type === "Identifier"
                ) {
                    named.set(spec.local.name, spec.exported.name);
                }
            }
        } else if (stmt.type === "ExportDefaultDeclaration") {
            const id = stmt.declaration?.id;
            if (id?.name) defaultLocal = id.name;
        }
    }

    return { named, defaultLocal };
}

/**
 * Map functions collected from an imported file onto bindings in the
 * importing file. A function is only kept when the importing file already
 * holds a usable binding for its export: a named import (alias-aware), the
 * default import for a default export, or `ns.exportName` for a namespace
 * import. Class members are renamed to `Binding.method` so call sites and
 * instance-reference lookups use the importing file's binding name.
 */
export function remapExternalFunctions(
    fns: FunctionInfo[],
    edge: ImportEdge,
    exports: ModuleExports,
    origin: string,
): FunctionInfo[] {
    const out: FunctionInfo[] = [];

    for (const fn of fns) {
        const isMember = fn.kind !== "function";
        const localName = isMember ? fn.className! : fn.name;
        const methodName = isMember
            ? fn.name.slice(fn.className!.length + 1)
            : null;

        const exportName = exports.named.get(localName) ?? null;
        const isDefault = exportName === null &&
            exports.defaultLocal === localName;

        let binding: string | null = null;
        if (exportName !== null && edge.named.has(exportName)) {
            binding = edge.named.get(exportName)!;
        } else if (isDefault && edge.defaultBinding !== null) {
            binding = edge.defaultBinding;
        } else if (exportName !== null && edge.namespaceBinding !== null) {
            binding = `${edge.namespaceBinding}.${exportName}`;
        }
        if (binding === null) continue;

        if (!isMember) {
            out.push({ ...fn, isLocal: false, callName: binding, origin });
        } else {
            out.push({
                ...fn,
                isLocal: false,
                origin,
                name: `${binding}.${methodName}`,
                className: binding,
                callName: fn.kind === "staticMethod"
                    ? `${binding}.${methodName}`
                    : `this.${methodName}`,
            });
        }
    }

    return out;
}
