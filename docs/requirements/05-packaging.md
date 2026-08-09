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
