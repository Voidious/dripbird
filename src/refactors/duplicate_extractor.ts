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
    kind: "function" | "method";
    isStatic?: boolean;
    className?: string | null;
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
    return found;
}

export function collectSequences(
    ast: any,
    sourceLines: string[],
    minLines: number,
    maxLines: number,
): SeqInfo[] {
    const sequences: SeqInfo[] = [];

    function processBody(
        bodyStmts: any[],
        scope: string,
        ctx: Pick<SeqInfo, "kind" | "isStatic" | "className">,
    ) {
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
                    ...ctx,
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
            processBody(
                node.body.body,
                node.id.name as string,
                { kind: "function", isStatic: false, className: null },
            );
            this.traverse(path);
        },
        visitClassMethod(path) {
            const node = path.node;
            if (node.kind === "constructor") {
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
            processBody(
                node.body.body,
                `${className}.${methodName}`,
                {
                    kind: "method",
                    isStatic: !!node.static,
                    className: className as string,
                },
            );
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

// Range that overlaps every block. Re-detection passes (see
// createDuplicateExtractor) work from mutated coordinates, so the diff-range
// gate is opened here and diff eligibility is enforced via the
// approved-fingerprint set instead, keeping the original diff semantics exact.
const ANY_RANGE: ChangedRange[] = [{
    start: Number.MIN_SAFE_INTEGER,
    end: Number.MAX_SAFE_INTEGER,
}];

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

function detectBaseIndent(text: string): string {
    let minLen = Infinity;
    let result = "";
    for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        const leading = line.substring(
            0,
            line.search(/\S|$/),
        );
        if (leading.length < minLen) {
            minLen = leading.length;
            result = leading;
        }
    }
    return result;
}

function normalizeCallSiteIndent(
    callSite: string,
    targetIndent: string,
): string {
    const currentIndent = detectBaseIndent(callSite);
    if (currentIndent === targetIndent) return callSite;
    return callSite.split("\n").map((line) => {
        if (line.trim().length === 0) return line;
        const stripped = currentIndent.length > 0 &&
                line.startsWith(currentIndent)
            ? line.slice(currentIndent.length)
            : line.trimStart();
        return targetIndent + stripped;
    }).join("\n");
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

export type ExtractionTarget =
    | { kind: "function" }
    | { kind: "instanceMethod"; className: string };

/**
 * Decide where a duplicate group's helper should live.
 *
 * - If no block uses `this`, a top-level function is always safe (the existing
 *   behavior, valid from free functions, static methods, and instance methods
 *   alike).
 * - If any block uses `this`, the helper must be an instance method so `this`
 *   still resolves — and that only works when every block is an instance
 *   method of the same class. Otherwise the group cannot be reconciled and is
 *   skipped (returns null).
 */
export function computeExtractionTarget(
    seqs: SeqInfo[],
): ExtractionTarget | null {
    const groupUsesThis = seqs.some((s) => usesThis(s.statements));
    if (!groupUsesThis) return { kind: "function" };

    const first = seqs[0];
    const allInstanceSameClass = seqs.every(
        (s) =>
            s.kind === "method" &&
            !s.isStatic &&
            !!s.className &&
            s.className === first.className,
    );
    if (allInstanceSameClass && first.className) {
        return { kind: "instanceMethod", className: first.className };
    }
    return null;
}

/**
 * Re-indent a block of code so its minimum-indent line sits at `targetIndent`,
 * preserving relative indentation. When the block already shares a common
 * leading indent it is stripped first; lines below that indent are trimmed.
 */
export function reindentBlock(text: string, targetIndent: string): string {
    const base = detectBaseIndent(text);
    return text.split("\n").map((line) => {
        if (line.trim().length === 0) return "";
        if (line.startsWith(base)) {
            return targetIndent + line.slice(base.length);
        }
        return targetIndent + line.trimStart();
    }).join("\n");
}

/**
 * Insert a method (given as source text, e.g. `helperName(p) { ... }`) as the
 * last member of the named class, at one indent level. Returns the new source,
 * or null if the class cannot be located (the caller's parse check will then
 * reject the attempt).
 */
export function insertMethodIntoClass(
    source: string,
    className: string,
    methodText: string,
): string | null {
    let ast: any;
    try {
        ast = parseSource(source);
    } catch {
        return null;
    }

    let endLine: number | null = null;
    visit(ast, {
        visitClassDeclaration(path) {
            if (
                path.node.id?.name === className &&
                path.node.body?.loc?.end
            ) {
                endLine = path.node.body.loc.end.line;
                return false;
            }
            this.traverse(path);
        },
    });
    if (endLine === null) return null;

    const indented = reindentBlock(methodText.trimEnd(), "    ");
    const lines = source.split("\n");
    const before = lines.slice(0, endLine - 1);
    const after = lines.slice(endLine - 1);
    return [...before, indented, ...after].join("\n");
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

        // A fingerprint is eligible for extraction only if its group overlapped
        // the diff in the ORIGINAL source (decided once, exactly, above).
        // Subsequent re-detection passes mutate the source, shifting line
        // numbers, so they reuse this set rather than re-checking the now-shifted
        // diff ranges.
        const approvedFingerprints = new Set(
            groups.map((g) => g[0].fingerprint),
        );

        const descriptions: string[] = [];
        let currentSource = source;
        const doneFingerprints = new Set<string>();

        // Extract one group per pass, re-detecting from the (possibly mutated)
        // source each time so block coordinates stay exact after every
        // extraction. The loop is bounded by the number of eligible fingerprints:
        // each pass marks exactly one as done before continuing.
        for (let pass = 0; pass < approvedFingerprints.size + 1; pass++) {
            // currentSource is always parseable here: it starts as `source`
            // (parsed successfully above) and is only ever reassigned to a
            // proposedSource that already passed its own parse check.
            const passAst = parseSource(currentSource);

            const passSeqs = collectSequences(
                passAst,
                currentSource.split("\n"),
                config.duplicate_extractor_min_lines,
                config.duplicate_extractor_max_lines,
            );
            const passGroups = findDuplicateGroups(passSeqs, ANY_RANGE);
            const group = passGroups.find(
                (g) =>
                    approvedFingerprints.has(g[0].fingerprint) &&
                    !doneFingerprints.has(g[0].fingerprint),
            );
            if (!group) break;

            const fingerprint = group[0].fingerprint;
            doneFingerprints.add(fingerprint);

            log?.(
                `dripbird: duplicate_extractor: candidate group with ${group.length} blocks: ${
                    group.map((s) => `${s.startLine}-${s.endLine}`).join(", ")
                }`,
            );

            const codeBlocks = group.map((seq) => seq.source);
            const verifyResult = await llm.verifyDuplicateMatch(
                codeBlocks,
                currentSource,
            );
            if (!verifyResult.isMatch) {
                log?.(
                    `dripbird: duplicate_extractor: LLM rejected group: ${verifyResult.reason}`,
                );
                continue;
            }

            let remaining = group;
            if (verifyResult.excludeIndices.length > 0) {
                const exclude = new Set(verifyResult.excludeIndices);
                remaining = group.filter((_, i) => !exclude.has(i));
                if (remaining.length < 2) {
                    log?.(
                        `dripbird: duplicate_extractor: too few blocks after exclusion`,
                    );
                    continue;
                }
            }

            const target = computeExtractionTarget(remaining);
            if (target === null) {
                log?.(
                    `dripbird: duplicate_extractor: group uses \`this\` but blocks are not all instance methods of one class; skipping`,
                );
                continue;
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
                    target.kind === "instanceMethod"
                        ? { kind: "instanceMethod", className: target.className }
                        : undefined,
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

                const callSites = extraction.callSites.map((cs, i) => {
                    const targetIndent = detectBaseIndent(remainingBlocks[i]);
                    return normalizeCallSiteIndent(cs, targetIndent);
                });

                let proposedSource = currentSource;

                const sortedIndices = remaining
                    .map((seq, i) => ({
                        seq,
                        callSite: callSites[i],
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

                if (target.kind === "instanceMethod") {
                    const inserted = insertMethodIntoClass(
                        proposedSource,
                        target.className,
                        extraction.helperFunction,
                    );
                    if (inserted === null) {
                        log?.(
                            `dripbird: duplicate_extractor: could not place instance method into class ${target.className} (attempt ${
                                attempt + 1
                            }/${maxAttempts})`,
                        );
                        lastFeedback =
                            `Could not insert the helper as an instance method into class ${target.className}. Ensure the helper is a single method (no leading "function" keyword) and uses \`this.\` call sites.`;
                        continue;
                    }
                    proposedSource = inserted;
                } else {
                    proposedSource = proposedSource.trimEnd() + "\n\n" +
                        extraction.helperFunction + "\n";
                }

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
