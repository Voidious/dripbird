# Dripbird

Dripbird is a TypeScript/JavaScript automated refactoring tool. It reads a unified
diff from stdin, identifies changed lines, applies a set of automated refactors only
to the changed regions, and writes modified files back in place.

It uses [recast](https://github.com/benjamn/recast) for format-preserving AST
transformations.

## Overview

```
git diff --cached HEAD~1 | dripbird
```

Dripbird operates only on the lines you actually changed — not the whole file. Each
refactor receives the diff's line ranges and skips code outside those ranges. This
makes it safe to run on any in-progress change without disturbing surrounding code.

If Dripbird modifies a file, it exits with code 1 (signaling a pre-commit hook to
abort so you can re-stage). If no changes are needed, it exits 0.

## Installation

Requires [Deno](https://deno.land) 2.0+ and
[Lefthook](https://github.com/evilmartians/lefthook).

```bash
git clone https://github.com/Voidious/dripbird
cd dripbird
```

## Usage

Pipe any unified diff to dripbird:

```bash
# Refactor uncommitted changes
git diff | dripbird

# Refactor staged changes
git diff --cached | dripbird

# Refactor changes since a specific commit
git diff HEAD~1 | dripbird

# Refactor a specific file as if it were entirely new
git diff /dev/null somefile.ts | dripbird
```

Dripbird prints a summary of every change it applies, modifies files in place, and
exits 1 if any file was changed.

## Refactors

### 1. Flip negated if/else

**Flips `if (!condition) { ... } else { ... }` to eliminate the negation.**

When an `if` has a negated condition (`!`) and an `else` clause that is not an
`else if`, Dripbird removes the `!` and swaps the two branches. This eliminates a
layer of logical indirection and makes intent clearer.

**Before:**

```typescript
if (!validInput(frequency, duration)) {
    doErrorThing();
} else {
    doMainThing();
}
```

**After:**

```typescript
if (validInput(frequency, duration)) {
    doMainThing();
} else {
    doErrorThing();
}
```

Skipped when:

- There is no `else` clause
- The `else` is an `else if` chain (which would change semantics)
- The condition is not a top-level `!` expression

## Architecture

```
stdin (unified diff)
        │
        ▼
src/cli.ts                 Entry point: reads stdin, calls run()
        │
        ├── src/diff.ts            parseDiff() → DiffHunk[], groupByFile()
        │
        └── src/main.ts            run() / runInDir(): reads files, runs engine, writes back
                │
                └── src/engine.ts  runRefactors(): chains refactors sequentially
                        │
                        └── src/refactors/
                                └── if_not_else.ts    Flip negated if/else
```

### Adding a new refactor

1. Create `src/refactors/my_refactor.ts` implementing the `Refactor` type from
   `engine.ts`.
2. The function receives `(source: string, ranges: ChangedRange[])` and returns
   `{ changed, source, description }`.
3. Check `inRange(node.loc.start.line, node.loc.end.line, ranges)` to only touch
   changed regions.
4. Register it in the refactors array in `src/main.ts`.
5. Add tests in `tests/refactors/my_refactor_test.ts` — 100% branch and line
   coverage is enforced.

## Development

```bash
deno task fmt            # format code
deno task fmt:check      # check formatting
deno task lint            # lint
deno task test            # run tests
deno task test:coverage   # run tests with 100% coverage enforcement
```

Pre-commit hooks (via Lefthook) run `deno fmt --check`, `deno lint`, and the 100%
coverage test suite automatically.
