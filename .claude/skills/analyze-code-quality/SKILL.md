---
name: analyze-code-quality
description: Run all available tests and linters, check for anti-patterns, and generate a comprehensive code quality report
allowed-tools: Read, Grep, Glob, Bash, Agent
---

> **Thresholds and file lists live in the config files, not here.** `.c8rc.json` owns
> the coverage setup, `tsconfig.build.json` owns what ships, `package.json` owns the
> scripts and the dependency invariant, `CLAUDE.md` owns the conventions. Read the
> source of truth; treat any figure below as a pointer to where to look. The
> mechanical recipes are the durable part of this skill.

Analyze the overall quality of the `pueue-wait-cond` source. Generate a
comprehensive report.

## Steps

1. **Run the unit suite**
   ```
   npm run test:unit
   ```
   Report total tests and pass/fail. These use fakes only — no daemon, no
   network. `test/helpers/fakes.ts` is the shared harness.

2. **Run the E2E suite** — this is the equivalent of a "dist regression" run,
   because it drives the *shipped* `bin/pueue-wait-cond.js` (and therefore
   `dist/`) as a child process, not the TypeScript sources.
   ```
   PWC_REQUIRE_PUEUE=1 npm run test:e2e
   ```
   Two layers live here and a failure means different things in each:
   - `test/e2e/cli.test.ts` — the real binary against a **stub** `pueue`. A
     failure is a CLI/plumbing regression.
   - `test/e2e/daemon.test.ts` — the real binary against a **real, isolated
     `pueued`**. A failure is a genuine integration break.

   **Always set `PWC_REQUIRE_PUEUE=1`.** Without it, a machine missing pueue
   skips the entire daemon suite and reports a green run in which nothing ran.
   If you see a suspiciously small test count, that is what happened.

3. **Merged coverage**
   ```
   npm run coverage
   ```
   Reports unit + E2E merged (c8, shared `--temp-directory`). **Note the
   thresholds are not enforced** — `.c8rc.json` sets reporters, not a gate — so
   unlike a project with a configured bar, a coverage drop here will NOT fail
   the run. That makes this step a real check rather than a formality: compare
   against the figure recorded in `docs/requirements-summary.md` § *Test
   coverage* and flag any regression.

   **Coverage is a floor, not a ceiling.** 100% line coverage proves every line
   *executed* — not that every *behaviour*, or every *sequence* of behaviours, is
   *asserted*. It is structurally blind to a missing state transition. Do NOT
   treat a green coverage report as proof of correctness — treat it as the
   trigger for the behavioural audit in step 6.

   Uncovered lines that are genuinely unreachable defensive guards are not
   findings, but each one should be *justified*. If you find an uncovered branch
   with no comment explaining why it cannot be reached, that is a finding — either
   it needs a test or it is dead code (removing one such branch in `args.ts` was
   the right call previously).

4. **Lint and typecheck**
   ```
   npm run lint
   npm run typecheck
   ```
   `typecheck` covers `test/` as well as `src/` — a green `build` does not imply a
   green `typecheck`. Report errors grouped by rule / file.

5. **Check for anti-patterns**

   Read `CLAUDE.md` and the requirements docs under `docs/requirements/` first.
   Then look for violations in `src/`:

   - **Zero runtime dependencies.** This is a documented invariant
     (`docs/requirements/05-packaging.md` R5.2) and the main reason the package
     is safe to drop into someone's CI. Verify the `dependencies` block:
     ```
     node -e "const p=require('./package.json');console.log('deps:',JSON.stringify(p.dependencies??{}))"
     ```
     Anything non-empty is a **high severity** finding.

   - **Missing `.js` extension on relative imports.** The project is ESM with
     `NodeNext` resolution, so every relative import must carry `.js`:
     ```
     grep -rnE "from '\.\.?/[^']*'" src/ test/ | grep -v "\.js'"
     ```

   - **`any` leaks.** Grep `src/` for `: any\b`, `as any\b`, `<any>`. The house
     pattern is `unknown` plus a narrowing guard — see `unpackEnum` in
     `src/status.ts`. Flag any `any`.

   - **Non-null assertions.** Flag `!` assertions in `src/` (tests get a pass).
     `noUncheckedIndexedAccess` is on, so these are usually a shortcut around a
     real case.

   - **Secret leakage into user-visible output.** `pueue status --json` embeds
     every task's whole environment, routinely including API keys. Two places
     must strip it — `snapshotForConditions` (`src/wait.ts`, what condition
     scripts see) and the `--json` result builder (`src/json.ts`). Verify both
     still project a reduced task shape and that the tests asserting `envs` never
     appears are still present. A regression here is **high severity**.

   - **Exit-code collisions.** `src/exitCodes.ts` is a public contract. Verify
     every member is unique and named; there is a test for this, confirm it still
     runs.

   - **Flag/doc drift.** `CLAUDE.md` calls this out explicitly: a flag is defined
     in `helpText()` (`src/args.ts`), documented in `README.md`, and specified in
     `docs/requirements/`. Cross-check that the three agree — this is the most
     likely drift in the project. `check-requirements-against-code` goes deeper;
     a quick diff of the option names is enough here.

   - **Help output width.** There is a test pinning every help line to ≤ 100
     columns. Confirm it still passes rather than eyeballing.

   - **File length.** Rank with `wc -l src/*.ts | sort -rn`, then judge each large
     file on how many concerns it holds. `src/wait.ts` housing the whole poll loop
     is one concern and is not a finding.

   - **Duplicate patterns.** Spot-check for the same logic expressed twice —
     particularly status/enum unpacking outside `src/status.ts`, or a second
     place that formats a task for output.

6. **Behavioural / state-transition audit** (the step coverage cannot do for you)

   `CLAUDE.md` § *Testing Philosophy* mandates transition-matrix testing for
   stateful modules. This step audits it.

   - **Identify the stateful modules.** Confirm the current set with `ls src/`
     rather than trusting this list. Today the canonical one is
     **`waitForConditions` in `src/wait.ts`** — it carries `previous`,
     `announced`, `warnedMissing`, `missingSince`, `iteration` and `meta` across
     polls, and its decision order (complete → until → while → timeout) is
     load-bearing. `src/status.ts` (`hasReached` / `isUnreachable`) is a pure
     status × target matrix, and `src/reporter.ts` holds first-sighting state.

   - **Enumerate states and transitions.** For the wait loop: task lifecycle
     (`queued → running → done`, plus off-line `stashed`/`paused`/`locked`), the
     unknown-id grace timer (absent → present → absent), condition outcomes, and
     the interaction between them.

   - **Check the tests walk transitions, not just operations.** Grep
     `test/unit/wait.test.ts` for multi-step sequences crossing state boundaries
     (`stashed → queued → running → done`, `running → paused → running → done`,
     empty-then-refilled, a task appearing mid-wait, a `--while` flipping false
     before completion, the grace timer resetting on reappearance). **Flag any
     stateful module whose tests only exercise single-operation-from-clean-state**
     — that is the exact gap a green coverage report hides.

   - **Recommend an adversarial transition-matrix test** for any gap, pointing at
     `test/unit/wait.test.ts` › *"waitForConditions — state transition
     sequences"* as the template, and listing concrete sequences to add
     (out-of-order / interleaved / repeated / empty-then-refill).

7. **Check the build and package shape**
   ```
   npm run build && ls dist/src/
   ```
   Derive the expectation rather than hardcoding it — every `src/*.ts` should
   produce a `.js`, a `.d.ts` and source maps:
   ```
   for f in src/*.ts; do b=$(basename "$f" .ts); \
     for ext in js d.ts; do [ -f "dist/src/$b.$ext" ] || echo "MISSING dist/src/$b.$ext"; done; done
   ```
   Then verify the published file list:
   ```
   npm pack --dry-run
   ```
   Expect `bin/`, `dist/src/`, `README.md`, `CHANGELOG.md`, `LICENSE` — and
   nothing else. Any `src/*.ts`, `test/`, or config file in the tarball is a
   finding. (If `npm pack` errors on local npm cache permissions, say so and
   treat CI as authoritative.)

   Also confirm the binary is executable and self-describing:
   ```
   ./bin/pueue-wait-cond.js --version
   ```

## Report Format

- **Summary**: overall health — unit / E2E pass, lint clean, typecheck clean,
  coverage %, and whether the E2E daemon suite actually ran.
- **Test Results**: pass rates for `test:unit` and `test:e2e`, called out
  separately, with the daemon-suite count.
- **Coverage**: per-file table. Compare with the figure in
  `docs/requirements-summary.md`; flag regressions and any uncovered branch
  lacking a justifying comment.
- **Lint Issues**: grouped by rule.
- **Type Issues**: grouped by file.
- **Anti-Pattern Violations**: file + line, severity (high/medium/low), one-line
  fix each. Dependency creep and secret leakage are always high.
- **Behavioural / State-Transition Audit**: per stateful module — its states,
  whether the transition matrix is exercised, and any gap with the concrete
  adversarial sequences to add. **Required even when coverage is 100%.**
- **Build & Package Shape**: pass/fail per check from step 7.
- **Recommendations**: prioritised. File Hot Sheet tickets (`hs-task` for
  cleanups, `hs-bug` for real defects) for anything non-trivial.
