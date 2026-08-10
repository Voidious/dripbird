// deno-lint-ignore-file no-explicit-any no-this-alias
import * as babelParser from "@babel/parser";

export interface TypeDiagnostic {
    code: number;
    message: string;
    line: number;
    column: number;
}

export interface TypeChecker {
    initForSource(source: string, filePath?: string): Promise<void>;
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
    private _loadTs: () => Promise<any>;

    constructor(loadTs?: () => Promise<any>) {
        this._loadTs = loadTs ?? (async () => {
            const mod = await import("typescript");
            return mod.default;
        });
    }

    async initForSource(source: string, filePath?: string): Promise<void> {
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
        const ts = this.ts;
        const targetPath = filePath ?? "/__dripbird_virtual__.ts";
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
        const self = this;
        host.getSourceFile = (
            fileName: string,
            languageVersion: any,
            onError?: any,
        ) => {
            if (self.matchesPath(fileName, targetPath)) {
                return ts.createSourceFile(
                    fileName,
                    source,
                    languageVersion,
                    true,
                );
            }
            return origGetSourceFile(fileName, languageVersion, onError);
        };
        try {
            this.program = ts.createProgram({
                rootNames: [targetPath],
                options: compilerOptions,
                host,
            });
            this.checker = this.program.getTypeChecker();
            this.sourceFile = this.program.getSourceFile(targetPath) ??
                null;
            this.targetPath = targetPath;
        } catch {
            this.program = null;
            this.checker = null;
            this.sourceFile = null;
            this.targetPath = null;
        }
    }

    getSemanticErrors(): TypeDiagnostic[] {
        if (!this.ts || !this.program || !this.sourceFile) {
            return [];
        }
        const ts = this.ts;
        const target = this.targetPath!.replace(/\\/g, "/");
        try {
            const diags = ts.getPreEmitDiagnostics(this.program);
            const result: TypeDiagnostic[] = [];
            for (const d of diags) {
                if (!d.file) continue;
                if (d.file.fileName.replace(/\\/g, "/") !== target) continue;
                const pos = d.start ?? 0;
                const lc = d.file.getLineAndCharacterOfPosition(pos);
                result.push({
                    code: d.code,
                    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
                    line: lc.line + 1,
                    column: lc.character + 1,
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
    }

    private matchesPath(fileName: string, targetPath: string): boolean {
        return fileName.replace(/\\/g, "/") === targetPath.replace(/\\/g, "/");
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
