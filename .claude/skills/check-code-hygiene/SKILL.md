---
name: check-code-hygiene
description: Check code for standardization, readability, maintenance complexity, and defensive coding practices
allowed-tools: Read, Grep, Glob, Bash, Agent
---

> **Rules live in CLAUDE.md and the requirements docs, not here.** Before flagging
> anything against a *rule*, open `CLAUDE.md` (and the relevant doc under
> `docs/requirements/`) and read the current text; treat any figure quoted below
> as a pointer to the right section, never as the authority. The mechanical
> recipes (greps, `wc`, dependency checks) are the durable part of this skill.

Analyze the `pueue-wait-cond` codebase for hygiene issues. Generate a report on
standardization, human readability, maintenance complexity, and defensive coding.

Scope: `src/`, and `test/` where relevant. `.github/scripts/` and `scripts/` are
shell and get a lighter pass (see § 5).

## Analysis Areas

### 1. Standardization

- **File naming**: `src/` uses camelCase filenames that mirror the primary
  export or concern (`exitCodes.ts`, `condition.ts`, `wait.ts`). The principle is
  "filename = what's in it". Flag a name matching neither the convention nor its
  contents.
- **Identifier naming**: camelCase values, PascalCase types/classes,
  SCREAMING_SNAKE_CASE module constants (`TARGET_STATUSES`, `LIFECYCLE_RANK`,
  `EXIT`). Flag inconsistencies.
- **Import patterns**: every relative import must carry the `.js` extension
  (ESM + `NodeNext`). eslint enforces `consistent-type-imports`, so if lint
  passes, `import type` usage is fine. The `.js` check is yours:
  ```
  grep -rnE "from '\.\.?/[^']*'" src/ test/ | grep -v "\.js'"
  ```
- **Error message style**: errors carry a hint, not just a symptom — compare
  `PueueError`'s *"Could not find the pueue binary … point at it with
  --pueue-binary"* and `ConditionSpawnError`'s naming of the offending condition.
  Flag terse `throw new Error('failed')`-style throws.
- **Exit codes**: every failure path must map to a named member of
  `src/exitCodes.ts`, never a bare number at the call site.

### 2. Human Readability

- **File length**: rank with `wc -l src/*.ts | sort -rn`, then judge each large
  file on whether it holds one concern or two. `src/wait.ts` housing the entire
  poll loop is one concern and is **not** a finding; `src/args.ts` being long
  because `helpText()` is a long string is likewise not a finding.
- **Function length**: flag functions over ~50 lines that hold more than one
  idea. `waitForConditions` is the deliberate exception — its ordering is the
  specification (`docs/requirements/03-conditions.md` R3.2) and splitting it
  would hide that.
- **Nesting depth**: flag more than 3 levels.
- **Magic numbers / strings**: hardcoded values that should be constants. Default
  durations (2s interval, 30s condition timeout, 5s task grace) are defined in
  `parseCliArgs` and documented; flag any *new* unexplained literal, especially
  in `src/wait.ts` or `src/condition.ts` (e.g. the 2s SIGKILL grace).
- **Comment style**: the house style is comments for *why*, not *what*. A block
  explaining a decision (why completion is checked before conditions; why an
  existing file wins over an inline command) is a feature. A comment paraphrasing
  the next line is noise. Flag both missing-when-needed and noise-when-not.

### 3. Maintenance Complexity

- **Coupling**: derive the graph rather than matching a list:
  ```
  grep -rhoE "from '\./[a-zA-Z]+" src/*.ts | sort | uniq -c | sort -rn
  ```
  Expect `status`, `exitCodes` and `args` near the top — they are the shared
  vocabulary. Flag an edge that crosses concerns for no stated reason, not
  merely a high-degree node. `src/index.ts` importing everything is the barrel
  doing its job.
- **Layering**: `src/cli.ts` owns `process.*` (argv, streams, signals,
  `process.exitCode`); nothing below it should touch those. Grep for
  `process.exit`, `process.argv` or `process.stdout` outside `cli.ts` — that is
  what makes the CLI testable in-process, so a leak is a real finding.
  `process.env` and `process.cwd()` are legitimately read lower down (condition
  resolution), so judge those on merit.
- **Shared mutable state**: sweep with `grep -rnE '^let |^export let ' src/`.
  The loop-local `let`s inside `waitForConditions` are fine; **module-level**
  mutable state is not, and there should be none. Anything found is a finding
  even if the code is correct, because the invariant is what makes the tool
  re-entrant.
- **Injection seams**: the codebase is testable because of a small number of
  deliberate seams — `RunOptions.createClient`, `WaitDeps.now` / `.sleep` /
  `.signal` / `.env`, `Reporter`'s injected `now` and writers. Flag any new code
  path that reaches for the real clock, real environment or real process
  directly instead of threading through these.
- **Switch / if-else chains**: flag chains > 6 branches without a lookup table.
  `hasReached` deliberately uses ranked lookup tables rather than a chain —
  follow that.
- **Duplicate patterns**: particularly a second place that unpacks pueue's tagged
  enums (belongs in `src/status.ts`) or formats a task for output (`src/json.ts`
  and `snapshotForConditions` intentionally share a shape — verify they have not
  silently diverged).

### 4. Defensive Coding

- **Input validation at boundaries.** This tool's boundaries are the command
  line, pueue's JSON, and condition scripts:
  - `parseCliArgs` — every option validated, every failure a `UsageError` naming
    the flag. Flag a new option added without validation.
  - `parseSnapshot` — must stay defensive about *every* field (missing `id`,
    unknown status variant, non-numeric `Failed` payload). See
    `docs/requirements/02-wait-semantics.md` R2.2. A crash here means a pueue
    upgrade breaks the tool.
  - `resolveCommand` / `runCondition` — a condition that cannot be *executed* is
    a distinct outcome (exit `6`) from one that returns non-zero. Flag anything
    that collapses the two.
- **Error boundaries**: selective catches with a stated reason are wanted (the
  `EPIPE`-ignoring stdin handler, the best-effort temp-dir cleanup). Flag any
  blanket `try { … } catch { /* swallow */ }` without a comment saying why.
- **Null safety**: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
  are on, so the compiler catches most of this. Flag any `!` non-null assertion
  in `src/`.
- **Type safety**: grep `src/` for `: any\b`, `as any\b`, `<any>`. The house
  pattern is `unknown` plus a guard — see `unpackEnum`/`unpackResult` in
  `src/status.ts`. Flag any `any`.
- **Secret surface**: the one genuinely dangerous thing this tool handles is
  `pueue status --json`, which embeds every task's whole environment. Verify
  `snapshotForConditions` (`src/wait.ts`) and the `--json` builder
  (`src/json.ts`) both still project a reduced task shape, and that the tests
  asserting `envs` never appears are intact. Treat a regression as **high**.
- **Resource cleanup**: condition children get SIGTERM then SIGKILL; the snapshot
  temp dir is removed in a `finally`. Flag any new spawn or temp file without a
  matching cleanup path.

### 5. Shell scripts

`scripts/release.sh`, `scripts/release-beta-auto.sh` and
`.github/scripts/install-pueue.sh` are shipped tooling and deserve a lighter but
real pass:

- `set -euo pipefail` present.
- `bash -n <file>` parses; run `shellcheck` if available.
- Quoted expansions, especially paths (`"$DEST"`, `"$TMPDIR"`).
- **`!` binds to one command**, so `if ! a && b` does not mean "not (a and b)".
  This exact bug was found and fixed once already — check for its return.
- `curl` uses `--fail` so a 404 is an error rather than an HTML page written to
  a file.

## Report Format

For each finding:
- **File**: path and line numbers
- **Category**: standardization | readability | maintenance | defensive | shell
- **Severity**: high | medium | low
- **Description**: what the issue is
- **Suggestion**: how to fix it

End with a prioritized summary of the top 10 most impactful improvements — or
fewer. This is a small, deliberately conservative codebase; expect **0–5 in a
healthy state**, and do not pad the list to look thorough. Suggest filing Hot
Sheet tickets (`hs-task` for cleanups, `hs-bug` for real defects) for anything
non-trivial.
