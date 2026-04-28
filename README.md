# dripbird

dripbird is a TypeScript/JavaScript automated refactoring tool. It reads a unified
diff from stdin, identifies changed lines, applies a set of automated refactors only
to the changed regions, and writes modified files back in place.

It uses [recast](https://github.com/benjamn/recast) for format-preserving AST
transformations and optional LLM integration (via Moonshot AI) for intelligent
function naming.

_The wise dripbird sits perched among the highest branches of the Abstract Syntax
Trees in the forest of code. Dressed in a suit that absolutely slays, the dripbird
is ready to sharpen your change set before it gets checked in—for real._

## Overview

```
git diff --cached HEAD~1 | dripbird
```

dripbird operates only on the lines you actually changed — not the whole file. Each
refactor receives the diff's line ranges and skips code outside those ranges. This
makes it safe to run on any in-progress change without disturbing surrounding code.

If dripbird modifies a file, it exits with code 1 (signaling a pre-commit hook to
abort so you can re-stage). If no changes are needed, it exits 0.

## Installation

Requires [Deno](https://deno.land) 2.0+ and
[Lefthook](https://github.com/evilmartians/lefthook).

```bash
git clone https://github.com/Voidious/dripbird
cd dripbird
deno task install
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

dripbird prints a summary of every change it applies, modifies files in place, and
exits 1 if any file was changed.

## Configuration

dripbird reads optional YAML config files from your project root:

- **`dripbird.yml`** — committed, shared project defaults
- **`.dripbird.yml`** — local overrides (git-ignored, for personal preferences)

Local overrides take precedence over committed settings.

### Options

| Option                      | Default       | Description                                                                               |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `max_function_lines`        | `75`          | Line count threshold above which the function splitter will consider splitting a function |
| `function_splitter_retries` | `2`           | Number of LLM retry attempts when naming a helper function                                |
| `provider`                  | `"moonshot"`  | LLM provider (currently only `"moonshot"`)                                                |
| `model`                     | `"kimi-k2.5"` | LLM model name to use                                                                     |
| `enabled_refactors`         | `[]`          | If non-empty, only these refactors will run                                               |
| `disabled_refactors`        | `[]`          | These refactors will be skipped                                                           |

### Example `dripbird.yml`

```yaml
max_function_lines: 50
function_splitter_retries: 3
disabled_refactors:
    - function_splitter
```

### LLM Setup

The function splitter refactor requires a Moonshot AI API key. Set the
`MOONSHOT_API_KEY` environment variable:

```bash
export MOONSHOT_API_KEY="your-api-key-here"
```

If the API key is not set, the function splitter is automatically disabled. All
other refactors (e.g., flip negated if/else) work without LLM access.

## Refactors

### 1. Flip negated if/else

**Flips `if (!condition) { ... } else { ... }` to eliminate the negation.**

When an `if` has a negated condition (`!`) and an `else` clause that is not an
`else if`, dripbird removes the `!` and swaps the two branches. This eliminates a
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

### 2. Function splitter

**Splits long functions into smaller, well-named helper functions.**

When a function exceeds `max_function_lines` and falls within the diff, dripbird
identifies a good split point, computes the free variables the tail needs, extracts
the tail into a new helper function, and replaces the original tail with a call to
it. The helper function's name is suggested by an LLM to be semantically meaningful.

Works on both standalone function declarations and class methods. For class methods,
it automatically determines whether the helper should be a static method (if `this`
is not used) or an instance method.

**Before:**

```typescript
function processOrder(order: Order, user: User) {
    validateOrder(order);
    const total = calculateTotal(order.items);
    const discount = applyDiscount(user, total);
    const finalAmount = total - discount;
    chargePayment(finalAmount, user.paymentMethod);
    sendConfirmation(user.email, order.id);
    updateInventory(order.items);
    logTransaction(order.id, finalAmount);
}
```

**After:**

```typescript
function processOrder(order: Order, user: User) {
    validateOrder(order);
    const total = calculateTotal(order.items);
    const discount = applyDiscount(user, total);
    const finalAmount = total - discount;
    chargePayment(finalAmount, user.paymentMethod);
    return finalizeOrder(user, order, finalAmount);
}

function finalizeOrder(user: User, order: Order, finalAmount: number) {
    sendConfirmation(user.email, order.id);
    updateInventory(order.items);
    logTransaction(order.id, finalAmount);
}
```

Skipped when:

- The function is under `max_function_lines`
- The function is `async` or a generator
- The function contains nested function declarations
- No LLM API key is configured (`MOONSHOT_API_KEY`)

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
                ├── src/config.ts  loadConfig(): reads dripbird.yml + .dripbird.yml
                │
                ├── src/llm.ts     createLLMClient(): Moonshot AI integration
                │
                └── src/engine.ts  runRefactors(): chains refactors sequentially
                        │
                        └── src/refactors/
                                ├── if_not_else.ts         Flip negated if/else
                                └── function_splitter.ts   Split long functions (LLM-assisted)
```

### Adding a new refactor

1. Create `src/refactors/my_refactor.ts` implementing the `Refactor` type from
   `engine.ts`.
2. The function receives `(source: string, ranges: ChangedRange[])` and returns
   `{ changed, source, description }` (sync or async).
3. Check `inRange(node.loc.start.line, node.loc.end.line, ranges)` to only touch
   changed regions.
4. Register it as a `NamedRefactor` in `src/main.ts` with a unique name (used by
   `enabled_refactors`/`disabled_refactors`).
5. Add tests in `tests/refactors/my_refactor_test.ts` — 100% branch and line
   coverage is enforced.

## Development

```bash
deno task fmt            # format code
deno task fmt:check      # check formatting
deno task lint            # lint
deno task test            # run tests
deno task test:coverage   # run tests with 100% coverage enforcement
deno task install         # install the dripbird CLI globally
```

Pre-commit hooks (via Lefthook) run `deno fmt --check`, `deno lint`, and the 100%
coverage test suite automatically.
