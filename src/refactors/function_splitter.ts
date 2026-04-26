// deno-lint-ignore-file no-explicit-any
import { parse, print, types, visit } from "recast";
import * as babelParser from "@babel/parser";
import type { ChangedRange } from "../diff.ts";
import type { Refactor, RefactorContext, RefactorResult } from "../engine.ts";
import type { Config } from "../config.ts";
import type { LLMClient } from "../llm.ts";
import type { TypeChecker } from "../type_checker.ts";
import { parseTypeString } from "../type_checker.ts";
import { inRange } from "./if_not_else.ts";

const b = types.builders;

interface SplitCandidate {
    splitIndex: number;
    params: string[];
}

interface FunctionInfo {
    node: any;
    parentBody: any[];
    bodyStatements: any[];
    originalParams: string[];
    type: "declaration" | "classMethod";
    className?: string;
}

export function collectPatternBindings(
    pattern: any,
    bindings: Set<string>,
): void {
    if (!pattern) return;
    switch (pattern.type) {
        case "Identifier":
            bindings.add(pattern.name);
            break;
        case "ObjectPattern":
            for (const prop of pattern.properties) {
                if (prop.type === "ObjectProperty") {
                    collectPatternBindings(prop.value, bindings);
                } else if (prop.type === "RestElement") {
                    collectPatternBindings(prop.argument, bindings);
                }
            }
            break;
        case "ArrayPattern":
            for (const elem of pattern.elements) {
                if (elem) collectPatternBindings(elem, bindings);
            }
            break;
        case "RestElement":
            collectPatternBindings(pattern.argument, bindings);
            break;
        case "AssignmentPattern":
            collectPatternBindings(pattern.left, bindings);
            break;
    }
}

export function collectAllBindings(stmts: any[]): Set<string> {
    const bindings = new Set<string>();
    for (const stmt of stmts) {
        visit(stmt, {
            visitVariableDeclaration(path) {
                for (const decl of path.node.declarations as any[]) {
                    collectPatternBindings((decl as any).id, bindings);
                }
                this.traverse(path);
            },
            visitFunctionDeclaration(path) {
                if (path.node.id) {
                    bindings.add((path.node.id as any).name as string);
                }
                return false;
            },
            visitFunctionExpression() {
                return false;
            },
            visitArrowFunctionExpression() {
                return false;
            },
            visitClassDeclaration(path) {
                if (path.node.id) {
                    bindings.add((path.node.id as any).name as string);
                }
                return false;
            },
        });
    }
    return bindings;
}

export function collectIdentifiers(stmts: any[]): Set<string> {
    const ids = new Set<string>();
    for (const stmt of stmts) {
        visit(stmt, {
            visitIdentifier(path) {
                const parent = path.parent.node;
                const node = path.node;
                if (
                    parent.type === "MemberExpression" &&
                    parent.property === node &&
                    !parent.computed
                ) {
                    this.traverse(path);
                    return;
                }
                if (
                    parent.type === "ObjectProperty" &&
                    parent.key === node &&
                    !parent.computed &&
                    !parent.shorthand
                ) {
                    this.traverse(path);
                    return;
                }
                if (
                    parent.type === "ObjectMethod" &&
                    parent.key === node &&
                    !parent.computed
                ) {
                    this.traverse(path);
                    return;
                }
                if (
                    (parent.type === "ClassMethod" ||
                        parent.type === "ClassPrivateMethod" ||
                        parent.type === "MethodDefinition" ||
                        parent.type === "PropertyDefinition") &&
                    parent.key === node &&
                    !parent.computed
                ) {
                    this.traverse(path);
                    return;
                }
                if (
                    parent.type === "LabeledStatement" &&
                    parent.label === node
                ) {
                    this.traverse(path);
                    return;
                }
                if (parent.type === "ExportSpecifier") {
                    this.traverse(path);
                    return;
                }
                if (
                    parent.type === "ImportSpecifier" &&
                    parent.local === node
                ) {
                    this.traverse(path);
                    return;
                }
                ids.add(node.name);
                this.traverse(path);
            },
        });
    }
    return ids;
}

function computeFreeVars(
    head: any[],
    tail: any[],
    originalParams: string[],
): string[] {
    const headBindings = collectAllBindings(head);
    const tailBindings = collectAllBindings(tail);
    const tailIds = collectIdentifiers(tail);
    const allDefs = new Set([...headBindings, ...originalParams]);
    const freeVars = new Set<string>();
    for (const id of tailIds) {
        if (allDefs.has(id) && !tailBindings.has(id)) {
            freeVars.add(id);
        }
    }
    return Array.from(freeVars).sort();
}

function returnsWithValue(stmts: any[]): boolean {
    let found = false;
    for (const stmt of stmts) {
        visit(stmt, {
            visitReturnStatement(path) {
                if (path.node.argument) found = true;
                this.traverse(path);
            },
        });
        if (found) return true;
    }
    return false;
}

function usesThis(stmts: any[]): boolean {
    let found = false;
    for (const stmt of stmts) {
        visit(stmt, {
            visitThisExpression() {
                found = true;
                return false;
            },
        });
        if (found) return true;
    }
    return false;
}

function hasNestedFunctionDecl(body: any[]): boolean {
    let found = false;
    for (const stmt of body) {
        visit(stmt, {
            visitFunctionDeclaration() {
                found = true;
                return false;
            },
        });
        if (found) return true;
    }
    return false;
}

export function getParamName(param: any): string | null {
    if (param.type === "Identifier") return param.name;
    if (param.type === "AssignmentPattern") return getParamName(param.left);
    if (param.type === "RestElement") return getParamName(param.argument);
    if (param.type === "TSParameterProperty") {
        return getParamName(param.parameter);
    }
    return null;
}

function getOriginalParams(node: any): string[] {
    return node.params
        .map(getParamName)
        .filter((p: string | null): p is string => p !== null);
}

function cloneAstNode(node: any): any {
    if (node === null || node === undefined) return node;
    if (typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(cloneAstNode);
    const result: any = {};
    for (const key of Object.keys(node)) {
        if (
            key === "loc" || key === "start" || key === "end" ||
            key === "tokens" || key === "comments"
        ) continue;
        result[key] = cloneAstNode(node[key]);
    }
    return result;
}

function findTypeAnnotationInPattern(pattern: any, name: string): any | null {
    if (pattern.type === "Identifier" && pattern.name === name) {
        return pattern.typeAnnotation || null;
    }
    return null;
}

function findIdentifierLoc(
    pattern: any,
    name: string,
): { line: number; column: number } | null {
    if (pattern.type === "Identifier" && pattern.name === name && pattern.loc) {
        return {
            line: pattern.loc.start.line,
            column: pattern.loc.start.column,
        };
    }
    if (pattern.type === "ObjectPattern") {
        for (const prop of pattern.properties) {
            if (prop.type === "ObjectProperty") {
                const loc = findIdentifierLoc(prop.value, name);
                if (loc) return loc;
            } else if (prop.type === "RestElement") {
                const loc = findIdentifierLoc(prop.argument, name);
                if (loc) return loc;
            }
        }
    }
    if (pattern.type === "ArrayPattern") {
        for (const elem of pattern.elements) {
            if (elem) {
                const loc = findIdentifierLoc(elem, name);
                if (loc) return loc;
            }
        }
    }
    if (pattern.type === "RestElement") {
        return findIdentifierLoc(pattern.argument, name);
    }
    if (pattern.type === "AssignmentPattern") {
        return findIdentifierLoc(pattern.left, name);
    }
    return null;
}

function findVarDeclLocation(
    name: string,
    headStmts: any[],
): { line: number; column: number } | null {
    for (const stmt of headStmts) {
        if (stmt.type === "VariableDeclaration") {
            for (const decl of stmt.declarations) {
                const loc = findIdentifierLoc(decl.id, name);
                if (loc) return loc;
            }
        }
    }
    return null;
}

function extractTypeFromParamNode(
    param: any,
    name: string,
): { typeAnnotation: any; optional: boolean } | null {
    if (param.type === "Identifier" && param.name === name) {
        if (param.typeAnnotation) {
            return {
                typeAnnotation: param.typeAnnotation,
                optional: !!param.optional,
            };
        }
        return null;
    }
    if (
        param.type === "AssignmentPattern" &&
        param.left?.type === "Identifier" &&
        param.left.name === name
    ) {
        if (param.left.typeAnnotation) {
            return {
                typeAnnotation: param.left.typeAnnotation,
                optional: !!param.left.optional,
            };
        }
        return null;
    }
    if (param.type === "RestElement") {
        if (
            param.argument?.type === "Identifier" &&
            param.argument.name === name &&
            param.typeAnnotation
        ) {
            return { typeAnnotation: param.typeAnnotation, optional: false };
        }
        return null;
    }
    return null;
}

function findTypeAnnotationForName(
    name: string,
    paramNodes: any[],
    headStmts: any[],
): { typeAnnotation: any; optional: boolean } | null {
    for (const param of paramNodes) {
        const result = extractTypeFromParamNode(param, name);
        if (result) return result;
    }
    const varDecls = headStmts.filter((s) => s.type === "VariableDeclaration");
    for (const stmt of varDecls) {
        for (const decl of stmt.declarations) {
            const ta = findTypeAnnotationInPattern(decl.id, name);
            if (ta) return { typeAnnotation: ta, optional: false };
        }
    }
    return null;
}

function buildTypedParams(
    paramNames: string[],
    originalParamNodes: any[],
    headStmts: any[],
    typeChecker?: TypeChecker,
): any[] {
    return paramNames.map((name) => {
        const param = b.identifier(name);
        const typeInfo = findTypeAnnotationForName(
            name,
            originalParamNodes,
            headStmts,
        );
        if (typeInfo?.typeAnnotation) {
            param.typeAnnotation = cloneAstNode(typeInfo.typeAnnotation);
            if (typeInfo.optional) param.optional = true;
        } else if (typeChecker) {
            const loc = findVarDeclLocation(name, headStmts);
            if (loc) {
                const typeStr = typeChecker.getTypeAtPosition(
                    loc.line,
                    loc.column,
                );
                if (typeStr) {
                    try {
                        param.typeAnnotation = cloneAstNode(
                            parseTypeString(typeStr),
                        );
                    } catch {
                        // skip unparseable type strings
                    }
                }
            }
        }
        return param;
    });
}

function isTrivialTail(tail: any[]): boolean {
    if (tail.length !== 1) return false;
    const stmt = tail[0];
    return (
        stmt.type === "ReturnStatement" &&
        stmt.argument?.type === "Identifier"
    );
}

function estimateResultLineCounts(
    splitIndex: number,
    bodyStmts: any[],
    funcStartLine: number,
): { originalLines: number; helperLines: number } {
    const headEndLine = bodyStmts[splitIndex - 1].loc.end.line;
    const tailStartLine = bodyStmts[splitIndex].loc.start.line;
    const tailEndLine = bodyStmts[bodyStmts.length - 1].loc.end.line;
    return {
        originalLines: headEndLine + 2 - funcStartLine,
        helperLines: tailEndLine - tailStartLine + 2,
    };
}

export function computeDiffCoverage(
    funcStartLine: number,
    funcEndLine: number,
    ranges: ChangedRange[],
): number {
    const totalLines = funcEndLine - funcStartLine + 1;
    if (totalLines <= 0) return 0;
    let coveredLines = 0;
    for (const range of ranges) {
        const overlapStart = Math.max(range.start, funcStartLine);
        const overlapEnd = Math.min(range.end, funcEndLine);
        if (overlapStart <= overlapEnd) {
            coveredLines += overlapEnd - overlapStart + 1;
        }
    }
    return coveredLines / totalLines;
}

export function getDiffStatementRange(
    bodyStmts: any[],
    ranges: ChangedRange[],
): { first: number; last: number } | null {
    let first = -1;
    let last = -1;
    for (let i = 0; i < bodyStmts.length; i++) {
        const stmt = bodyStmts[i];
        if (!stmt.loc) continue;
        const stmtStart = stmt.loc.start.line;
        const stmtEnd = stmt.loc.end.line;
        for (const range of ranges) {
            if (stmtStart <= range.end && stmtEnd >= range.start) {
                if (first === -1) first = i;
                last = i;
                break;
            }
        }
    }
    if (first === -1) return null;
    return { first, last };
}

function selectSplitPoints(
    bodyStmts: any[],
    bodyStartLine: number,
    maxLines: number,
    rng: () => number,
    count: number,
    restrictToRange?: { min: number; max: number },
): number[] {
    const validIndices: number[] = [];
    for (let i = 1; i < bodyStmts.length; i++) {
        const stmt = bodyStmts[i - 1];
        const headLines = stmt.loc.end.line - bodyStartLine;
        if (headLines <= maxLines) {
            if (
                restrictToRange &&
                (i < restrictToRange.min || i > restrictToRange.max)
            ) {
                continue;
            }
            validIndices.push(i);
        }
    }
    if (validIndices.length <= count) return validIndices;
    const selected: number[] = [];
    const available = [...validIndices];
    for (let i = 0; i < count && available.length > 0; i++) {
        const idx = Math.floor(rng() * available.length);
        selected.push(available[idx]);
        available.splice(idx, 1);
    }
    return selected;
}

export function getTailCode(
    source: string,
    tail: any[],
    node: any,
): string {
    if (!tail[0]?.loc) return "";
    const startLine = tail[0].loc.start.line;
    const endLine = node.loc.end.line;
    return source.split("\n").slice(startLine - 1, endLine).join("\n");
}

const JS_TS_KEYWORDS = new Set([
    "abstract",
    "any",
    "as",
    "asserts",
    "async",
    "await",
    "bigint",
    "boolean",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "constructor",
    "continue",
    "debugger",
    "declare",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "get",
    "if",
    "implements",
    "import",
    "in",
    "infer",
    "instanceof",
    "interface",
    "is",
    "keyof",
    "let",
    "module",
    "namespace",
    "never",
    "new",
    "null",
    "number",
    "object",
    "out",
    "override",
    "package",
    "private",
    "protected",
    "public",
    "readonly",
    "require",
    "return",
    "set",
    "static",
    "string",
    "super",
    "switch",
    "symbol",
    "this",
    "throw",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "unique",
    "unknown",
    "var",
    "void",
    "while",
    "with",
    "yield",
]);

export function collectFileLevelBindings(ast: any): Set<string> {
    const bindings = new Set<string>();
    for (const node of ast.program.body) {
        switch (node.type) {
            case "FunctionDeclaration":
                if (node.id) bindings.add(node.id.name);
                break;
            case "ClassDeclaration":
                if (node.id) bindings.add(node.id.name);
                break;
            case "VariableDeclaration":
                for (const decl of node.declarations) {
                    collectPatternBindings(decl.id, bindings);
                }
                break;
            case "ImportDeclaration":
                for (const spec of node.specifiers) {
                    bindings.add(spec.local.name);
                }
                break;
            case "TSTypeAliasDeclaration":
                bindings.add(node.id.name);
                break;
            case "TSInterfaceDeclaration":
                bindings.add(node.id.name);
                break;
            case "TSEnumDeclaration":
                bindings.add(node.id.name);
                break;
            case "TSModuleDeclaration":
                if (node.id?.type === "Identifier") {
                    bindings.add(node.id.name);
                }
                break;
        }
    }
    return bindings;
}

export function createFunctionSplitter(
    config: Config,
    llm: LLMClient,
    random?: () => number,
    typeChecker?: TypeChecker,
): Refactor {
    const rng = random ?? Math.random;
    const MAX_SPLIT_DEPTH = 5;

    return async (
        source: string,
        ranges: ChangedRange[],
        context?: RefactorContext,
    ): Promise<RefactorResult> => {
        let ast;
        try {
            ast = parse(source, {
                parser: {
                    parse(code: string) {
                        return babelParser.parse(code, {
                            sourceType: "module",
                            plugins: ["typescript", "jsx"],
                        });
                    },
                },
            });
        } catch {
            return { changed: false, source, description: "" };
        }

        const candidates: FunctionInfo[] = [];

        visit(ast, {
            visitFunctionDeclaration(path) {
                const node = path.node;
                if (
                    !node.loc ||
                    !inRange(
                        node.loc.start.line,
                        node.loc.end.line,
                        ranges,
                    )
                ) {
                    this.traverse(path);
                    return;
                }
                if (node.async || node.generator) {
                    this.traverse(path);
                    return;
                }
                if (!node.body?.body || node.body.body.length < 2) {
                    this.traverse(path);
                    return;
                }
                if (hasNestedFunctionDecl(node.body.body)) {
                    this.traverse(path);
                    return;
                }
                if (usesThis(node.body.body)) {
                    this.traverse(path);
                    return;
                }
                const bodyLines = node.loc.end.line - node.loc.start.line;
                if (bodyLines <= config.max_function_lines) {
                    this.traverse(path);
                    return;
                }
                candidates.push({
                    node,
                    parentBody: path.parent.node.body,
                    bodyStatements: node.body.body,
                    originalParams: getOriginalParams(node),
                    type: "declaration",
                });
                this.traverse(path);
            },

            visitClassMethod(path) {
                const node = path.node;
                if (node.kind === "constructor") {
                    this.traverse(path);
                    return;
                }
                if (
                    !node.loc ||
                    !inRange(
                        node.loc.start.line,
                        node.loc.end.line,
                        ranges,
                    )
                ) {
                    this.traverse(path);
                    return;
                }
                if (node.async || node.generator) {
                    this.traverse(path);
                    return;
                }
                if (!node.body?.body || node.body.body.length < 2) {
                    this.traverse(path);
                    return;
                }
                if (hasNestedFunctionDecl(node.body.body)) {
                    this.traverse(path);
                    return;
                }
                const bodyLines = node.loc.end.line - node.loc.start.line;
                if (bodyLines <= config.max_function_lines) {
                    this.traverse(path);
                    return;
                }
                const classDecl = path.parent?.parent?.node;
                const className = classDecl?.id?.name;
                candidates.push({
                    node,
                    parentBody: path.parent.node.body,
                    bodyStatements: node.body.body,
                    originalParams: getOriginalParams(node),
                    type: "classMethod",
                    className,
                });
                this.traverse(path);
            },
        });

        if (candidates.length === 0) {
            return { changed: false, source, description: "" };
        }

        if (typeChecker) {
            await typeChecker.initForSource(
                source,
                context?.filePath,
            );
        }

        candidates.sort(
            (a, b) => b.node.loc.start.line - a.node.loc.start.line,
        );

        const descriptions: string[] = [];
        const fileBindings = collectFileLevelBindings(ast);

        async function splitRecursively(
            candidate: FunctionInfo,
            coverage: number,
            depth: number,
        ): Promise<string[]> {
            if (depth >= MAX_SPLIT_DEPTH) return [];

            const {
                node,
                bodyStatements,
                originalParams,
                type,
                className,
            } = candidate;
            const funcStartLine = node.loc.start.line;
            const bodyStartLine = node.body.loc.start.line;

            let restrictToRange: { min: number; max: number } | undefined;
            if (coverage < 0.6) {
                const diffStmtRange = getDiffStatementRange(
                    bodyStatements,
                    ranges,
                );
                if (diffStmtRange) {
                    restrictToRange = {
                        min: Math.max(1, diffStmtRange.first),
                        max: Math.min(
                            bodyStatements.length - 1,
                            diffStmtRange.last + 1,
                        ),
                    };
                } else {
                    return [];
                }
            }

            const splitIndices = selectSplitPoints(
                bodyStatements,
                bodyStartLine,
                config.max_function_lines,
                rng,
                5,
                restrictToRange,
            );

            if (splitIndices.length === 0) return [];

            const splitCandidateInfos = splitIndices.map((idx) => {
                const head = bodyStatements.slice(0, idx);
                const tail = bodyStatements.slice(idx);
                const params = computeFreeVars(
                    head,
                    tail,
                    originalParams,
                );
                const { originalLines, helperLines } = estimateResultLineCounts(
                    idx,
                    bodyStatements,
                    funcStartLine,
                );
                const avoidsResplit = originalLines <= config.max_function_lines &&
                    helperLines <= config.max_function_lines;
                return { splitIndex: idx, params, avoidsResplit };
            });

            const nonTrivial = splitCandidateInfos.filter(
                (c) => !isTrivialTail(bodyStatements.slice(c.splitIndex)),
            );
            if (nonTrivial.length === 0) return [];

            nonTrivial.sort((a, b) => {
                if (a.avoidsResplit !== b.avoidsResplit) {
                    return a.avoidsResplit ? -1 : 1;
                }
                return a.params.length - b.params.length;
            });
            const best = nonTrivial[0];

            const head = bodyStatements.slice(0, best.splitIndex);
            const tail = bodyStatements.slice(best.splitIndex);

            const tailCode = depth === 0
                ? getTailCode(source, tail, node)
                : tail.map((stmt: any) => print(stmt).code).join("\n");

            const funcBindings = collectAllBindings(bodyStatements);
            const forbiddenNames = new Set([
                ...fileBindings,
                ...funcBindings,
                ...originalParams,
                ...JS_TS_KEYWORDS,
            ]);
            const forbiddenList = Array.from(forbiddenNames).sort();
            const maxAttempts = config.function_splitter_retries + 1;
            let helperName = "";
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    helperName = await llm.nameFunction(
                        tailCode,
                        best.params,
                        forbiddenList,
                    );
                } catch {
                    if (attempt === maxAttempts - 1) return [];
                    continue;
                }
                if (!forbiddenNames.has(helperName)) {
                    break;
                }
                if (attempt === maxAttempts - 1) return [];
            }

            const shouldReturn = returnsWithValue(tail);
            const headEndLine = head[head.length - 1].loc.end.line;
            const tailStartLine = tail[0].loc.start.line;
            const tailEndLine = tail[tail.length - 1].loc.end.line;

            let helperNode: any;

            const typedParams = buildTypedParams(
                best.params,
                node.params,
                head,
                typeChecker,
            );

            const sorted = typedParams
                .map((p: any, i: number) => ({
                    p,
                    name: best.params[i],
                    opt: !!p.optional,
                }))
                .sort((a, b) => a.opt === b.opt ? 0 : a.opt ? 1 : -1);
            for (let i = 0; i < sorted.length; i++) {
                typedParams[i] = sorted[i].p;
                best.params[i] = sorted[i].name;
            }

            if (type === "declaration") {
                const helperFunc = b.functionDeclaration(
                    b.identifier(helperName),
                    typedParams,
                    b.blockStatement([...tail]),
                );
                helperNode = helperFunc;

                const callExpr = b.callExpression(
                    b.identifier(helperName),
                    best.params.map((p) => b.identifier(p)),
                );

                const callStmt = shouldReturn
                    ? b.returnStatement(callExpr)
                    : b.expressionStatement(callExpr);
                callStmt.loc = {
                    start: { line: headEndLine + 1, column: 0 },
                    end: { line: headEndLine + 1, column: 0 },
                };

                node.body.body = [...head, callStmt];
                node.loc = {
                    start: node.loc.start,
                    end: { line: headEndLine + 2, column: 0 },
                };
                node.body.loc = {
                    start: node.body.loc.start,
                    end: { line: headEndLine + 2, column: 0 },
                };

                const parentBody = candidate.parentBody;
                const idx = parentBody.indexOf(node);
                if (idx >= 0) {
                    parentBody.splice(idx + 1, 0, helperFunc);
                }
            } else if (type === "classMethod") {
                const usesThisInTail = usesThis(tail);
                const isStatic = !usesThisInTail;

                const helperMethod = b.classMethod(
                    "method",
                    b.identifier(helperName),
                    typedParams,
                    b.blockStatement([...tail]),
                    false,
                    isStatic,
                );
                helperNode = helperMethod;

                let callee;
                if (isStatic && className) {
                    callee = b.memberExpression(
                        b.identifier(className),
                        b.identifier(helperName),
                    );
                } else {
                    callee = b.memberExpression(
                        b.thisExpression(),
                        b.identifier(helperName),
                    );
                }

                const callExpr = b.callExpression(
                    callee,
                    best.params.map((p) => b.identifier(p)),
                );

                const callStmt = shouldReturn
                    ? b.returnStatement(callExpr)
                    : b.expressionStatement(callExpr);
                callStmt.loc = {
                    start: { line: headEndLine + 1, column: 0 },
                    end: { line: headEndLine + 1, column: 0 },
                };

                node.body.body = [...head, callStmt];
                node.loc = {
                    start: node.loc.start,
                    end: { line: headEndLine + 2, column: 0 },
                };
                node.body.loc = {
                    start: node.body.loc.start,
                    end: { line: headEndLine + 2, column: 0 },
                };

                const parentBody = candidate.parentBody;
                const idx = parentBody.indexOf(node);
                if (idx >= 0) {
                    parentBody.splice(idx + 1, 0, helperMethod);
                }
            }

            helperNode.loc = {
                start: { line: tailStartLine - 1, column: 0 },
                end: { line: tailEndLine + 1, column: 0 },
            };
            if (helperNode.body) {
                helperNode.body.loc = {
                    start: { line: tailStartLine - 1, column: 0 },
                    end: { line: tailEndLine + 1, column: 0 },
                };
            }

            fileBindings.add(helperName);
            const splitDescs: string[] = [
                `split function at line ${funcStartLine} into ${helperName}`,
            ];

            const { originalLines, helperLines } = estimateResultLineCounts(
                best.splitIndex,
                bodyStatements,
                funcStartLine,
            );

            if (helperLines > config.max_function_lines) {
                const helperInfo: FunctionInfo = {
                    node: helperNode,
                    parentBody: candidate.parentBody,
                    bodyStatements: tail,
                    originalParams: best.params,
                    type: candidate.type,
                    className: candidate.className,
                };
                const helperDescs = await splitRecursively(
                    helperInfo,
                    1.0,
                    depth + 1,
                );
                splitDescs.push(...helperDescs);
            }

            if (originalLines > config.max_function_lines) {
                let shouldResplit = coverage >= 0.6;
                if (!shouldResplit) {
                    shouldResplit = getDiffStatementRange(head, ranges) !== null;
                }
                if (shouldResplit) {
                    const originalInfo: FunctionInfo = {
                        node: node,
                        parentBody: candidate.parentBody,
                        bodyStatements: node.body.body,
                        originalParams: originalParams,
                        type: candidate.type,
                        className: candidate.className,
                    };
                    const newCoverage = computeDiffCoverage(
                        funcStartLine,
                        headEndLine + 2,
                        ranges,
                    );
                    const originalDescs = await splitRecursively(
                        originalInfo,
                        newCoverage,
                        depth + 1,
                    );
                    splitDescs.push(...originalDescs);
                }
            }

            return splitDescs;
        }

        for (const candidate of candidates) {
            const coverage = computeDiffCoverage(
                candidate.node.loc.start.line,
                candidate.node.loc.end.line,
                ranges,
            );
            const descs = await splitRecursively(
                candidate,
                coverage,
                0,
            );
            descriptions.push(...descs);
        }

        if (descriptions.length === 0) {
            return { changed: false, source, description: "" };
        }

        return {
            changed: true,
            source: print(ast).code,
            description: descriptions.join("\n"),
        };
    };
}
