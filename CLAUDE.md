<!-- hotsheet:begin section=ticket-driven-work v=1 -->
## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the `hotsheet_*` MCP tools), mark Up Next, then work through them: set status `started` → implement → set `completed` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket `completed`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket `started`, add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), signal channel done, and wait. It's the only reliable way to surface a question.
<!-- hotsheet:end section=ticket-driven-work -->

## Git Workflow

- **Commit as you go.** When a coherent, reviewable unit of work is complete and
  its relevant checks pass, commit it before starting the next unit. Use a clear,
  scoped commit message and reference the Hot Sheet ticket when applicable.
- Commit only files belonging to that unit. Preserve unrelated user changes and
  never sweep them into a commit merely to obtain a clean working tree.
- Do not leave completed work uncommitted at handoff unless the user explicitly
  asks for an uncommitted diff. Never push without explicit permission.
- Use GitGist to draft commit messages and changelog/release notes. Run
  `npm run commit:msg` for the staged change, and let the release scripts call
  `gitgist <last-tag>..HEAD` for diff-grounded changelog text. Review and edit
  every generated draft before committing or publishing it.

## Language and Style

- Use American English in all repository-authored prose, including documentation, user-facing output, source comments, test names, commit messages, and workflow guidance. Prefer forms such as `behavior`, `color`, `normalize`, `serialize`, and `recognize`. Preserve another spelling only when an external API, command output, identifier, proper name, or verbatim quotation requires it.

<!-- hotsheet:begin section=testing-philosophy v=2 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Coverage is a floor, not a ceiling**: 100% line/branch coverage shows every line *ran*, not that every *behavior* — or every *sequence* of behaviors — is *asserted*. It is structurally blind to a **missing state transition**: a bug living in an untested interaction sails through a green 100% report because the individual lines still get hit by isolated, single-operation tests.
- **Transition-matrix testing for stateful modules**: for anything with modes / multiple code paths / a cache / a state machine, enumerate the states AND the transitions between them, then write tests that walk realistic multi-step sequences crossing state boundaries — not just each operation from a clean initial state.
- **Adversarial pass on stateful changes**: when adding or altering a stateful code path, deliberately try to break it with out-of-order / interleaved / repeated / empty-then-refill sequences; pin any that would have failed as permanent regression tests.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup
- **Unit tests** (`test/unit/*.test.ts`): Node's built-in runner (`node --import tsx --test`) with `node:assert/strict`. Always use the shared fakes in `test/helpers/fakes.ts` — `makeSnapshot()` (builds a raw `pueue status --json` payload and parses it through the real parser), `ScriptedClient` (walks a list of snapshots; throws if the wait loop polls far past the script, since tests inject a no-op `sleep` and a non-converging loop would otherwise spin forever), `makeOptions()`, `makeReporter()`, `StringWriter`, `fakeSleep()`.
- **E2E tests** (`test/e2e/*.test.ts`): same runner, `--test-concurrency=1`, driving the **shipped** `bin/pueue-wait-cond.js` as a child process via `runCli()` in `test/helpers/e2e.ts`. Two flavors: `cli.test.ts` against a **stub** `pueue` shell script (deterministic exit codes/output), and `daemon.test.ts` against a **real** `pueued` that `TestDaemon` starts in a temp dir with its own socket and state — never the developer's daemon. They skip if `pueue`/`pueued` aren't installed. Note: unix sockets are blocked under the command sandbox, so the real-daemon suite must run unsandboxed.
- **Commands**: unit `npm run test:unit` · E2E `npm run test:e2e` (builds first) · both `npm test` · merged coverage `npm run coverage` (c8, shared `--temp-directory .tmp-coverage`, report in `coverage/`) · also `npm run lint` and `npm run typecheck`.
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout
- **Requirements docs** live in `docs/requirements/`, named `NN-kebab-area.md` (`01-cli-surface.md`, `02-wait-semantics.md`, `03-conditions.md`, `04-output-and-exit-codes.md`, `05-packaging.md`). Each opens with a `Status:` line and cross-links its siblings with relative links. Individual requirements are numbered `RN.M` so the summary and tests can cite them.
- **Codebase map**: `docs/codebase-map.md`.
- **Requirements summary**: `docs/requirements-summary.md` (per-doc *and* per-`RN.M` status tables, plus a "Known gaps / follow-ups" section mirrored by Hot Sheet tickets).
- **Manual test plan**: `docs/manual-test-plan.md`.
- **User-facing docs**: `README.md` is the published front door — keep its option tables and exit-code table in sync with `docs/requirements/` and with `helpText()` in `src/args.ts`. Those three drift easily; changing a flag means changing all three.
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->
