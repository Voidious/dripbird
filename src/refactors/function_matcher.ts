// deno-lint-ignore-file no-explicit-any
import { parse, print, visit } from "recast";
import * as babelParser from "@babel/parser";
import type { ChangedRange } from "../diff.ts";
import type { Refactor, RefactorContext, RefactorResult } from "../engine.ts";
import type { LLMClient } from "../llm.ts";

interface FunctionInfo {
    name: string;
    node: any;
    bodyStatements: any[];
    bodySource: string;
    bodyFingerprint: string;
    params: string[];
    returnExprSource: string | null;
    returnExprFingerprint: string | null;
    returnExprParamMapping: Map<string, string> | null;
}

interface SeqInfo {
    statements: any[];
    startLine: number;
    endLine: number;
    source: string;
    fingerprint: string;
    scope: string;
    identifierMap: Map<string, string>;
}

interface ExpressionMatch {
    stmt: any;
    startLine: number;
    endLine: number;
    stmtSource: string;
    func: FunctionInfo;
}

function parseSource(source: string): any {
    return parse(source, {
        parser: {
            parse(code: string) {
                return babelParser.parse(code, {
                    sourceType: "module",
                    plugins: ["typescript", "jsx"],
                });
            },
        },
    });
}

function cloneDeep(node: any): any {
    if (node === null || node === undefined) return node;
    if (typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(cloneDeep);
    const result: any = {};
    for (const key of Object.keys(node)) {
        if (
            key === "loc" || key === "start" || key === "end" ||
            key === "tokens" || key === "comments"
        ) continue;
        result[key] = cloneDeep(node[key]);
    }
    return result;
}

function isPropertyContext(parent: any, node: any): boolean {
    if (
        parent.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed
    ) return true;
    if (
        parent.type === "ObjectProperty" &&
        parent.key === node &&
        !parent.computed &&
        !parent.shorthand
    ) return true;
    if (
        parent.type === "ObjectMethod" &&
        parent.key === node &&
        !parent.computed
    ) return true;
    if (
        (parent.type === "ClassMethod" ||
            parent.type === "ClassPrivateMethod" ||
            parent.type === "MethodDefinition" ||
            parent.type === "PropertyDefinition") &&
        parent.key === node &&
        !parent.computed
    ) return true;
    if (
        parent.type === "LabeledStatement" &&
        parent.label === node
    ) return true;
    return false;
}

interface NormalizationResult {
    fingerprint: string;
    identifierMap: Map<string, string>;
}

function normalizeStatements(stmts: any[]): NormalizationResult {
    const cloned = stmts.map(cloneDeep);
    const identifierMap = new Map<string, string>();
    let counter = 0;

    for (const stmt of cloned) {
        visit(stmt, {
            visitIdentifier(path) {
                const parent = path.parent?.node;
                const node = path.node;
                if (parent && isPropertyContext(parent, node)) {
                    this.traverse(path);
                    return;
                }
                const name = node.name;
                if (!identifierMap.has(name)) {
                    identifierMap.set(name, `_v${counter++}`);
                }
                node.name = identifierMap.get(name)!;
                this.traverse(path);
            },
        });
    }

    const code = cloned.map((s: any) => print(s).code).join("\n");
    return { fingerprint: code, identifierMap };
}

function normalizeExpression(expr: any): NormalizationResult {
    const cloned = cloneDeep(expr);
    const identifierMap = new Map<string, string>();
    let counter = 0;

    visit(cloned, {
        visitIdentifier(path) {
            const parent = path.parent?.node;
            const node = path.node;
            if (parent && isPropertyContext(parent, node)) {
                this.traverse(path);
                return;
            }
            const name = node.name;
            if (!identifierMap.has(name)) {
                identifierMap.set(name, `_v${counter++}`);
            }
            node.name = identifierMap.get(name)!;
            this.traverse(path);
        },
    });

    return { fingerprint: print(cloned).code, identifierMap };
}

function getParamNames(node: any): string[] {
    return node.params
        .map((p: any) => {
            if (p.type === "Identifier") return p.name;
            if (p.type === "AssignmentPattern") {
                return p.left?.type === "Identifier" ? p.left.name : null;
            }
            if (p.type === "RestElement") {
                return p.argument?.type === "Identifier" ? p.argument.name : null;
            }
            return null;
        })
        .filter((p: string | null): p is string => p !== null);
}

function collectFunctions(ast: any, sourceLines: string[]): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    visit(ast, {
        visitFunctionDeclaration(path) {
            const node = path.node;
            if (!node.id) {
                this.traverse(path);
                return;
            }
            if (node.async || node.generator) {
                this.traverse(path);
                return;
            }
            if (!node.body?.body || node.body.body.length === 0) {
                this.traverse(path);
                return;
            }

            const bodyStatements = node.body.body;
            const params = getParamNames(node);

            const bodySource = sourceLines
                .slice(
                    bodyStatements[0].loc!.start.line - 1,
                    bodyStatements[bodyStatements.length - 1].loc!.end.line,
                )
                .join("\n");

            const { fingerprint: bodyFingerprint } = normalizeStatements(
                bodyStatements,
            );

            let returnExprSource: string | null = null;
            let returnExprFingerprint: string | null = null;
            let returnExprParamMapping: Map<string, string> | null = null;

            if (
                bodyStatements.length === 1 &&
                bodyStatements[0].type === "ReturnStatement" &&
                bodyStatements[0].argument
            ) {
                const retExpr = bodyStatements[0].argument;
                const norm = normalizeExpression(retExpr);
                returnExprSource = print(retExpr).code;
                returnExprFingerprint = norm.fingerprint;

                const paramSet = new Set(params);
                const mapping = new Map<string, string>();
                for (const [orig, placeholder] of norm.identifierMap) {
                    if (paramSet.has(orig)) {
                        mapping.set(placeholder, orig);
                    }
                }
                returnExprParamMapping = mapping;
            }

            functions.push({
                name: node.id.name as string,
                node,
                bodyStatements,
                bodySource,
                bodyFingerprint,
                params,
                returnExprSource,
                returnExprFingerprint,
                returnExprParamMapping,
            });

            this.traverse(path);
        },

        visitFunctionExpression() {
            return false;
        },
        visitArrowFunctionExpression() {
            return false;
        },
    });

    return functions;
}

function collectSequences(
    ast: any,
    sourceLines: string[],
    maxLen: number,
): SeqInfo[] {
    const sequences: SeqInfo[] = [];

    function processBody(bodyStmts: any[], scope: string) {
        const valid: Array<{ stmt: any; startLine: number; endLine: number }> = [];
        for (const stmt of bodyStmts) {
            if (stmt.type === "FunctionDeclaration") continue;
            valid.push({
                stmt,
                startLine: stmt.loc.start.line,
                endLine: stmt.loc.end.line,
            });
        }

        for (let start = 0; start < valid.length; start++) {
            for (
                let end = start + 1;
                end <= Math.min(start + maxLen, valid.length);
                end++
            ) {
                const window = valid.slice(start, end);
                const stmts = window.map((w) => w.stmt);
                const { fingerprint, identifierMap } = normalizeStatements(stmts);
                const seqSource = sourceLines
                    .slice(
                        window[0].startLine - 1,
                        window[window.length - 1].endLine,
                    )
                    .join("\n");
                sequences.push({
                    statements: stmts,
                    startLine: window[0].startLine,
                    endLine: window[window.length - 1].endLine,
                    source: seqSource,
                    fingerprint,
                    scope,
                    identifierMap,
                });
            }
        }
    }

    visit(ast, {
        visitFunctionDeclaration(path) {
            const node = path.node;
            if (!node.id) {
                this.traverse(path);
                return;
            }
            processBody(node.body.body, node.id.name as string);
            this.traverse(path);
        },
        visitFunctionExpression() {
            return false;
        },
        visitArrowFunctionExpression() {
            return false;
        },
    });

    return sequences;
}

function overlapsRange(
    startLine: number,
    endLine: number,
    ranges: ChangedRange[],
): boolean {
    return ranges.some(
        (r) => startLine <= r.end && endLine >= r.start,
    );
}

function findBodyMatches(
    sequences: SeqInfo[],
    functions: FunctionInfo[],
    ranges: ChangedRange[],
): Array<{ seq: SeqInfo; func: FunctionInfo }> {
    const bodyFpMap = new Map<string, FunctionInfo[]>();
    for (const func of functions) {
        const list = bodyFpMap.get(func.bodyFingerprint);
        if (list) {
            list.push(func);
        } else {
            bodyFpMap.set(func.bodyFingerprint, [func]);
        }
    }

    const matches: Array<{ seq: SeqInfo; func: FunctionInfo }> = [];

    for (const seq of sequences) {
        if (!overlapsRange(seq.startLine, seq.endLine, ranges)) continue;

        const funcs = bodyFpMap.get(seq.fingerprint);
        if (!funcs) continue;

        for (const func of funcs) {
            if (func.name === seq.scope) continue;

            matches.push({ seq, func });
        }
    }

    return matches;
}

function findExpressionMatches(
    ast: any,
    sourceLines: string[],
    functions: FunctionInfo[],
    ranges: ChangedRange[],
    bodyMatchedRanges: Set<string>,
): ExpressionMatch[] {
    const exprFpMap = new Map<string, FunctionInfo>();
    for (const func of functions) {
        if (func.returnExprFingerprint) {
            exprFpMap.set(func.returnExprFingerprint, func);
        }
    }

    if (exprFpMap.size === 0) return [];

    const matches: ExpressionMatch[] = [];

    function checkStatement(
        stmt: any,
        _scope: string,
    ) {
        if (!overlapsRange(stmt.loc.start.line, stmt.loc.end.line, ranges)) return;

        const rangeKey = `${stmt.loc.start.line}-${stmt.loc.end.line}`;
        if (bodyMatchedRanges.has(rangeKey)) return;

        let rhs: any = null;
        let target: any = null;

        if (
            stmt.type === "ExpressionStatement" &&
            stmt.expression?.type === "AssignmentExpression" &&
            stmt.expression.operator === "="
        ) {
            rhs = stmt.expression.right;
            target = stmt.expression.left;
        } else if (
            stmt.type === "VariableDeclaration" &&
            stmt.declarations.length === 1
        ) {
            const decl = stmt.declarations[0];
            if (decl.init) {
                rhs = decl.init;
                target = decl.id;
            }
        }

        if (!rhs || !target) return;

        const norm = normalizeExpression(rhs);
        const func = exprFpMap.get(norm.fingerprint);
        if (!func) return;

        const source = sourceLines
            .slice(stmt.loc.start.line - 1, stmt.loc.end.line)
            .join("\n");

        matches.push({
            stmt,
            startLine: stmt.loc.start.line,
            endLine: stmt.loc.end.line,
            stmtSource: source,
            func,
        });
    }

    visit(ast, {
        visitFunctionDeclaration(path) {
            const node = path.node;
            if (!node.id) {
                this.traverse(path);
                return;
            }
            for (const stmt of node.body.body) {
                checkStatement(stmt, node.id.name as string);
            }
            this.traverse(path);
        },
        visitFunctionExpression() {
            return false;
        },
        visitArrowFunctionExpression() {
            return false;
        },
    });

    return matches;
}

function applyTextEdit(
    source: string,
    startLine: number,
    endLine: number,
    replacement: string,
): string {
    const lines = source.split("\n");
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const replacementLines = replacement.split("\n").filter((line, idx, arr) =>
        !(idx === arr.length - 1 && line === "")
    );
    return [...before, ...replacementLines, ...after].join("\n");
}

function getIndent(source: string): string {
    return source.match(/^(\s*)/)![1];
}

function buildCallFromMapping(
    func: FunctionInfo,
    seqIdentifierMap: Map<string, string>,
    targetCode: string,
    hasReturn: boolean,
): string | null {
    const funcNorm = normalizeStatements(func.bodyStatements);

    const reverseSeqMap = new Map<string, string>();
    for (const [orig, placeholder] of seqIdentifierMap) {
        reverseSeqMap.set(placeholder, orig);
    }

    const args: string[] = [];
    for (const param of func.params) {
        const funcPlaceholder = funcNorm.identifierMap.get(param);
        if (!funcPlaceholder) return null;
        args.push(reverseSeqMap.get(funcPlaceholder)!);
    }

    const indent = getIndent(targetCode);
    const callExpr = `${func.name}(${args.join(", ")})`;

    if (hasReturn) {
        return `${indent}return ${callExpr};\n`;
    }
    return `${indent}${callExpr};\n`;
}

function buildAssignmentCall(
    stmt: any,
    func: FunctionInfo,
): string | null {
    let targetName: string | null = null;
    let indent = "";
    let keyword = "";

    if (
        stmt.type === "ExpressionStatement" &&
        stmt.expression?.type === "AssignmentExpression"
    ) {
        if (stmt.expression.left.type === "Identifier") {
            targetName = stmt.expression.left.name;
        }
        indent = stmt.loc.start.column > 0 ? " ".repeat(stmt.loc.start.column) : "";
    } else if (stmt.type === "VariableDeclaration") {
        const decl = stmt.declarations[0];
        if (decl.id.type === "Identifier") {
            targetName = decl.id.name;
        }
        keyword = stmt.kind;
        indent = stmt.loc.start.column > 0 ? " ".repeat(stmt.loc.start.column) : "";
    }

    if (!targetName) return null;

    const retExpr = func.bodyStatements[0].argument;
    const funcNorm = normalizeExpression(retExpr);
    const seqNorm = normalizeExpression(
        stmt.type === "ExpressionStatement"
            ? stmt.expression.right
            : stmt.declarations[0].init,
    );

    const reverseSeqMap = new Map<string, string>();
    for (const [orig, placeholder] of seqNorm.identifierMap) {
        reverseSeqMap.set(placeholder, orig);
    }

    const args: string[] = [];
    for (const param of func.params) {
        const funcPlaceholder = funcNorm.identifierMap.get(param);
        if (!funcPlaceholder) return null;
        args.push(reverseSeqMap.get(funcPlaceholder)!);
    }

    const callExpr = `${func.name}(${args.join(", ")})`;
    if (keyword) {
        return `${indent}${keyword} ${targetName} = ${callExpr};\n`;
    }
    return `${indent}${targetName} = ${callExpr};\n`;
}

export function createFunctionMatcher(
    llm: LLMClient,
): Refactor {
    return async (
        source: string,
        ranges: ChangedRange[],
        _context?: RefactorContext,
    ): Promise<RefactorResult> => {
        const log = _context?.log ?? (() => {});

        let ast;
        try {
            ast = parseSource(source);
        } catch {
            return { changed: false, source, description: "" };
        }

        const sourceLines = source.split("\n");

        const functions = collectFunctions(ast, sourceLines);
        if (functions.length === 0) {
            log?.("dripbird: function_matcher: no functions found");
            return { changed: false, source, description: "" };
        }

        log?.(
            `dripbird: function_matcher: found ${functions.length} function(s): ${
                functions.map((f) =>
                    `${f.name}(${f.params.length} params, ${f.bodyStatements.length} stmts)`
                ).join(", ")
            }`,
        );

        const maxBodyLen = Math.max(
            ...functions.map((f) => f.bodyStatements.length),
            1,
        );
        const maxSeqLen = Math.max(maxBodyLen, 8);

        const sequences = collectSequences(ast, sourceLines, maxSeqLen);

        const bodyMatches = findBodyMatches(sequences, functions, ranges);
        const bodyMatchedRanges = new Set<string>();
        for (const m of bodyMatches) {
            bodyMatchedRanges.add(`${m.seq.startLine}-${m.seq.endLine}`);
        }
        const exprMatches = findExpressionMatches(
            ast,
            sourceLines,
            functions,
            ranges,
            bodyMatchedRanges,
        );

        if (bodyMatches.length === 0 && exprMatches.length === 0) {
            log?.(
                `dripbird: function_matcher: no fingerprint matches (checked ${sequences.length} sequences across ${ranges.length} range(s): ${
                    ranges.map((r) => `${r.start}-${r.end}`).join(", ")
                })`,
            );
            return { changed: false, source, description: "" };
        }

        log?.(
            `dripbird: function_matcher: ${bodyMatches.length} body match(es), ${exprMatches.length} expression match(es)`,
        );

        const allMatches: Array<{
            startLine: number;
            endLine: number;
            codeBlock: string;
            func: FunctionInfo;
            algoReplacement: string | null;
        }> = [];

        for (const m of bodyMatches) {
            let algoReplacement: string | null = null;
            if (m.func.params.length === 0) {
                const indent = getIndent(m.seq.source);
                const stmts = m.seq.statements;
                const lastStmt = stmts[stmts.length - 1];
                const hasReturn = lastStmt.type === "ReturnStatement" &&
                    lastStmt.argument;
                if (hasReturn) {
                    algoReplacement = `${indent}return ${m.func.name}();\n`;
                } else {
                    algoReplacement = `${indent}${m.func.name}();\n`;
                }
            } else {
                const stmts = m.seq.statements;
                const lastStmt = stmts[stmts.length - 1];
                const hasReturn = lastStmt.type === "ReturnStatement" &&
                    lastStmt.argument;
                algoReplacement = buildCallFromMapping(
                    m.func,
                    m.seq.identifierMap,
                    m.seq.source,
                    hasReturn,
                );
            }
            allMatches.push({
                startLine: m.seq.startLine,
                endLine: m.seq.endLine,
                codeBlock: m.seq.source,
                func: m.func,
                algoReplacement,
            });
        }

        for (const m of exprMatches) {
            const algoReplacement = buildAssignmentCall(m.stmt, m.func);
            allMatches.push({
                startLine: m.startLine,
                endLine: m.endLine,
                codeBlock: m.stmtSource,
                func: m.func,
                algoReplacement,
            });
        }

        allMatches.sort((a, b) => b.startLine - a.startLine);

        const descriptions: string[] = [];
        let currentSource = source;
        const claimedRanges: Array<{ start: number; end: number }> = [];

        for (const match of allMatches) {
            const overlaps = claimedRanges.some(
                (r) => match.startLine <= r.end && match.endLine >= r.start,
            );
            if (overlaps) continue;

            const funcSource = sourceLines
                .slice(
                    match.func.node.loc.start.line - 1,
                    match.func.node.loc.end.line,
                )
                .join("\n");

            log?.(
                `dripbird: function_matcher: candidate lines ${match.startLine}-${match.endLine} → ${match.func.name} (algo: ${
                    match.algoReplacement ? "yes" : "no"
                })`,
            );

            const verifyResult = await llm.verifyFunctionMatch(
                match.codeBlock,
                funcSource,
                source,
            );
            if (!verifyResult.isMatch) {
                log?.(
                    `dripbird: function_matcher: LLM rejected match (lines ${match.startLine}-${match.endLine} → ${match.func.name}): ${verifyResult.reason}`,
                );
                continue;
            }

            let replacement: string;
            if (match.algoReplacement) {
                replacement = match.algoReplacement;
            } else {
                replacement = await llm.generateCallReplacement(
                    match.codeBlock,
                    match.func.name,
                    funcSource,
                    source,
                );
            }

            const proposedSource = applyTextEdit(
                currentSource,
                match.startLine,
                match.endLine,
                replacement,
            );

            let parseOk = false;
            try {
                parseSource(proposedSource);
                parseOk = true;
            } catch {
                parseOk = false;
            }
            if (!parseOk) {
                log?.(
                    `dripbird: function_matcher: replacement didn't parse (lines ${match.startLine}-${match.endLine} → ${match.func.name})`,
                );
                continue;
            }

            const reviewResult = await llm.reviewChange(
                match.codeBlock,
                proposedSource,
                `replaced code at lines ${match.startLine}-${match.endLine} with call to ${match.func.name}`,
            );
            if (!reviewResult.accepted) {
                log?.(
                    `dripbird: function_matcher: LLM review rejected (lines ${match.startLine}-${match.endLine} → ${match.func.name}): ${reviewResult.feedback}`,
                );
                continue;
            }

            currentSource = proposedSource;
            claimedRanges.push({
                start: match.startLine,
                end: match.endLine,
            });
            descriptions.push(
                `replaced code at lines ${match.startLine}-${match.endLine} with call to ${match.func.name}`,
            );
        }

        if (descriptions.length === 0) {
            return { changed: false, source, description: "" };
        }

        return {
            changed: true,
            source: currentSource,
            description: descriptions.join("\n"),
        };
    };
}
