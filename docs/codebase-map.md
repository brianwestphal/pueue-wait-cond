# Codebase map

A synthesis doc for AI assistants starting a fresh session. Source code wins on
any conflict — fix this file when it drifts.

## What this is

`pueue-wait-cond` — a Node CLI that reimplements `pueue wait` on top of
`pueue status --json`, adding `--timeout`, `--until` and `--while`.

## Tree

```
.
├── bin/
│   └── pueue-wait-cond.js       # #! shim → dist/src/cli.js → main()
├── src/
│   ├── index.ts                 # public barrel (programmatic API)
│   ├── cli.ts                   # run() / main(): parse → wire → exit code
│   ├── args.ts                  # parseArgs, Options, help text, durations
│   ├── wait.ts                  # THE LOOP: poll → complete? → until? → while? → timeout?
│   ├── condition.ts             # resolving + running --until / --while scripts
│   ├── pueue.ts                 # execFile("pueue status --json") → Snapshot
│   ├── status.ts                # snapshot parsing + "has reached" status rules
│   ├── reporter.ts              # progress lines (pueue wait's format)
│   ├── json.ts                  # --json result / error objects
│   ├── exitCodes.ts             # the EXIT table
│   └── version.ts               # find package.json, read version
├── test/
│   ├── helpers/
│   │   ├── fakes.ts             # StringWriter, makeSnapshot, ScriptedClient, makeOptions
│   │   └── e2e.ts               # runCli(), writeScript(), TestDaemon
│   ├── unit/*.test.ts           # one file per src module (+ main.test.ts, index.test.ts)
│   └── e2e/
│       ├── cli.test.ts          # shipped binary vs a stub `pueue`
│       └── daemon.test.ts       # shipped binary vs a real, isolated `pueued`
├── docs/
│   ├── requirements/01..05-*.md # source of truth for behavior
│   ├── codebase-map.md          # this file
│   ├── requirements-summary.md
│   └── manual-test-plan.md
├── .github/
│   ├── workflows/ci.yml         # lint+typecheck · test matrix · coverage
│   ├── workflows/release.yml    # on v* tag: gates → npm publish (OIDC) → GH Release
│   └── scripts/install-pueue.sh # prebuilt pueue/pueued for the runner's platform
├── scripts/
│   ├── release.sh               # interactive release; --beta for a prerelease
│   └── release-beta-auto.sh     # non-interactive beta, for automation
├── CHANGELOG.md
├── package.json  tsconfig.json  tsconfig.build.json
├── eslint.config.js  .c8rc.json
└── README.md  LICENSE
```

## Entry points

| Path | Role |
| --- | --- |
| `bin/pueue-wait-cond.js` | The installed binary. Calls `main()`. |
| `src/cli.ts` → `main()` | Owns `process.*`: argv, streams, signals, `process.exitCode`. |
| `src/cli.ts` → `run()` | Pure-ish: takes argv + writers + an optional client factory, returns a number. **This is what tests drive.** |
| `src/index.ts` | Programmatic API surface. |

`run()` taking an injectable `createClient` is what makes the whole CLI testable
in-process without a daemon.

## Data model

There is no database. The one data structure is `Snapshot` (`src/status.ts`):

```ts
Snapshot { tasks: Map<number, TaskState>; groups: Map<string, {status, parallelTasks}> }
TaskState { id, group, label, command, kind, result, exitCode }
```

`kind` is the serde variant name (`Queued` | `Running` | `Done` | `Stashed` |
`Paused` | `Locked` | `Unknown`); `result` is the `Done` payload's variant
(`Success` | `Failed` | `Killed` | `DependencyFailed` | …); `exitCode` is set
only for `{"Failed": N}`.

`parseSnapshot()` flattens pueue's tagged enums (bare string *or* single-key
object) and is defensive about every field — see
[requirements/02-wait-semantics.md](requirements/02-wait-semantics.md) R2.2.

## Control flow

```
main()
 └─ run(argv, streams)
     ├─ parseCliArgs           → Options | help | version
     ├─ createPueueClient      → { fetchSnapshot() }
     ├─ waitForConditions      → WaitResolution (outcome + run meta)
     └─ outcomeToExitCode      → number
```

`waitForConditions` is the only stateful thing in the codebase. Each iteration:
fetch → report changes → completion? → until? → while? → timeout? → sleep.
Order matters and is justified in
[requirements/03-conditions.md](requirements/03-conditions.md) R3.2.

`WaitOutcome` is a tagged union: `reached | until | while | timeout |
unreachable | unknown-tasks | interrupted`. Adding a variant forces an update in
`outcomeToExitCode` (the switch is exhaustive over the union).

`waitForConditions` returns `WaitResolution = WaitOutcome & { meta: WaitMeta }`.
The run metadata (elapsed, iterations, tasks, pending/failed ids) is attached as
an **intersection** rather than folded into each variant, so `result.kind`
narrowing keeps working; `src/json.ts` reads `meta` to build the `--json`
object.

## Build

`tsc -p tsconfig.build.json` compiles `src/**` to `dist/` preserving the `src/`
subdirectory (hence `dist/src/cli.js`). Strict mode, `NodeNext` modules, ESM,
declarations + source maps. Node ≥ 20. No runtime dependencies.

## Tests

| Kind | Where | Runner | Notes |
| --- | --- | --- | --- |
| Unit | `test/unit/*.test.ts` | `node --import tsx --test` | Fakes only; no daemon, no network. |
| E2E (stub) | `test/e2e/cli.test.ts` | same, `--test-concurrency=1` | Spawns the real `bin/` against a **stub** `pueue` shell script for determinism. |
| E2E (real) | `test/e2e/daemon.test.ts` | same | Starts its **own** `pueued` in a temp dir (own socket + state). Skips if pueue is missing — unless `PWC_REQUIRE_PUEUE=1`, which makes that a failure. |

Coverage merges both suites into one report via `c8 --temp-directory
.tmp-coverage` (see `package.json` `coverage:*` scripts). Currently 99.76%
statements / 98.09% branches / 100% functions; the residue is unreachable
defensive guards.

**CI** (`.github/workflows/ci.yml`) runs gates (lint/typecheck/build) once, then
a 2×2 matrix of {ubuntu, macos} × Node {20, 22}, then a coverage job. pueue is
installed from prebuilt release binaries by `.github/scripts/install-pueue.sh`
(much faster than `cargo install`). Set **`PWC_REQUIRE_PUEUE=1`** — CI does — to
turn a missing pueue into a failure rather than a silent skip; without it a
botched install yields a green run in which the whole real-daemon suite did
nothing.

Shared fakes live in `test/helpers/fakes.ts` — **use them**:
`makeSnapshot([{id, status}])` builds a raw pueue payload and parses it through
the real parser; `ScriptedClient` walks a list of snapshots and throws if the
loop polls far past the script (a non-converging loop would otherwise spin
forever, because the tests inject a no-op `sleep`).

## Settings / configuration keys

No config file. Everything is flags plus environment variables read by the tool
itself (`PUEUE_BINARY`, and `NO_COLOR`/`FORCE_COLOR` for output) and one read by
the tests (`PWC_REQUIRE_PUEUE`). Condition
scripts additionally *receive* the `PUEUE_WAIT_*` variables listed in
[requirements/03-conditions.md](requirements/03-conditions.md) R3.4.

## Where do I look for X?

| X | Look in |
| --- | --- |
| A new CLI flag | `src/args.ts` (parse + `Options` + `helpText()`), then wire in `src/wait.ts` or `src/cli.ts` |
| "When does the wait stop?" | `src/wait.ts` `waitForConditions` |
| "Does status X satisfy target Y?" | `src/status.ts` `hasReached` / `isUnreachable` |
| pueue JSON shape handling | `src/status.ts` `parseSnapshot` / `unpackEnum` |
| Talking to the pueue binary | `src/pueue.ts` |
| What a condition script sees | `src/condition.ts` `conditionEnv`, `src/wait.ts` `snapshotForConditions` |
| Output wording / format | `src/reporter.ts` |
| Exit code meanings | `src/exitCodes.ts` + `outcomeToExitCode` in `src/wait.ts` |
| `--json` output shape | `src/json.ts` + [requirements/04](requirements/04-output-and-exit-codes.md) R4.7 |
| CI / installing pueue on a runner | `.github/workflows/ci.yml`, `.github/scripts/install-pueue.sh` |
| Starting a throwaway pueue daemon | `test/helpers/e2e.ts` `TestDaemon` |
| Manual-only checks | [manual-test-plan.md](manual-test-plan.md) |
| Cutting a release | `scripts/release.sh`, `.github/workflows/release.yml`, [requirements/05](requirements/05-packaging.md) R5.6 |

## Gotchas discovered the hard way

- **`pueue status --json` embeds every task's whole environment.** Payloads are
  megabytes on a busy daemon (hence the 64 MiB `maxBuffer`) and contain secrets
  (hence `snapshotForConditions` stripping them).
- **`pueue wait` exits `0` even when tasks fail.** We match that by default;
  `--fail-on-error` opts out.
- **pueue's config file is YAML**, at `~/Library/Application Support/pueue/pueue.yml`
  (macOS). `TestDaemon` writes its own with `shared.pueue_directory` pointed at a
  temp dir, which isolates socket *and* state.
- **Grepping the condition snapshot is ambiguous**: both tasks and groups have a
  `status` field, so `grep '"status": "Running"'` can match a group. Test
  fixtures use a non-`Running` group status to avoid false positives.
- **`/bin/sh` cannot reliably ignore SIGTERM** while blocked on a foreground
  child, so the SIGKILL-escalation test uses a Node process instead.
- **Unix sockets are blocked under the sandbox** in this environment; the
  real-daemon E2E suite needs to run unsandboxed.
