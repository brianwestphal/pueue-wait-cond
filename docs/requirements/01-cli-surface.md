# Requirements: CLI surface

Status: **Shipped**

Related: [02-wait-semantics.md](02-wait-semantics.md) ·
[03-conditions.md](03-conditions.md) · [04-output-and-exit-codes.md](04-output-and-exit-codes.md)

## Purpose

`pueue-wait-cond` is a drop-in superset of `pueue wait`. Anyone who knows
`pueue wait` must be able to use it without reading anything, and get timeouts
and conditions on top.

## R1.1 — Invocation

The binary is `pueue-wait-cond`, installed from the npm package of the same
name, and is callable as:

```
pueue-wait-cond [TASK_IDS]... [OPTIONS]
```

Options may appear before or after the positional task ids.

## R1.2 — pueue wait parity options

These behave as they do in `pueue wait`:

| Option | Requirement |
| --- | --- |
| `[TASK_IDS]...` | Wait for the named tasks. Ids are non-negative integers; duplicates collapse. |
| `-g, --group <GROUP>` | Wait for every task in the group. |
| `-a, --all` | Wait for every task in every group. |
| `-q, --quiet` | Emit no progress output on stdout. |
| `-s, --status <STATUS>` | Wait for the tasks to reach a status. Default `done`. |
| `-h, --help` | Print usage and exit `0`. |

Task ids, `--group` and `--all` are **mutually exclusive**; supplying more than
one is a usage error. Supplying none waits on the `default` group.

## R1.3 — Added options

| Option | Requirement |
| --- | --- |
| `-t, --timeout <SECONDS>` | Abandon the wait after this long. Default: no timeout. |
| `-u, --until <SCRIPT\|COMMAND>` | Repeatable. Stop waiting successfully when it exits `0`. |
| `-w, --while <SCRIPT\|COMMAND>` | Repeatable. Abandon the wait when it exits non-zero. |
| `-i, --interval <SECONDS>` | Poll period. Default `2`. |
| `--condition-timeout <SECONDS>` | Per-run budget for a condition script. Default `30`. |
| `--task-grace <SECONDS\|forever>` | How long a named id may be missing before exit `7`. Default `5`. See R2.6. |
| `--json` | Emit one JSON result object on stdout; implies `--quiet`. See R4.7. |
| `--fail-on-error` | Exit `1` when the wait completes with a failed task. |
| `--pueue-binary <PATH>` | pueue executable. Default `$PUEUE_BINARY`, else `pueue`. |
| `--config <PATH>` | Forwarded to pueue as `--config`. |
| `--profile <NAME>` | Forwarded to pueue as `--profile`. |
| `--shell <PATH>` | Shell for inline commands and non-executable scripts. Default `/bin/sh`. |
| `-V, --version` | Print the package version and exit `0`. |

## R1.4 — Duration parsing

A bare number is **seconds** (`--timeout 30`). The suffixes `ms`, `s`/`sec`/`secs`,
`m`/`min`/`mins`, `h`/`hr`/`hrs` are also accepted, case-insensitively, with
optional whitespace (`--timeout "3 min"`). Durations resolve to whole
milliseconds and must be greater than zero.

Anything else — a bare word, a negative number, an unknown unit, a value too
large to represent — is a usage error naming the offending flag.

## R1.5 — Status values

`--status` accepts, case-insensitively: `queued`, `stashed`, `running`,
`paused`, `locked`, `done`, `success`, `failed`.

This is a **superset** of what `pueue wait --status` accepts. The extra values
cost nothing (the matching is ours, not pueue's) and make the tool useful for
waiting on states pueue can report but not wait for.

## R1.6 — Errors

Every usage error prints `error: <message>` on **stderr**, points at
`--help`, and exits `2`. Nothing is written to stdout.
