---
name: prep-major-release
description: Prepare pueue-wait-cond for a major release — refresh the README so it stays compelling and current, re-verify the terminal transcripts it advertises, and hand the maintainer a precise list of the manual checks that need a human.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent
---

# prep-major-release — get pueue-wait-cond ready to ship

A lot changes between major releases. This skill does the release-prep jobs that
are easy to forget and need human taste or human hands: **(1)** make `README.md`
compelling and accurate again, **(2)** re-verify every terminal transcript the
README shows, and **(3)** hand the maintainer a precise list of which manual
checks to run.

> **Adapted from kerf's version.** kerf's Part 2 reviews animated demo captures
> under `site/`; this project has no site and no screenshots. Its marketing
> surface is **terminal output** and its human-only surface is the **manual test
> plan**, so those take that slot. The shape — "do the taste-driven parts, then
> hand off precisely" — is the durable bit.

Work the parts in order. Don't run the manual checks yourself — that's the
maintainer's step (Part 3). When you finish, leave a clear handoff.

## Ground yourself first

Before touching anything, build an accurate picture of what actually changed:

1. **What shipped** — read `CHANGELOG.md` and, if the range is large, run
   `/technical-changelog` first; its diff-grounded report is a far better basis
   than commit prose.
2. **Current surface** — the CLI options in `helpText()` (`src/args.ts`), the exit
   codes in `src/exitCodes.ts`, the `--json` shape in `src/json.ts`, and the
   `PUEUE_WAIT_*` environment in `src/condition.ts`. Every README claim must match
   these, not the other way round.
3. **The pitch** — re-read `docs/requirements/01-cli-surface.md` (what the tool is
   for) and the current `README.md` end to end, so edits stay in its voice.
4. **The numbers** — test counts and coverage come from a real run
   (`npm run test:unit`, `PWC_REQUIRE_PUEUE=1 npm run test:e2e`,
   `npm run coverage`), never from a doc. `docs/requirements-summary.md` records
   the last measured figures; treat them as a lead to re-verify, not a source.

## Part 1 — README

Make `README.md` compelling, accurate and current. For a CLI the README *is* the
product page; treat it like a landing page, not a changelog.

Review and update as needed:

- **The hook** — the one-line pitch and the opening `console` block. Is the
  premise still true (*`pueue wait`, plus timeouts and script conditions*)? Is the
  opening example the clearest possible ten-line taste?
- **"Why"** — does the option-table ordering still lead with the most useful
  things? Promote anything that became a headline since the last major (`--json`,
  `--task-grace`); demote what is now routine.
- **Installing pueue** — still the correct install routes? Re-check against
  upstream rather than trusting the section: pueue's README for the routes, the
  repology link for distro coverage, `brew info pueue` for the macOS caveats.
- **Option tables** — every flag in `helpText()` appears, with the same default,
  and nothing appears that no longer exists. This is the project's most common
  drift; `/check-requirements-against-code` audits it properly.
- **Exit-code table** — matches `src/exitCodes.ts` exactly.
- **JSON output** — the sample object matches what `src/json.ts` actually emits,
  key for key. Regenerate it from a real run rather than hand-editing.
- **"Differences from `pueue wait`"** — still honest and complete? A new flag that
  diverges from pueue belongs here.
- **Links** — every link resolves, including the pueue upstream ones and the
  in-repo `docs/` links.

Keep the established voice: direct, concrete, a little dry. American English
throughout. **Never put a `PWC-NN` ticket marker in the README** — it is a
published surface and readers have no Hot Sheet. Write self-contained prose.

When a README change touches a behaviour claim, make sure the corresponding
`docs/requirements/` page and the two summary docs still agree. Flag drift you
cannot fix in scope as a follow-up ticket rather than fixing it silently.

## Part 2 — Terminal transcripts

The README's `console` blocks are this project's screenshots, and they go stale
exactly like screenshots do: an output-format change in `src/reporter.ts` or a new
progress line silently invalidates them.

For **every** `console`/`sh` block in `README.md` that shows output:

1. Reproduce it for real. Use a throwaway group so the developer's own daemon is
   untouched, and clean up afterwards:
   ```bash
   pueue group add pwc-doccheck && pueue parallel 4 -g pwc-doccheck
   pueue add -g pwc-doccheck -- 'sleep 2'
   node bin/pueue-wait-cond.js -g pwc-doccheck --interval 0.5
   # …
   pueue kill -g pwc-doccheck; sleep 1; pueue start -g pwc-doccheck
   pueue clean -g pwc-doccheck; pueue group remove pwc-doccheck
   ```
   Prefer a fully isolated daemon (the pattern in `test/helpers/e2e.ts`
   `TestDaemon`) if you need determinism.
2. Compare character-for-character: timestamps aside, the wording, the ordering
   and the exit codes must match. Update the README to what actually happens —
   never the reverse.
3. Re-run `node bin/pueue-wait-cond.js --help` and confirm the README's option
   tables still describe the same flags and defaults.

Report every transcript you corrected, and flag any that could not be reproduced
(that is usually a real bug, not a doc bug).

## Part 3 — Manual test plan handoff

`docs/manual-test-plan.md` exists because some things cannot be automated. A
major release is when they actually matter.

1. **Re-read the plan** and check each item is still relevant — anything now
   covered by an automated test should move to the **Automated Coverage Summary**
   table rather than staying on the maintainer's list.
2. **Work out which items this release actually needs.** Do not hand over the
   whole list by default; select by what changed:
   - touched `src/reporter.ts` or any output → **M1** (colour), **M4** (narrow
     terminal), and Part 2 above
   - touched signal handling or `src/cli.ts` `main()` → **M2** (Ctrl-C)
   - touched `src/pueue.ts` or buffering → **M3** (very large daemon state)
   - touched conditions or the wait loop → **M5** (real long-running scenario)
   - touched `package.json` `os`/`engines` → **M6** (cross-platform refusal;
     needs a real Windows box, and `npm install --os=win32` does **not** simulate
     it)
   - always, before publishing → **M7** (`npm pack --dry-run`)
3. **Hand over a numbered checklist** with, for each item, why this release needs
   it and what specifically to watch for.

## Handoff

Finish with a short, scannable handoff:

- **README** — what changed, and any claim you could not verify.
- **Transcripts** — which were re-verified, which were corrected, which failed to
  reproduce (and whether that looks like a bug).
- **Manual checks** — the numbered subset the maintainer needs to run, with the
  reason for each.
- **Follow-ups** — Hot Sheet tickets filed for anything out of scope.
- **Release route** — remind the maintainer the release itself is
  `npm run release` (see `docs/requirements/05-packaging.md` R5.6); this skill
  prepares, it does not publish, and it never pushes.
