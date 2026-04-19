// deno-lint-ignore-file no-explicit-any
import { parse, print, types, visit } from "recast";
import * as babelParser from "@babel/parser";
import type { ChangedRange } from "../diff.ts";
import type { Refactor, RefactorResult } from "../engine.ts";
import type { Config } from "../config.ts";
import type { LLMClient } from "../llm.ts";
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

function isTrivialTail(tail: any[]): boolean {
    if (tail.length !== 1) return false;
    const stmt = tail[0];
    return (
        stmt.type === "ReturnStatement" &&
        stmt.argument?.type === "Identifier"
    );
}

function selectSplitPoints(
    bodyStmts: any[],
    bodyStartLine: number,
    maxLines: number,
    rng: () => number,
    count: number,
): number[] {
    const validIndices: number[] = [];
    for (let i = 1; i < bodyStmts.length; i++) {
        const stmt = bodyStmts[i - 1];
        const headLines = stmt.loc.end.line - bodyStartLine;
        if (headLines <= maxLines) {
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

export function createFunctionSplitter(
    config: Config,
    llm: LLMClient,
    random?: () => number,
): Refactor {
    const rng = random ?? Math.random;

    return async (
        source: string,
        ranges: ChangedRange[],
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

        candidates.sort(
            (a, b) => b.node.loc.start.line - a.node.loc.start.line,
        );

        const descriptions: string[] = [];

        for (const candidate of candidates) {
            const {
                node,
                bodyStatements,
                originalParams,
                type,
                className,
            } = candidate;
            const bodyStartLine = node.body.loc.start.line;

            const splitIndices = selectSplitPoints(
                bodyStatements,
                bodyStartLine,
                config.max_function_lines,
                rng,
                5,
            );

            if (splitIndices.length === 0) continue;

            const splitCandidates: SplitCandidate[] = splitIndices.map((idx) => {
                const head = bodyStatements.slice(0, idx);
                const tail = bodyStatements.slice(idx);
                const params = computeFreeVars(
                    head,
                    tail,
                    originalParams,
                );
                return { splitIndex: idx, params };
            });

            const nonTrivial = splitCandidates.filter(
                (c) => !isTrivialTail(bodyStatements.slice(c.splitIndex)),
            );
            if (nonTrivial.length === 0) continue;

            nonTrivial.sort(
                (a, b) => a.params.length - b.params.length,
            );
            const best = nonTrivial[0];

            const head = bodyStatements.slice(0, best.splitIndex);
            const tail = bodyStatements.slice(best.splitIndex);

            const tailCode = getTailCode(source, tail, node);
            const helperName = await llm.nameFunction(
                tailCode,
                best.params,
            );

            const shouldReturn = returnsWithValue(tail);

            if (type === "declaration") {
                const helperFunc = b.functionDeclaration(
                    b.identifier(helperName),
                    best.params.map((p) => b.identifier(p)),
                    b.blockStatement([...tail]),
                );

                const callExpr = b.callExpression(
                    b.identifier(helperName),
                    best.params.map((p) => b.identifier(p)),
                );

                const callStmt = shouldReturn
                    ? b.returnStatement(callExpr)
                    : b.expressionStatement(callExpr);

                node.body.body = [...head, callStmt];

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
                    best.params.map((p) => b.identifier(p)),
                    b.blockStatement([...tail]),
                    false,
                    isStatic,
                );

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

                node.body.body = [...head, callStmt];

                const parentBody = candidate.parentBody;
                const idx = parentBody.indexOf(node);
                if (idx >= 0) {
                    parentBody.splice(idx + 1, 0, helperMethod);
                }
            }

            descriptions.push(
                `split function at line ${node.loc.start.line} into ${helperName}`,
            );
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
