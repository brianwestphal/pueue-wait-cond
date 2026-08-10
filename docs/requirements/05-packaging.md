# Requirements: packaging and distribution

Status: **Shipped** (not yet published to npm — see
[requirements-summary.md](../requirements-summary.md))

Related: [01-cli-surface.md](01-cli-surface.md)

## R5.1 — Package

Published to npm as **`pueue-wait-cond`**, MIT licensed, ESM
(`"type": "module"`), exposing one binary of the same name.

The name was kept from the original brief: it is descriptive, sorts next to
`pueue` in a search, and says exactly what it adds. Alternatives considered and
rejected: `pwait` (collides conceptually with `pueue wait`, and `pw*` is a
crowded prefix), `pueue-until` (undersells `--while` and `--timeout`).

## R5.2 — Runtime requirements

- **Node.js ≥ 20** — for a stable `util.parseArgs` and `node --test`.
- **Zero runtime dependencies.** Everything used at run time is a Node built-in.
  A wait utility sitting in the middle of someone's CI should not drag a
  dependency tree behind it.
- A `pueue` binary, found via `--pueue-binary`, `$PUEUE_BINARY`, or `$PATH`.

## R5.2.1 — Supported platforms: macOS and Linux only

`package.json` declares `"os": ["darwin", "linux"]`. **Windows is deliberately
not supported**, and that is a product decision, not an oversight.

Two things bake POSIX in:

1. `--shell` defaults to `/bin/sh`. Every inline condition and every
   non-executable script goes through it, and that path does not exist on
   Windows — conditions would fail with exit `6`.
2. Signal handling: `main()` traps SIGINT/SIGTERM and `runCondition` escalates
   SIGTERM → SIGKILL. Windows semantics differ.

The `os` field makes `npm install` fail up front with `EBADPLATFORM` rather than
letting the tool install cleanly and then misbehave at the first condition. A
loud install-time failure is the honest outcome for a platform nobody is
testing.

Reopening this would mean shelling to `cmd.exe`/PowerShell, changing the `-c`
flag, and replacing `resolveCommand`'s executable-bit check with something
meaningful on Windows — see the closed Hot Sheet ticket HS-6.

## R5.3 — Published contents

`files` ships `bin/`, `dist/src/`, `README.md` and `LICENSE` — sources, tests
and configs stay out of the tarball. `prepack` runs the build, so publishing
cannot ship stale output.

## R5.4 — Programmatic use

The package also exports its internals from `src/index.ts` (typed, with
declaration files) so the wait loop can be driven from Node directly. The CLI
remains the primary interface; the barrel is a convenience and is covered by a
test that fails if an export disappears.

## R5.5 — Build and checks

| Task | Command |
| --- | --- |
| Build | `npm run build` (`tsc` → `dist/`) |
| Type-check (incl. tests) | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit tests | `npm run test:unit` |
| E2E tests | `npm run test:e2e` (builds first) |
| Merged coverage | `npm run coverage` |

TypeScript runs in strict mode with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`.

## R5.6 — Releasing

Three entry points, modelled on the same scripts in `~/Documents/{kerf,news}`:

| Command | Effect |
| --- | --- |
| `npm run release` | Interactive stable release → tag `v{version}` |
| `npm run release:beta` | Same, but tag `v{version}-beta.N` |
| `npm run release:beta:auto` | Non-interactive beta, for automation |

The flow is: preflight → release notes → version → summary/confirm → write
version + `CHANGELOG.md` → gates → commit → annotated tag → push.

**The tag is the trigger.** No script publishes. Pushing `v*` starts
`.github/workflows/release.yml`, which re-runs the gates, refuses a tag whose
version disagrees with `package.json`, publishes to npm under `latest` or `beta`
depending on the tag shape, and opens a GitHub Release using the annotated tag's
message as the body. The local gates are a fast fail, not the authority.

### R5.6.4 — Publishing is via npm trusted publishing (OIDC)

There is **no npm token anywhere** — no `NPM_TOKEN` secret, no `NODE_AUTH_TOKEN`.
npm authenticates the publish from a short-lived OIDC token minted by GitHub.

Three things have to agree, and a mismatch fails the publish *after* the tag has
already been pushed:

| Where | Value |
| --- | --- |
| npmjs.com → package → trusted publisher | repo `brianwestphal/pueue-wait-cond`, workflow `release.yml`, environment `npm-publish` |
| `release.yml` job | `environment: npm-publish` |
| `release.yml` permissions | `id-token: write` |

So: renaming the workflow file, renaming the job's environment, or dropping
`id-token: write` all break releases, and none of them look like they would.

**The runner's bundled npm is too old.** Trusted publishing landed in npm
**11.5.0**, and 11.5.1 fixed provenance defaulting for it; Node 22 bundles npm
10.9.x and Node 20 bundles 10.8.x. The workflow therefore installs
`npm@^11.5.1` explicitly before publishing. Without that step every gate passes
and the publish fails at the very end.

Provenance is automatic under trusted publishing. `--provenance` is still passed
explicitly, as documentation of intent rather than because it is required.

The `npm-publish` GitHub environment currently has **no protection rules**, so a
pushed tag releases without further approval. Adding a required reviewer there
would turn the tag push into a request rather than a release.

### R5.6.1 — Resumability

`scripts/release.sh` records progress in `.release-state.json` (gitignored), so
an abort part-way through resumes rather than re-asking. Steps are numbered and
each is skipped when already past.

### R5.6.2 — Why `release:beta:auto` is a separate script

`release.sh` is a state machine with several `read`-driven branches whose
correct answers depend on the saved state, so piping answers into it is brittle.
`scripts/release-beta-auto.sh` re-implements only the beta path, and is stricter
where a human is not present to judge: a dirty tree or a non-main branch is a
hard failure rather than a prompt.

It accepts `--version X.Y.Z` (or a bare positional), `--notes FILE` /
`--notes-stdin`, `--skip-gates`, and `--dry-run`.

### R5.6.3 — Beta numbering

The `-beta.N` suffix is chosen by scanning existing tags for the first free `N`,
so re-running after a failed push does not collide. The suffix lives on the
**tag**; `package.json` always carries the clean `X.Y.Z`.
