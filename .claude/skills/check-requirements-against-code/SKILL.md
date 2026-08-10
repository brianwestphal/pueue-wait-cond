---
name: check-requirements-against-code
description: Check requirements docs against implementation and report discrepancies
allowed-tools: Read, Grep, Glob, Bash, Agent, Edit, Write
---

Comprehensively compare the requirements documents under `docs/requirements/`
against the actual implementation. Also verify that the two AI synthesis docs
(`docs/codebase-map.md`, `docs/requirements-summary.md`), the manual test plan,
`README.md` and `CLAUDE.md` are in sync with both the requirements docs and the
code. Generate a report with recommendations and questions about any
discrepancies.

## Steps

1. **Read all requirements documents.** Enumerate them from disk rather than from
   a range written here — the set grows, and a hardcoded bound silently stops
   covering whatever was added last:
   ```
   ls docs/requirements/
   ```
   It was `01`–`05` when this skill was written. Requirements are numbered
   `RN.M` (and `RN.M.K`) so they can be cited; note every stated requirement,
   behaviour and constraint.

2. **For each requirement, verify it against the implementation.** Everything
   lives under `src/`. Note differences, missing features, and extra features not
   in the docs. The requirement-to-code map is roughly:

   | Doc | Mostly implemented in |
   | --- | --- |
   | 01 CLI surface | `src/args.ts` |
   | 02 Wait semantics | `src/wait.ts`, `src/status.ts`, `src/pueue.ts` |
   | 03 Conditions | `src/condition.ts`, `snapshotForConditions` in `src/wait.ts` |
   | 04 Output & exit codes | `src/reporter.ts`, `src/exitCodes.ts`, `src/json.ts` |
   | 05 Packaging | `package.json`, `scripts/`, `.github/workflows/` |

3. **Check the three-way flag contract.** `CLAUDE.md` names this as the drift
   most likely to happen here: every option exists in **three** places, and
   changing one without the others is the classic failure.
   ```
   node -e "process.stdout.write(require('./dist/src/args.js').helpText())" 2>/dev/null \
     || node --import tsx -e "import('./src/args.ts').then(m=>process.stdout.write(m.helpText()))"
   ```
   Cross-check the option list against `README.md`'s tables and the
   `docs/requirements/01-cli-surface.md` R1.2/R1.3 tables. Report any option
   present in one and missing from another, and any default that disagrees.

4. **Check the exit-code contract.** `src/exitCodes.ts` is the source of truth.
   Verify the table in `docs/requirements/04-output-and-exit-codes.md` R4.1,
   the `README.md` exit-code table, and the `Exit codes:` block in `helpText()`
   all list the same codes with the same meanings.

5. **Check for undocumented behaviour.** Scan `src/` for observable behaviour not
   covered by any requirement — a new flag, a new exit code, a new environment
   variable, a new field in the `--json` object or the condition snapshot. These
   should either be specified in `docs/requirements/` or questioned.

6. **Check for stale documentation.** Requirements describing behaviour that no
   longer exists. Pay attention to anything marked **Partial** or **Design only**
   in the summary that has since shipped, and to behaviour that changed
   deliberately (e.g. unknown task ids used to wait forever; they now honour
   `--task-grace`).

7. **Verify `CLAUDE.md` completeness.** Its two "This project's …" blocks are the
   onboarding contract:
   - The **test setup** block lists the real runners, globs, helper names and
     commands. Cross-check against `package.json` scripts and `ls test/helpers/`.
   - The **docs layout** block names `docs/requirements/NN-*.md`, the codebase
     map, the requirements summary and the manual test plan. Confirm each path
     exists.
   - Any `npm run` script that a contributor is expected to use should appear
     somewhere in `CLAUDE.md` or `README.md`.

8. **Synchronize `docs/codebase-map.md`.** Open it and confirm each section still
   matches the codebase. Flag inaccuracies, then **update the file in place** —
   do not just report. Check specifically:
   - **Directory tree** matches actual files under `src/`, `test/`, `docs/`,
     `scripts/`, `.github/` and the repo root (use `Glob`/`ls` to verify). New
     `src/*.ts` files going unlisted is the most common drift.
   - **Entry points** and **Control flow** still describe the real shape —
     including the return type of `waitForConditions` and the full
     `WaitOutcome` union.
   - **Data model** matches `src/status.ts`.
   - **Tests table** matches the real suites and their skip behaviour.
   - **Settings / configuration keys** lists every environment variable actually
     read (`PUEUE_BINARY`, `NO_COLOR`, `FORCE_COLOR`, `PWC_REQUIRE_PUEUE`) plus
     the `PUEUE_WAIT_*` set conditions receive.
   - **"Where do I look for X"** entries point at files that exist and contain
     what is claimed.
   - **"Gotchas discovered the hard way"** — verify each is still true, and add
     any hard-won fact learned since.

9. **Synchronize `docs/requirements-summary.md`.** Open it and confirm each entry
   matches its source doc. Flag and **update in place**:
   - The **Documents** table row per doc, with current status.
   - The **per-requirement** tables — every `RN.M` on disk should have a row, and
     every row should exist on disk.
   - The **Test coverage** paragraph — re-run `npm run coverage` and correct the
     figures if they have moved.
   - The **Known gaps / follow-ups** list — remove anything now shipped, and
     check each remaining item still has a live Hot Sheet ticket.

10. **Synchronize `docs/manual-test-plan.md`.** Anything now covered by an
    automated test must move out of the numbered checks and into the **Automated
    Coverage Summary** table, per `CLAUDE.md`. Verify each remaining manual item
    genuinely cannot be automated.

11. **Final consistency pass.** Make sure `CLAUDE.md`, `README.md`,
    `CHANGELOG.md`, `docs/codebase-map.md`, `docs/requirements-summary.md` and
    `docs/manual-test-plan.md` agree with each other and with the requirements
    docs and code. Resolve any disagreement in favour of the code and the source
    doc, then update the summaries.

    **The most common drift in this project is a new CLI flag reaching
    `src/args.ts` and the README but not the requirements doc or the summary
    tables — or shipping with the option label in `helpText()` written one way
    and the README another.** Look for that pattern explicitly.

## Report Format

### Discrepancies Found

For each:
- **Requirement**: doc, `RN.M`, and the stated requirement
- **Implementation**: what the code does (file path, line numbers)
- **Type**: `missing` | `different` | `undocumented` | `stale`
- **Recommendation**: update the doc, or fix the code?

For doc-vs-doc drift, recommend updating both to match the canonical source —
`src/args.ts` for the option list, `src/exitCodes.ts` for exit codes, the
numbered requirement docs for behaviour, `package.json` for scripts and
packaging.

### Contract Audits

- **Flags**: options in `helpText()` vs `README.md` vs `docs/requirements/01-cli-surface.md`
- **Exit codes**: `src/exitCodes.ts` vs R4.1 vs `README.md` vs `helpText()`
- **Environment variables**: those actually read in `src/` vs those documented
- **`CLAUDE.md`**: test-setup and docs-layout blocks vs reality

### Doc Synchronization

- **`docs/codebase-map.md`** — sections edited and why (or "no changes needed")
- **`docs/requirements-summary.md`** — entries edited and why
- **`docs/manual-test-plan.md`** — items promoted to automated, if any
- **`README.md`** / **`CHANGELOG.md`** — changes made

### Questions

List ambiguous requirements where the implementation had to make a judgment
call, and ask whether the current behaviour is correct.

### Summary

- Total requirements checked
- Requirements fully implemented
- Discrepancies by type
- Documentation gaps
- Files edited
