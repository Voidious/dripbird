import { parse, print, visit } from "recast";
import * as babelParser from "@babel/parser";
import type { ChangedRange } from "../diff.ts";
import type { Refactor, RefactorResult } from "../engine.ts";

export function inRange(
    startLine: number,
    endLine: number,
    ranges: ChangedRange[],
): boolean {
    return ranges.some(
        (r) => startLine <= r.end && endLine >= r.start,
    );
}

export const ifNotElse: Refactor = (
    source: string,
    ranges: ChangedRange[],
): RefactorResult => {
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

    let changed = false;
    const descriptions: string[] = [];

    visit(ast, {
        visitIfStatement(path) {
            const node = path.node;

            if (
                !node.loc ||
                !inRange(node.loc.start.line, node.loc.end.line, ranges)
            ) {
                this.traverse(path);
                return;
            }

            if (
                node.test.type !== "UnaryExpression" ||
                node.test.operator !== "!"
            ) {
                this.traverse(path);
                return;
            }

            if (!node.alternate) {
                this.traverse(path);
                return;
            }

            if (node.alternate.type === "IfStatement") {
                this.traverse(path);
                return;
            }

            node.test = node.test.argument;
            const consequent = node.consequent;
            node.consequent = node.alternate;
            node.alternate = consequent;

            changed = true;
            descriptions.push(
                `inverted if-not-else at line ${node.loc?.start?.line}`,
            );

            this.traverse(path);
        },
    });

    if (!changed) {
        return { changed: false, source, description: "" };
    }

    return {
        changed: true,
        source: print(ast).code,
        description: descriptions.join("\n"),
    };
};
