# dripbird

dripbird is a TypeScript/JavaScript automated refactoring tool. It reads a unified
diff from stdin, identifies changed lines, applies a set of automated refactors only
to the changed regions, and writes modified files back in place.

It uses [recast](https://github.com/benjamn/recast) for format-preserving AST
transformations and optional LLM integration (via Moonshot AI) for intelligent
function naming.

_The wise dripbird sits perched among the highest branches of the Abstract Syntax
Trees in the forest of code. Looking snatched in a suit that high key slays, the
dripbird is ready to lock in and sharpen your change set before it becomes canon—for
real._

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

| Option                          | Default       | Description                                                                               |
| ------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `max_function_lines`            | `75`          | Line count threshold above which the function splitter will consider splitting a function |
| `function_splitter_retries`     | `2`           | Number of LLM retry attempts when naming a helper function                                |
| `function_matcher_retries`      | `2`           | Number of LLM retry attempts when a function matcher edit fails verification              |
| `duplicate_extractor_min_lines` | `2`           | Minimum line span for a code block to be considered for duplicate extraction              |
| `duplicate_extractor_max_lines` | `12`          | Maximum line span for a code block to be considered for duplicate extraction              |
| `duplicate_extractor_retries`   | `2`           | Number of LLM retry attempts when a duplicate extraction fails verification               |
| `provider`                      | `"moonshot"`  | LLM provider (currently only `"moonshot"`)                                                |
| `model`                         | `"kimi-k2.5"` | LLM model name to use                                                                     |
| `enabled_refactors`             | `[]`          | If non-empty, only these refactors will run                                               |
| `disabled_refactors`            | `[]`          | These refactors will be skipped                                                           |
| `verbose`                       | `false`       | Print detailed log output for each refactor                                               |

### Example `dripbird.yml`

```yaml
max_function_lines: 50
function_splitter_retries: 3
disabled_refactors:
    - function_splitter
```

### LLM Setup

The function splitter, function matcher, and duplicate extractor refactors require a
Moonshot AI API key. Set the `MOONSHOT_API_KEY` environment variable:

```bash
export MOONSHOT_API_KEY="your-api-key-here"
```

If the API key is not set, all three are automatically disabled. All other refactors
(e.g., flip negated if/else) work without LLM access.

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

### 3. Function matcher

**Replaces duplicate code with calls to existing functions.**

When a code block within the diff is semantically identical to an existing function
body (ignoring variable names), dripbird replaces it with a call to that function.
It uses fingerprint-based matching to find candidates and LLM verification to
confirm the match is semantically correct.

It matches both full statement sequences and single return expressions against
existing function bodies.

**Scope (single file):** standalone function declarations, static class methods, and
instance class methods.

- **Functions and static methods** are reachable from any context via their plain or
  `ClassName.method` name.
- **Instance methods, same class:** a duplicate inside another instance method of
  the same class is replaced with `this.method(...)`. The call site and the target
  share the same `this`, so this is always safe.
- **Instance methods, external context:** a `this`-free (pure) instance method is
  reachable from a free function, static method, or a _different_ class's method
  when an instance reference is in scope at the call site. dripbird resolves one
  from a typed parameter (`p: ClassName`) or a `const x = new ClassName(...)`
  declared before the call site, and emits `<ref>.method(...)`. A `this`-using
  instance method is not matched externally — no external context shares the
  target's `this`, so the call would silently retarget instance state.

**Scope (across files):** a duplicate can also be replaced with a call to an
exported function from another file, but only when the current file already imports
that file with a relative specifier (`./` / `../`). This is the circular-dependency
protection: dripbird never adds or rewrites imports — it only calls through bindings
that already exist in the file — so cross-file matching can never introduce a new
module dependency edge, and therefore can never create an import cycle.

- **Named imports** (alias-aware) call the local binding; `import * as ns` calls
  `ns.exportedName(...)`; a default-exported function is called through the
  default-import binding.
- **Imported classes:** static methods are called as `Binding.method(...)`; pure
  instance methods follow the same in-scope instance-reference rules as single-file
  matching (`p: Binding` or `new Binding(...)` before the call site). A `this`-using
  instance method is never matched from another file.
- Bare specifiers (package names, `npm:`/`@std/` specifiers) and type-only imports
  are not followed — they provide no file path or no runtime binding to call
  through.

**Before:**

```typescript
function sendWelcomeEmail(recipient: string) {
    const subject = "Welcome!";
    const body = `Hello ${recipient}, thanks for signing up.`;
    smtp.send(recipient, subject, body);
}

function registerUser(username: string, email: string) {
    db.insert("users", { username, email });
    const subject = "Welcome!";
    const body = `Hello ${email}, thanks for signing up.`;
    smtp.send(email, subject, body);
}
```

**After:**

```typescript
function sendWelcomeEmail(recipient: string) {
    const subject = "Welcome!";
    const body = `Hello ${recipient}, thanks for signing up.`;
    smtp.send(recipient, subject, body);
}

function registerUser(username: string, email: string) {
    db.insert("users", { username, email });
    sendWelcomeEmail(email);
}
```

**Across files (example):** the current file (`example.ts`) already imports a helper
from `./util`, and `contactHome` duplicates the helper's body:

```typescript
// util.ts
export function sendGreeting(c) {
    c.send("Hello,");
    c.send("I am from Earth.");
    c.send("We come in peace.");
}

// example.ts
import { sendGreeting } from "./util";

function contactHome(base) {
    const signal = getSignal(base);
    signal.send("Hello,");
    signal.send("I am from Earth.");
    signal.send("We come in peace.");
}
```

**After** (in `example.ts` only — `util.ts` is untouched and no import is added):

```typescript
function contactHome(base) {
    const signal = getSignal(base);
    sendGreeting(signal);
}
```

Skipped when:

- The matching code is inside the same function it would call
- An instance method target would be called from an external context but no instance
  reference is in scope (no typed param or preceding `new`)
- The target is a getter or setter (invoked as property access, not a call)
- The target lives in another file the current file does not already import
  (dripbird never adds imports, so it can't create circular dependencies)
- The target lives in another file but is not exported from it
- An imported file cannot be resolved or parsed (the import is skipped with a log
  line)
- The LLM rejects the match as not semantically equivalent
- No LLM API key is configured (`MOONSHOT_API_KEY`)

### 4. Duplicate extractor

**Extracts structurally identical code blocks into a new helper.**

When two or more code blocks within the diff are structurally identical (the same
statements, ignoring variable names), dripbird extracts them into a new helper and
replaces every duplicate with a call to it. Candidates are found with a pure AST
fingerprint (no LLM); the LLM is then asked to verify the match, generate the helper
and call sites, and review the result, with retries feeding rejection feedback
forward.

**Scope (single file):** standalone function declarations, static class methods, and
instance class methods. A duplicate can live across any of these contexts.

- **No `this` in any block:** the helper is a top-level function declaration
  appended at the end of the file, and call sites are plain calls. This applies to
  duplicates in free functions, static methods, and instance methods alike.
- **A block uses `this`:** the helper is extracted as an instance method on the
  class, placed inside the class body, and the call sites use `this.helper(...)`.
  This is only done when every duplicate block is an instance method of the same
  class; otherwise the group is skipped (`this` cannot be reconciled).

**Before:**

```typescript
class Account {
    logDeposit(amount: number) {
        const record = `${this.name}: ${amount}`;
        console.log(record);
    }

    logWithdrawal(amount: number) {
        const record = `${this.name}: ${amount}`;
        console.log(record);
    }
}
```

**After:**

```typescript
class Account {
    logDeposit(amount: number) {
        this.logAmount(amount);
    }

    logWithdrawal(amount: number) {
        this.logAmount(amount);
    }

    logAmount(amount: number) {
        const record = `${this.name}: ${amount}`;
        console.log(record);
    }
}
```

Skipped when:

- Fewer than two duplicate blocks overlap the diff
- The LLM rejects the group as not actually duplicated
- A block uses `this` but the blocks are not all instance methods of one class
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
                ├── src/type_checker.ts  TypeCheckerImpl: TypeScript type checking
                │
                └── src/engine.ts  runRefactors(): chains refactors sequentially
                        │
                        └── src/refactors/
                                ├── if_not_else.ts         Flip negated if/else
                                ├── function_splitter.ts   Split long functions (LLM-assisted)
                                ├── function_matcher.ts    Replace duplicate code with function calls (LLM-assisted)
                                ├── function_matcher_imports.ts Cross-file import resolution for the function matcher
                                └── duplicate_extractor.ts Extract duplicate blocks into a helper (LLM-assisted)
```

### Adding a new refactor

1. Create `src/refactors/my_refactor.ts` implementing the `Refactor` type from
   `engine.ts`.
2. The function receives
   `(source: string, ranges: ChangedRange[], context?: RefactorContext)` and returns
   `{ changed, source, description }` (sync or async). `RefactorContext` carries the
   file's path and an optional `readFile` for following imports across files (see
   `function_matcher_imports.ts`).
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

The test suite mocks the LLM client, so it runs offline and never spends tokens. To
validate a refactor's behavior against a real LLM, see
[Live end-to-end testing](docs/live-e2e-testing.md).
