---
name: technical-changelog
description: Generate a diff-grounded, one-page technical changelog for a release — from the actual code changes between the last production tag and HEAD (the next, still-unreleased version). Asks for the next version number when it cannot be inferred.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

Produce a **one-page technical report** of what changed for a release, stored in
`docs/technical-changelog/<base>-<next>.md`. The report must be grounded in the
**real diff** — added/modified/removed code, export/dependency deltas, measured
test and coverage figures — **not** commit messages, `CHANGELOG.md`, or the
requirements docs. Those describe the *end state* and the *whole* feature
history, so they routinely credit a range with work that predates it, or
describe posture that was already true. Every claim is a verified delta between
the base tag and HEAD.

> kerf's version of this skill calls a `scripts/changelog-analysis.mjs` helper.
> This project is small enough that the deterministic git work is inlined below
> instead — there is no script to keep in sync.

## The two facts that make this skill necessary

1. **HEAD may be the next, unreleased version.** Unlike kerf, this repo's
   `package.json` is bumped *by the release script* before tagging, so it often
   already holds the upcoming number. **Check whether `v<package.json version>`
   is already tagged**: if it is, `package.json` is the *last released* version
   and you must ask for the next one; if it is not, `package.json` IS the
   upcoming release and you can use it — say which case you hit.
2. **The base is the most recent production tag**, and the range is
   `<base>..HEAD`. Pre-release tags (`-beta.N`) are never the base. If the repo
   has no production tag yet, the base is the root commit — say so explicitly,
   because then "everything is new" and the report should be framed as an
   initial-release summary.

## Steps

1. **Establish the version and the base.**
   ```bash
   pkg=$(node -p "require('./package.json').version")
   if git rev-parse "v$pkg" >/dev/null 2>&1; then
     echo "v$pkg is already tagged -> ASK the user for the next version"
   else
     echo "package.json ($pkg) is the upcoming release"
   fi
   base=$(git describe --tags --abbrev=0 --match 'v*' --exclude='*-beta.*' 2>/dev/null \
          || git rev-list --max-parents=0 HEAD)
   echo "base=$base  range=${base}..HEAD  commits=$(git rev-list --count ${base}..HEAD)"
   ```
   If the first branch prints, ask with `AskUserQuestion`: *"What's the next
   planned release version for this changelog?"* Do not guess.

2. **Bucket the line delta by area.** The raw total is inflated by docs and agent
   scaffolding, so never present it as engineering effort:
   ```bash
   for area in src test bin scripts .github docs .claude .agents .gemini .hotsheet; do
     printf '%-12s %s\n' "$area" \
       "$(git diff --shortstat "${base}..HEAD" -- "$area" 2>/dev/null || echo '-')"
   done
   echo "--- product only (src bin scripts .github) ---"
   git diff --shortstat "${base}..HEAD" -- src bin scripts .github
   echo "--- root files ---"
   git diff --stat "${base}..HEAD" -- ':(top)*.json' ':(top)*.md' ':(top)*.js'
   ```

3. **List added and removed files** — the honest signal for "new subsystem":
   ```bash
   git diff --diff-filter=A --name-only "${base}..HEAD"
   git diff --diff-filter=D --name-only "${base}..HEAD"
   ```

4. **Extract the public-surface deltas.** For this package that means the barrel,
   the CLI options, the exit codes, and the dependency invariant:
   ```bash
   git diff "${base}..HEAD" -- src/index.ts        # programmatic API
   git diff "${base}..HEAD" -- src/exitCodes.ts    # exit-code contract
   git diff "${base}..HEAD" -- src/args.ts | grep -E '^[+-].*(--[a-z-]+|short:)' | head -40
   git diff "${base}..HEAD" -- package.json | grep -E '^[+-]' | grep -viE 'version|lock'
   ```
   The dependency line matters here more than most projects: **zero runtime
   dependencies** is a documented invariant (R5.2), so any change to
   `dependencies` is headline material.

5. **Read the real diffs — do not stop at the summaries.** The commands above say
   *where* to look; the narrative comes from the changes themselves:
   ```bash
   git diff "${base}..HEAD" -- <path>
   ```
   And **verify every "new" claim against the base tree** rather than trusting a
   commit subject:
   ```bash
   git cat-file -e "${base}:<file>"                  # non-zero exit -> genuinely new
   git show "${base}:<file>" | grep -c '<symbol>'    # 0 -> added in range
   git ls-tree -r --name-only "$base" -- src/
   ```
   Classic traps: a module that looks new but existed at the base; a feature added
   **and removed within the same range** (nets to zero — say so); posture like
   "zero dependencies" or "macOS and Linux only" that was **already true** at the
   base (baseline, not a change); a default that changed in two hops (report the
   full base→HEAD delta).

6. **Measure — never quote.** Any number that is not a line delta comes from a
   real run:
   ```bash
   npm run test:unit 2>&1 | tail -5
   PWC_REQUIRE_PUEUE=1 npm run test:e2e 2>&1 | tail -5
   npm run coverage 2>&1 | tail -15
   npm run build && npm pack --dry-run 2>&1 | grep -E 'package size|unpacked size|total files'
   ```

7. **Write the report** to `docs/technical-changelog/<base>-<next>.md`. Keep it to
   roughly one page:
   - **Header** — the range, commit count, and whether HEAD is untagged (so the
     "next" number is a label). State that it is derived from the diff, not from
     commit prose.
   - **Honest size** — the area split, with a **product-only** total called out
     separately from the raw total. Name the biggest bucket. Docs and the
     `.claude`/`.agents`/`.gemini`/`.hotsheet` scaffolding are explicitly labelled
     non-engineering.
   - **Baseline note** — one line on what already shipped at the base, so nothing
     pre-existing reads as new.
   - **Per-change sections** for the genuine deltas, each carrying its diff
     evidence (new files, the option/exit-code delta, `0 hits → present` for
     behaviour, measured test counts). Order by significance: a new CLI flag or
     exit code before a doc sync.
   - **Contract changes** — a dedicated section whenever exit codes, CLI options,
     the `--json` shape, or the condition environment changed. Those are the
     things downstream scripts break on, and they deserve to be findable.
   - **Mermaid diagrams** when they earn their place (a new subsystem, a changed
     decision order), not gratuitously. Use `<br/>` for line breaks in node
     labels, and quote labels containing spaces or punctuation.

8. **Validate and finish.**
   - Sanity-check any mermaid block (balanced brackets and quotes, standard
     `flowchart` / `sequenceDiagram` syntax).
   - Re-read the draft against your `git show <base>:…` probes: is **every** claim
     a real delta? Cut or re-label anything that describes the baseline.
   - Committing is optional and follows the repo's git rules. **Never `git push`
     without explicit permission.**

## Guardrails

- **Diff over prose.** If a claim is not backed by a file or line change you
  actually read, do not make it. Commit subjects, `CHANGELOG.md` and `docs/` are
  leads to verify, not sources to quote.
- **Never inflate.** Lead with product-only line counts; label docs and agent
  scaffolding as non-engineering.
- **Attribute to the range only.** When unsure whether something is new, run the
  `git cat-file -e <base>:<file>` probe before writing it up.
