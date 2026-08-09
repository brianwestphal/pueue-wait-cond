# Requirements summary

A synthesized view of every requirements doc, with status. Update this in the
same change that ships, defers or regresses a requirement.

Status markers: **Shipped** · **Partial** · **Design only** · **Deferred**

## Documents

| Doc | Area | Status |
| --- | --- | --- |
| [01-cli-surface.md](requirements/01-cli-surface.md) | Flags, parsing, usage errors | **Shipped** |
| [02-wait-semantics.md](requirements/02-wait-semantics.md) | Polling, selection, status matching | **Shipped** |
| [03-conditions.md](requirements/03-conditions.md) | `--until` / `--while` | **Shipped** |
| [04-output-and-exit-codes.md](requirements/04-output-and-exit-codes.md) | Streams, format, exit codes | **Shipped** |
| [05-packaging.md](requirements/05-packaging.md) | npm package, build, checks | **Partial** — built and packable, **not published** |

## By requirement

### 01 — CLI surface

| Req | Summary | Status |
| --- | --- | --- |
| R1.1 | `pueue-wait-cond [TASK_IDS]... [OPTIONS]` | Shipped |
| R1.2 | `pueue wait` parity: ids, `-g`, `-a`, `-q`, `-s`, `-h` | Shipped |
| R1.3 | Added: `--timeout`, `--until`, `--while`, `--interval`, `--condition-timeout`, `--fail-on-error`, `--pueue-binary`, `--config`, `--profile`, `--shell`, `-V` | Shipped |
| R1.4 | Durations: bare seconds + `ms`/`s`/`m`/`h` | Shipped |
| R1.5 | 8 `--status` values (superset of pueue's) | Shipped |
| R1.6 | Usage errors → stderr, exit `2` | Shipped |

### 02 — Wait semantics

| Req | Summary | Status |
| --- | --- | --- |
| R2.1 | State from `pueue status --json`; `--config`/`--profile` forwarded | Shipped |
| R2.2 | Tagged-enum normalisation, defensive parsing | Shipped |
| R2.3 | Selection recomputed every poll (picks up late tasks) | Shipped |
| R2.4 | "Has reached" ordering; off-line states matched exactly | Shipped |
| R2.5 | Unreachable `success`/`failed` targets exit `1` promptly | Shipped |
| R2.6 | Unknown ids warn once and keep waiting | Shipped |
| R2.7 | Empty group/all selection completes; empty id selection does not | Shipped |
| R2.8 | Never sleeps past the deadline | Shipped |
| R2.9 | SIGINT/SIGTERM → exit `130`, wakes out of a sleep | Shipped |

### 03 — Conditions

| Req | Summary | Status |
| --- | --- | --- |
| R3.1 | Exit `0` = passes; `--until` any-passes, `--while` any-fails | Shipped |
| R3.2 | Decision order: complete → until → while → timeout | Shipped |
| R3.3 | File (exec / via shell) vs inline shell command | Shipped |
| R3.3.1 | Inline commands are full `sh -c` commands (pipelines, `&&`, `$(...)`, multi-line) | Shipped |
| R3.3.2 | Documented footguns: single-quote requirement, existing-file shadowing | Shipped |
| R3.4 | stdin JSON + `$PUEUE_WAIT_STATUS_JSON` + `PUEUE_WAIT_*` env | Shipped |
| R3.5 | Snapshot contents; **no** `envs` leak | Shipped |
| R3.6 | Unrunnable condition → exit `6`, never "false" | Shipped |
| R3.7 | `--condition-timeout` → SIGTERM then SIGKILL | Shipped |
| R3.8 | Condition output → wait's stderr, prefixed; EPIPE ignored | Shipped |

### 04 — Output and exit codes

| Req | Summary | Status |
| --- | --- | --- |
| R4.1 | Exit code table (0,1,2,3,4,5,6,130) | Shipped |
| R4.2 | Task failure does not fail the wait by default | Shipped |
| R4.3 | `pueue wait`-compatible progress lines on stdout | Shipped |
| R4.4 | Extra lines for conditions, timeout, completion; already-finished tasks still reported | Shipped |
| R4.5 | Stream discipline (stdout progress / stderr diagnostics) | Shipped |
| R4.6 | TTY colour, `NO_COLOR` > `FORCE_COLOR` | Shipped |

### 05 — Packaging

| Req | Summary | Status |
| --- | --- | --- |
| R5.1 | npm package `pueue-wait-cond`, MIT, ESM, one binary | **Partial** — the package is complete and packable, but has **never been published**, and the name's availability on the npm registry has not been verified |
| R5.2 | Node ≥ 20, zero runtime deps | Shipped |
| R5.3 | `files` allowlist + `prepack` build | Shipped |
| R5.4 | Typed programmatic API via `src/index.ts` | Shipped |
| R5.5 | build / typecheck / lint / test / coverage scripts | Shipped |

## Test coverage

Merged unit + E2E: **~99.7% statements, ~98% branches, 100% functions**. The
uncovered residue is defensive guards that cannot be reached through the public
surface (rethrow arms for errors the callee never raises, a best-effort temp-dir
cleanup `catch`).

Every requirement above has both unit and E2E coverage, except:

- **R2.9 (signals)** — covered by unit tests (in-process `process.emit`) and E2E
  against the stub daemon, but not against a real `pueued`.
- **R4.6 (colour)** — unit tested; the E2E runs force `NO_COLOR`.

## Known gaps / follow-ups

Tracked as Hot Sheet tickets:

- Not published to npm; registry name availability unverified.
- No CI workflow.
- No `--json` machine-readable result output.
- No option to fail fast on an unknown task id (today: warn and keep waiting).
- Windows is unsupported and untested (`/bin/sh` default, POSIX signals).
