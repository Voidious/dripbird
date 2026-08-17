// deno-lint-ignore-file no-explicit-any
import * as babelParser from "@babel/parser";

export interface TypeDiagnostic {
    code: number;
    message: string;
    line: number;
    column: number;
    /** Absolute path of the file the diagnostic came from (multi-file init). */
    file?: string;
}

export interface TypeChecker {
    initForSource(source: string, filePath?: string): Promise<void>;
    /**
     * Virtualize several files at once at their real absolute paths, so
     * imports between them (and to on-disk files) resolve. Optional:
     * single-file callers only need initForSource. After this,
     * getSemanticErrors covers every virtualized file.
     */
    initForFiles?(entries: Array<{ path: string; source: string }>): Promise<void>;
    getTypeAtPosition(line: number, column: number): string | null;
    /**
     * Semantic (and syntactic) diagnostics for the most recently
     * initForSource-loaded file, scoped to THAT file only. Diagnostics from
     * other modules or lib files are excluded so callers can compare a
     * before/after baseline without cross-file noise. Returns [] when the
     * checker is unavailable (e.g. the TS module failed to load).
     */
    getSemanticErrors(): TypeDiagnostic[];
    dispose(): void;
}

export class TypeCheckerImpl implements TypeChecker {
    private ts: any = null;
    private loadError = false;
    private program: any = null;
    private checker: any = null;
    private sourceFile: any = null;
    private targetPath: string | null = null;
    /** Virtualized path -> source (posix-normalized); diagnostics come from these files only. */
    private virtualFiles = new Map<string, string>();
    private _loadTs: () => Promise<any>;

    constructor(loadTs?: () => Promise<any>) {
        this._loadTs = loadTs ?? (async () => {
            const mod = await import("typescript");
            return mod.default;
        });
    }

    async initForSource(source: string, filePath?: string): Promise<void> {
        const targetPath = filePath ?? "/__dripbird_virtual__.ts";
        await this.init(new Map([[targetPath, source]]), new Set([targetPath]));
    }

    async initForFiles(
        entries: Array<{ path: string; source: string }>,
    ): Promise<void> {
        const files = new Map<string, string>();
        for (const { path, source } of entries) {
            files.set(path.replace(/\\/g, "/"), source);
        }
        await this.init(files, new Set(files.keys()));
    }

    private async init(
        files: Map<string, string>,
        targets: Set<string>,
    ): Promise<void> {
        if (this.loadError) return;
        try {
            if (!this.ts) {
                this.ts = await this._loadTs();
            }
        } catch {
            this.loadError = true;
            return;
        }
        this.program = null;
        this.checker = null;
        this.sourceFile = null;
        this.targetPath = null;
        this.virtualFiles = files;
        const ts = this.ts;
        const rootNames = [...files.keys()];
        const compilerOptions = {
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            skipLibCheck: true,
        };
        const host = ts.createCompilerHost(compilerOptions, true);
        const origGetSourceFile = host.getSourceFile.bind(host);
        const origFileExists = host.fileExists?.bind(host);
        const origReadFile = host.readFile?.bind(host);
        const origDirectoryExists = host.directoryExists?.bind(host);
        const virtual = this.virtualFiles;
        host.getSourceFile = (
            fileName: string,
            languageVersion: any,
            onError?: any,
        ) => {
            const source = virtual.get(fileName.replace(/\\/g, "/"));
            if (source !== undefined) {
                return ts.createSourceFile(
                    fileName,
                    source,
                    languageVersion,
                    true,
                );
            }
            return origGetSourceFile(fileName, languageVersion, onError);
        };
        if (origFileExists) {
            host.fileExists = (fileName: string) =>
                virtual.has(fileName.replace(/\\/g, "/")) ||
                origFileExists(fileName);
        }
        if (origReadFile) {
            host.readFile = (fileName: string) =>
                virtual.get(fileName.replace(/\\/g, "/")) ??
                    origReadFile(fileName);
        }
        if (origDirectoryExists) {
            host.directoryExists = (fileName: string) => {
                const dir = fileName.replace(/\\/g, "/");
                if ([...virtual.keys()].some((p) => p.startsWith(`${dir}/`))) {
                    return true;
                }
                return origDirectoryExists(fileName);
            };
        }
        try {
            this.program = ts.createProgram({
                rootNames,
                options: compilerOptions,
                host,
            });
            this.checker = this.program.getTypeChecker();
            this.targetPath = targets.size === 1 ? [...targets][0] : null;
            // getTypeAtPosition is single-file only; multi-file inits leave
            // it without a target on purpose.
            this.sourceFile = this.targetPath !== null
                ? this.program.getSourceFile(this.targetPath) ?? null
                : null;
        } catch {
            this.program = null;
            this.checker = null;
            this.sourceFile = null;
            this.targetPath = null;
        }
    }

    getSemanticErrors(): TypeDiagnostic[] {
        if (!this.ts || !this.program || !this.virtualFiles.size) {
            return [];
        }
        const ts = this.ts;
        try {
            const diags = ts.getPreEmitDiagnostics(this.program);
            const result: TypeDiagnostic[] = [];
            for (const d of diags) {
                if (!d.file) continue;
                const fileName = d.file.fileName.replace(/\\/g, "/");
                if (!this.virtualFiles.has(fileName)) continue;
                const pos = d.start ?? 0;
                const lc = d.file.getLineAndCharacterOfPosition(pos);
                result.push({
                    code: d.code,
                    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
                    line: lc.line + 1,
                    column: lc.character + 1,
                    file: fileName,
                });
            }
            return result;
        } catch {
            return [];
        }
    }

    getTypeAtPosition(line: number, column: number): string | null {
        if (!this.ts || !this.checker || !this.sourceFile) return null;
        try {
            const pos = this.ts.getPositionOfLineAndCharacter(
                this.sourceFile,
                line - 1,
                column,
            );
            const node = findDeepestNodeAtPosition(
                this.ts,
                this.sourceFile,
                pos,
            );
            if (!node) return null;
            const type = this.checker.getTypeAtLocation(node);
            if (!type) return null;
            const typeString = this.checker.typeToString(type);
            if (
                typeString === "any" ||
                typeString === "error" ||
                typeString === "{}" ||
                typeString === "null" ||
                typeString === "undefined"
            ) {
                return null;
            }
            return typeString;
        } catch {
            return null;
        }
    }

    dispose(): void {
        this.program = null;
        this.checker = null;
        this.sourceFile = null;
        this.targetPath = null;
        this.virtualFiles = new Map();
    }
}

function findDeepestNodeAtPosition(
    ts: any,
    sourceFile: any,
    position: number,
): any {
    let best: any = null;
    function visit(node: any) {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        if (position >= start && position < end) {
            best = node;
            ts.forEachChild(node, visit);
        }
    }
    ts.forEachChild(sourceFile, visit);
    return best;
}

export function parseTypeString(typeStr: string): any {
    const code = `const _: ${typeStr} = null as any;`;
    const ast = babelParser.parse(code, {
        sourceType: "module",
        plugins: ["typescript"],
    });
    const stmt = ast.program.body[0] as any;
    return stmt.declarations[0].id.typeAnnotation;
}
