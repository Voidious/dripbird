// deno-lint-ignore-file no-explicit-any
/**
 * Placement resolution for cross-file duplicate extraction (0.3.3).
 *
 * A duplicate group's helper is extracted into a shared module placed in
 * the deepest common ancestor directory of the involved files, under a
 * boring shared directory name (`common` by default, with fallbacks).
 *
 * Cycle safety by construction:
 *
 * - The shared module only imports what the extracted helper needs: bare
 *   (package) specifiers move verbatim, relative specifiers are re-resolved
 *   from the shared module's location (or the group is skipped).
 * - Before writing an existing-or-proposed module, its import graph is
 *   walked (BFS); if any involved file is reachable, placement is rejected.
 *   Since involved files are the only files that will import the shared
 *   module, this proves no cycle can form.
 *
 * All file paths handled here are ABSOLUTE (baseDir joined by the caller).
 */
import { visit } from "recast";
import * as babelParser from "@babel/parser";
import {
    collectImportEdges,
    resolveRelativePath,
} from "./function_matcher_imports.ts";
import { isPropertyContext } from "./duplicate_extractor.ts";

function toPosix(path: string): string {
    return path.replace(/\\/g, "/");
}

/**
 * Deepest directory shared by every file path, as an absolute `/`-separated
 * path ("/" means the filesystem root; every segment cancelled out). An
 * empty input list yields "/".
 */
export function commonAncestorDir(files: string[]): string {
    if (files.length === 0) return "/";
    const dirs = files.map((f) => toPosix(f).split("/").slice(0, -1));
    // reduce (not a for-of over dirs.slice(1)): V8 attributes a for-of body
    // one range whose count is total iterations, which deno's complement
    // arithmetic turns into a phantom "never-empty loop" miss when some
    // calls iterate several times.
    const common = dirs.reduce((acc, dir) => {
        let i = 0;
        while (i < acc.length && i < dir.length && acc[i] === dir[i]) {
            i++;
        }
        return acc.slice(0, i);
    });
    return common.join("/") || "/";
}

/**
 * Relative import specifier for `fromFile` to import `toFile` (both
 * absolute, `/`-separated), keeping the target's module extension:
 * explicit specifiers (`./common/helper.ts`) resolve under both Deno
 * (which requires them) and Node-style toolchains. Same-directory
 * imports keep the required `./` prefix.
 */
export function relativeSpecifier(fromFile: string, toFile: string): string {
    const from = toPosix(fromFile).split("/");
    const to = toPosix(toFile).split("/");
    const fromDir = from.slice(0, -1);
    const toDir = to.slice(0, -1);
    const name = to[to.length - 1];

    let i = 0;
    while (i < fromDir.length && i < toDir.length && fromDir[i] === toDir[i]) {
        i++;
    }
    const ups = fromDir.length - i;
    const prefix = ups === 0 ? ["."] : Array<string>(ups).fill("..");
    return [...prefix, ...toDir.slice(i), name].join("/");
}

/**
 * Pick the first candidate shared directory under `ancestorDir` that is
 * usable: a path that is not already a regular file. Candidates are tried
 * in order (e.g. `common`, then backups). Returns the chosen directory
 * name, or null when every candidate is blocked.
 */
export async function pickSharedDir(
    candidateDirs: string[],
    ancestorDir: string,
    isFile: (path: string) => Promise<boolean>,
): Promise<string | null> {
    const base = ancestorDir.endsWith("/") ? ancestorDir : `${ancestorDir}/`;
    for (const dir of candidateDirs) {
        if (!(await isFile(`${base}${dir}`))) return dir;
    }
    return null;
}

export interface MovableImport {
    /** Import specifier usable from the shared module. */
    specifier: string;
}

/**
 * Decide whether an import used by a duplicate block can move to the shared
 * module:
 *
 * - Bare specifiers (package names, `npm:`/`@std/` URIs) move verbatim.
 * - Relative specifiers are resolved against the ORIGINAL importing file to
 *   find the actual target file; the shared module then imports that same
 *   file via a fresh relative specifier. If the original specifier resolves
 *   to nothing on disk, the import cannot be proven safe and the group is
 *   skipped.
 *
 * Returns the rewritten specifier, or null when the import is unmovable.
 */
export async function checkImportMovable(
    originalSpecifier: string,
    originalFile: string,
    sharedModulePath: string,
    readFile: (path: string) => Promise<string | null>,
): Promise<MovableImport | null> {
    const specifier = toPosix(originalSpecifier);
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        return { specifier };
    }

    for (const candidate of resolveRelativePath(originalFile, specifier)) {
        if ((await readFile(candidate)) !== null) {
            return { specifier: relativeSpecifier(sharedModulePath, candidate) };
        }
    }
    return null;
}

function parseSource(source: string): any {
    return babelParser.parse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
    });
}

/**
 * Identifiers referenced by `statements` that resolve to import bindings of
 * `fileAst`. Approximate by name: an import binding name appearing as a
 * reference identifier in the block marks that import as used. A block-local
 * shadow of an import name is a rare false positive — it can only cause a
 * harmless extra import in the shared module, which review catches.
 */
export function collectUsedImportBindings(
    statements: any[],
    fileAst: any,
): Set<string> {
    const importNames = new Set<string>();
    for (const edge of collectImportEdges(fileAst)) {
        for (const local of edge.named.values()) importNames.add(local);
        if (edge.namespaceBinding) importNames.add(edge.namespaceBinding);
        if (edge.defaultBinding) importNames.add(edge.defaultBinding);
    }

    const used = new Set<string>();
    for (const stmt of statements) {
        visit(stmt, {
            visitIdentifier(path: any) {
                const parent = path.parent?.node;
                const node = path.node;
                if (parent && isPropertyContext(parent, node)) {
                    this.traverse(path);
                    return;
                }
                if (importNames.has(node.name)) used.add(node.name);
                this.traverse(path);
            },
        });
    }
    return used;
}

/** Bound on the cycle BFS so pathological graphs cannot hang dripbird. */
const MAX_CYCLE_VISITS = 200;

/**
 * Whether any file in `targets` is reachable from `moduleSource`'s import
 * graph (transitively, through relative imports only — bare specifiers are
 * external packages and can never reach project files). Returns false for
 * an unreadable/empty module (no edges) or when `targets` is unreached.
 */
export async function moduleReaches(
    modulePath: string,
    moduleSource: string | null,
    targets: Set<string>,
    readFile: (path: string) => Promise<string | null>,
): Promise<boolean> {
    if (moduleSource === null) return false;

    const visited = new Set<string>([toPosix(modulePath)]);
    const queue: Array<{ path: string; source: string }> = [
        { path: toPosix(modulePath), source: moduleSource },
    ];

    while (queue.length > 0 && visited.size < MAX_CYCLE_VISITS) {
        const { path, source } = queue.shift()!;

        let ast: any;
        try {
            ast = parseSource(source);
        } catch {
            continue;
        }

        // collectImportEdges only yields relative specifiers — bare imports
        // are external packages and can never reach project files.
        for (const edge of collectImportEdges(ast)) {
            for (const candidate of resolveRelativePath(path, edge.specifier)) {
                const next = toPosix(candidate);
                if (visited.has(next)) break;
                const content = await readFile(candidate);
                if (content === null) continue;
                if (targets.has(next)) return true;
                visited.add(next);
                queue.push({ path: next, source: content });
                break;
            }
        }
    }
    return false;
}
