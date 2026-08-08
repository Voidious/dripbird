# Live end-to-end testing

dripbird's test suite (`deno task test:coverage`) mocks the LLM client, so it never
spends tokens or exercises a real model. **Live e2e testing** feeds an actual diff
to a real dripbird build and a real LLM, then judges the output. Run it whenever you
change a refactor's behavior, prompts, or pipeline — the unit suite cannot catch a
regression that only shows up against live model traffic.

This doc is the contributor-facing recipe: how to set up, run a sample against a
live LLM, and judge the result.

## Prerequisites

- **Deno 2.0+** on your PATH.
- **dripbird installed globally** from a repo checkout (re-run after changes to
  `src/cli.ts` or its dependencies so the binary matches the working tree):

  ```bash
  deno task install
  ```

- **An LLM API key.** Set `MOONSHOT_API_KEY` in your environment:

  ```bash
  export MOONSHOT_API_KEY="your-api-key-here"
  ```

  Without it, the LLM-backed refactors (function splitter, function matcher,
  duplicate extractor) are silently disabled. The `if_not_else` refactor needs no
  key.

## The recipe (parametric over a sample)

Every refactor ships a sample under `samples/<refactor>/<variant>/` with a uniform
layout:

```
samples/<refactor>/<variant>/
    a/example.ts      # input file
    b/example.ts      # one valid expected output
    dripbird.yml      # config scoped to this sample's refactor
```

To run a sample live, copy `a/` and the config into a throwaway directory and feed
dripbird a "whole file added" diff so every line is in range:

```bash
repo=/path/to/dripbird
sample=function_splitter/basic      # any dir under samples/

work=$(mktemp -d)
cp "$repo/samples/$sample/a/example.ts" "$work/example.ts"
cp "$repo/samples/$sample/dripbird.yml" "$work/dripbird.yml"
cd "$work"

git diff --no-index /dev/null example.ts | dripbird
echo "exit: $?"                      # 1 = changed, 0 = no change
```

Notes:

- `git diff --no-index /dev/null <file>` needs **no git repo** and produces a "whole
  file added" diff, putting every line in range.
- Run dripbird **from the workdir**. It loads `dripbird.yml` and reads `example.ts`
  relative to `Deno.cwd()` (`runInDir` in `src/main.ts`).
- Each sample's `dripbird.yml` is scoped — it enables just that refactor (the
  splitter sample also lowers `max_function_lines` to `20`).

### Available samples

| sample                           | refactor            | uses LLM | determinism                 |
| -------------------------------- | ------------------- | -------- | --------------------------- |
| `if_not_else/basic`              | if_not_else         | no       | deterministic (pure AST)    |
| `function_matcher/basic`         | function_matcher    | yes      | constrained — usually exact |
| `function_matcher/static_method` | function_matcher    | yes      | constrained — usually exact |
| `function_splitter/basic`        | function_splitter   | yes      | open-ended — diverges       |
| `duplicate_extractor/basic`      | duplicate_extractor | yes      | open-ended — diverges       |

## Reading the result

- **Exit `1` = changes applied (success). Exit `0` = no change** — the refactor
  found nothing in range, or every candidate was rejected. Hooks piping into
  dripbird must treat `1` as success, not error. See `runInDir` in `src/main.ts`.
- Progress and the summary go to **stderr**; stdout stays clean. Each LLM call logs
  a line like:

  ```
  dripbird: llm: 5500ms, 757 in, 180 out → review change
  ```

  followed by a per-file / per-refactor summary.
- dripbird writes a file only after its internal output check passes and (for LLM
  refactors) `reviewChange` accepts the edit. So **exit 1 implies syntactically
  valid output** — but see the caveat below.

## How to judge: a two-stage gate

Do **not** assert byte-equality with `b/` for every refactor. Judge in two stages.

### Stage 1 — always type-check the output

```bash
deno check example.ts
```

This is required because dripbird's internal output check is **syntax-only** (it
parses the result with recast/babel to confirm the file is still parseable); it does
**not** run the TypeScript type checker. A refactor can emit output that parses fine
but has type errors and still exit `1`.

Treat any `deno check` error as a test failure, regardless of how the output
otherwise looks.

### Stage 2 — compare against `b/` by determinism class

Only after the output type-checks, compare it to `b/example.ts`:

```bash
diff example.ts "$repo/samples/$sample/b/example.ts"
```

What a match means depends on the refactor:

- **Deterministic (`if_not_else`):** expect a byte-for-byte match with `b/`. No LLM
  is involved; a diff is a real regression.
- **Constrained LLM (`function_matcher`):** it replaces a duplicate with a call to
  an _existing_ function, so there are few degrees of freedom. An exact match is
  expected. If it diverges, check whether it's a naming choice (often fine) or a
  real bug.
- **Open-ended LLM (`function_splitter`, `duplicate_extractor`):** multiple valid
  extractions exist (different split boundaries, helper signatures, or
  return-vs-side-effect choices). Judge by intent, not bytes: (1) the exit code is
  `1`, (2) the overlong/duplicate code is actually gone, (3) a single helper plus
  call sites replaced it, (4) semantics are preserved. Treat `b/` as **one valid
  reference**, not an oracle.

Because LLM output is non-deterministic, the open-ended refactors can produce a
different (still valid) extraction on each run. Gate on validity + intent, not on
reproducing a single run's bytes.

## Known divergences (recorded, not bugs)

These are observed when the open-ended refactors pick a validly different extraction
than `b/`:

- **`function_splitter/basic`:** live runs often split `buildReport` into a
  multi-parameter helper (e.g. `generateStatsReport` with 9 params), while `b/`
  shows a 2-param `buildReportStatistics`. Both are valid splits.
- **`duplicate_extractor/basic`:** live runs tend to make the helper _return_ the
  formatted entry (caller logs it), while `b/` has the helper log internally. Both
  preserve behavior.

If a run diverges in a way that breaks the Stage 2 intent criteria (or fails Stage
1), that's a real regression — investigate before moving on.

## Running every sample

A quick sweep of all samples is a cheap gate after touching shared pipeline code:

```bash
repo=/path/to/dripbird
export MOONSHOT_API_KEY="..."

for sample in \
    if_not_else/basic \
    function_matcher/basic \
    function_matcher/static_method \
    function_splitter/basic \
    duplicate_extractor/basic; do
    echo "=== $sample ==="
    work=$(mktemp -d)
    cp "$repo/samples/$sample/a/example.ts" "$work/example.ts"
    cp "$repo/samples/$sample/dripbird.yml" "$work/dripbird.yml"
    (cd "$work" && git diff --no-index /dev/null example.ts 2>/dev/null | dripbird)
    echo "exit: $?"
    deno check "$work/example.ts" && echo "type-check: ok"
    rm -rf "$work"
done
```

Expect the deterministic and constrained samples to type-check and match `b/`;
expect the open-ended samples to type-check but diverge from `b/` in shape.
