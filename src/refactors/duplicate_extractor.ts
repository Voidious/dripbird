// deno-lint-ignore-file no-explicit-any
import { parse, print, visit } from "recast";
import * as babelParser from "@babel/parser";
import type { ChangedRange } from "../diff.ts";
import type { Config } from "../config.ts";
import type { Refactor, RefactorContext, RefactorResult } from "../engine.ts";
import type { LLMClient } from "../llm.ts";
import { collectFileLevelBindings, JS_TS_KEYWORDS } from "./function_splitter.ts";

export interface SeqInfo {
    statements: any[];
    startLine: number;
    endLine: number;
    source: string;
    fingerprint: string;
    scope: string;
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

function normalizeStatements(stmts: any[]): string {
    const cloned = stmts.map(cloneDeep);
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
                node.name = `_v${counter++}`;
                this.traverse(path);
            },
        });
    }

    return cloned.map((s: any) => print(s).code).join("\n");
}

export function collectSequences(
    ast: any,
    sourceLines: string[],
    minLines: number,
    maxLines: number,
): SeqInfo[] {
    const sequences: SeqInfo[] = [];

    function processBody(bodyStmts: any[], scope: string) {
        const valid: Array<{
            stmt: any;
            startLine: number;
            endLine: number;
        }> = [];
        for (const stmt of bodyStmts) {
            if (stmt.type === "FunctionDeclaration") continue;
            if (!stmt.loc) continue;
            valid.push({
                stmt,
                startLine: stmt.loc.start.line,
                endLine: stmt.loc.end.line,
            });
        }

        for (let start = 0; start < valid.length; start++) {
            for (let end = start + 1; end <= valid.length; end++) {
                const spanStart = valid[start].startLine;
                const spanEnd = valid[end - 1].endLine;
                const lineSpan = spanEnd - spanStart + 1;

                if (lineSpan > maxLines) break;

                if (lineSpan < minLines) continue;

                const stmts = valid.slice(start, end).map((w) => w.stmt);
                const fingerprint = normalizeStatements(stmts);
                const source = sourceLines
                    .slice(spanStart - 1, spanEnd)
                    .join("\n");

                sequences.push({
                    statements: stmts,
                    startLine: spanStart,
                    endLine: spanEnd,
                    source,
                    fingerprint,
                    scope,
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
            if (node.async || node.generator) {
                this.traverse(path);
                return;
            }
            if (!node.body?.body || node.body.body.length === 0) {
                this.traverse(path);
                return;
            }
            processBody(node.body.body, node.id.name as string);
            this.traverse(path);
        },
        visitClassMethod(path) {
            const node = path.node;
            if (node.kind === "constructor") {
                this.traverse(path);
                return;
            }
            if (!node.static) {
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
            if (node.computed) {
                this.traverse(path);
                return;
            }
            const classDecl = path.parent?.parent?.node as any;
            const className = classDecl?.id?.name;
            const methodKey = node.key as any;
            const methodName = methodKey?.name;
            if (!className || !methodName) {
                this.traverse(path);
                return;
            }
            processBody(node.body.body, `${className}.${methodName}`);
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

function overlapsAny(
    startLine: number,
    endLine: number,
    ranges: Array<{ start: number; end: number }>,
): boolean {
    return ranges.some(
        (r) => startLine <= r.end && endLine >= r.start,
    );
}

export function findDuplicateGroups(
    sequences: SeqInfo[],
    ranges: ChangedRange[],
): SeqInfo[][] {
    const fpMap = new Map<string, SeqInfo[]>();
    for (const seq of sequences) {
        const list = fpMap.get(seq.fingerprint);
        if (list) {
            list.push(seq);
        } else {
            fpMap.set(seq.fingerprint, [seq]);
        }
    }

    const groups: SeqInfo[][] = [];
    for (const [, seqs] of fpMap) {
        if (seqs.length < 2) continue;

        const hasDiffOverlap = seqs.some((seq) =>
            overlapsRange(seq.startLine, seq.endLine, ranges)
        );
        if (!hasDiffOverlap) continue;

        const uniqueLocations = new Set(
            seqs.map((s) => `${s.startLine}-${s.endLine}`),
        );
        if (uniqueLocations.size < 2) continue;

        const deduped: SeqInfo[] = [];
        const seen = new Set<string>();
        for (const seq of seqs) {
            const key = `${seq.startLine}-${seq.endLine}-${seq.scope}`;
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(seq);
            }
        }
        if (deduped.length >= 2) {
            groups.push(deduped);
        }
    }

    return groups;
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
    const replacementLines = replacement.split("\n").filter(
        (line, idx, arr) => !(idx === arr.length - 1 && line === ""),
    );
    return [...before, ...replacementLines, ...after].join("\n");
}

export function createDuplicateExtractor(
    config: Config,
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

        const sequences = collectSequences(
            ast,
            sourceLines,
            config.duplicate_extractor_min_lines,
            config.duplicate_extractor_max_lines,
        );

        if (sequences.length === 0) {
            log?.("dripbird: duplicate_extractor: no sequences collected");
            return { changed: false, source, description: "" };
        }

        const groups = findDuplicateGroups(sequences, ranges);

        if (groups.length === 0) {
            log?.(
                `dripbird: duplicate_extractor: no duplicate groups (checked ${sequences.length} sequences)`,
            );
            return { changed: false, source, description: "" };
        }

        log?.(
            `dripbird: duplicate_extractor: ${groups.length} duplicate group(s) found`,
        );

        const descriptions: string[] = [];
        let currentSource = source;
        const claimedRanges: Array<{ start: number; end: number }> = [];

        for (const group of groups) {
            const filtered = group.filter(
                (seq) => !overlapsAny(seq.startLine, seq.endLine, claimedRanges),
            );
            if (filtered.length < 2) continue;

            log?.(
                `dripbird: duplicate_extractor: candidate group with ${filtered.length} blocks: ${
                    filtered.map((s) => `${s.startLine}-${s.endLine}`).join(", ")
                }`,
            );

            const codeBlocks = filtered.map((seq) => seq.source);
            const verifyResult = await llm.verifyDuplicateMatch(
                codeBlocks,
                source,
            );
            if (!verifyResult.isMatch) {
                log?.(
                    `dripbird: duplicate_extractor: LLM rejected group: ${verifyResult.reason}`,
                );
                continue;
            }

            let remaining = filtered;
            if (verifyResult.excludeIndices.length > 0) {
                const exclude = new Set(verifyResult.excludeIndices);
                remaining = filtered.filter((_, i) => !exclude.has(i));
                if (remaining.length < 2) {
                    log?.(
                        `dripbird: duplicate_extractor: too few blocks after exclusion`,
                    );
                    continue;
                }
            }

            const remainingBlocks = remaining.map((seq) => seq.source);

            const fileBindings = collectFileLevelBindings(
                parseSource(currentSource),
            );
            const forbiddenNames = Array.from(
                new Set([...fileBindings, ...JS_TS_KEYWORDS]),
            ).sort();

            const maxAttempts = config.duplicate_extractor_retries + 1;
            let accepted = false;
            let lastFeedback = "";

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const extraction = await llm.generateExtraction(
                    remainingBlocks,
                    currentSource,
                    forbiddenNames,
                    lastFeedback || undefined,
                );

                if (
                    extraction.callSites.length !== remaining.length
                ) {
                    log?.(
                        `dripbird: duplicate_extractor: call sites count mismatch (got ${extraction.callSites.length}, expected ${remaining.length})`,
                    );
                    lastFeedback =
                        `Expected exactly ${remaining.length} call sites but got ${extraction.callSites.length}. Try again.`;
                    continue;
                }

                let proposedSource = currentSource;

                const sortedIndices = remaining
                    .map((seq, i) => ({
                        seq,
                        callSite: extraction.callSites[i],
                        index: i,
                    }))
                    .sort((a, b) => b.seq.startLine - a.seq.startLine);

                for (const { seq, callSite } of sortedIndices) {
                    proposedSource = applyTextEdit(
                        proposedSource,
                        seq.startLine,
                        seq.endLine,
                        callSite,
                    );
                }

                proposedSource = proposedSource.trimEnd() + "\n\n" +
                    extraction.helperFunction + "\n";

                let parseOk = false;
                try {
                    parseSource(proposedSource);
                    parseOk = true;
                } catch {
                    parseOk = false;
                }
                if (!parseOk) {
                    log?.(
                        `dripbird: duplicate_extractor: result didn't parse (attempt ${
                            attempt + 1
                        }/${maxAttempts})`,
                    );
                    lastFeedback =
                        "The previous extraction did not produce valid syntax. The result could not be parsed.";
                    continue;
                }

                const reviewResult = await llm.reviewChange(
                    currentSource,
                    proposedSource,
                    `extracted duplicate code into ${extraction.helperName} (replacing ${remaining.length} blocks)`,
                );
                if (!reviewResult.accepted) {
                    log?.(
                        `dripbird: duplicate_extractor: LLM review rejected (attempt ${
                            attempt + 1
                        }/${maxAttempts}): ${reviewResult.feedback}`,
                    );
                    lastFeedback = reviewResult.feedback;
                    continue;
                }

                currentSource = proposedSource;
                accepted = true;

                for (const { seq } of sortedIndices) {
                    claimedRanges.push({
                        start: seq.startLine,
                        end: seq.endLine,
                    });
                }

                descriptions.push(
                    `extracted duplicate code into ${extraction.helperName} (replacing ${remaining.length} blocks)`,
                );
                break;
            }

            if (!accepted) continue;
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
