# Requirements: output and exit codes

Status: **Shipped**

Related: [01-cli-surface.md](01-cli-surface.md) · [02-wait-semantics.md](02-wait-semantics.md) ·
[03-conditions.md](03-conditions.md)

## R4.1 — Exit codes are the contract

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `OK` | Every selected task reached the target status, or an `--until` condition passed |
| `1` | `TASK_FAILURE` | The wait completed but a task did not succeed |
| `2` | `USAGE` | Bad command line |
| `3` | `TIMEOUT` | `--timeout` elapsed |
| `4` | `CONDITION_FAILED` | A `--while` condition exited non-zero |
| `5` | `PUEUE_ERROR` | pueue could not be reached, or its output not understood |
| `6` | `CONDITION_ERROR` | A condition script could not be executed at all |
| `7` | `UNKNOWN_TASKS` | Named task ids never appeared within `--task-grace` (R2.6) |
| `130` | `INTERRUPTED` | SIGINT / SIGTERM |

Scripts branch on these, so any change is a breaking change.

Exit `1` happens in exactly two cases: `--fail-on-error` with a failed task, and
a `--status success`/`failed` target that became unreachable (R2.5).

## R4.2 — Task failure does not fail the wait by default

Like `pueue wait`, a completed wait exits `0` even when tasks failed — "the
tasks are done" is the question being asked. `--fail-on-error` opts into the
stricter reading. `--status success` is the third way to ask.

## R4.3 — Progress output mirrors pueue wait

Unless `--quiet`, progress goes to **stdout**, one line per event, prefixed with
a zero-padded local wall-clock time, in `pueue wait`'s own format:

```
09:20:07 - Task 65 changed from Queued to Running
09:20:09 - Task 65 succeeded with 0
09:20:11 - Task 64 failed with 7
```

so existing scrapers keep working. A task that finished with no exit code
available renders its result name instead (`failed with Killed`).

## R4.4 — Additional lines

```
09:20:05 - Waiting on 2 task(s): 64 (Queued), 65 (Running)
09:21:44 - --until condition "./ready.sh" exit 1
09:21:46 - --until condition "./ready.sh" satisfied; done waiting
09:21:46 - --while condition "./guard.sh" failed (exit 3); giving up
09:25:00 - Timed out after 300.000s. Still waiting on: 64, 65.
09:22:00 - All 2 task(s) reached "done"
```

Tasks that were **already finished** when the wait first looked also get their
usual `succeeded`/`failed` line, so anything grepping for `failed with` sees
every failure the tool observed — not only the ones it watched happen.

A status change is reported once, on the poll where it is first seen. Repeated
identical snapshots produce no output.

## R4.5 — Stream discipline

- **stdout**: progress lines, `--help`, `--version`, and under `--json` the
  result object. Nothing else.
- **stderr**: errors, warnings, forwarded condition output.

Errors are printed even under `--quiet`; warnings and condition output are not.
Under `--json` errors move to stdout as objects (R4.7.2) and stderr stays empty.

## R4.6 — Color

Color is used only when stdout is a TTY. `NO_COLOR` (non-empty) disables it
unconditionally; `FORCE_COLOR` (non-empty, not `0`) enables it without a TTY.
`NO_COLOR` wins over `FORCE_COLOR`.

## R4.7 — `--json`: machine-readable results

`--json` replaces the progress lines with **exactly one JSON object on stdout**,
printed when the run resolves.

It **implies `--quiet`**. stdout belongs to the object — interleaving prose
would make it unparseable, and there is no useful "half quiet" mode.

### R4.7.1 — Resolved runs

```json
{
  "outcome": "reached",
  "exitCode": 0,
  "elapsedMs": 12500,
  "iterations": 6,
  "targetStatus": "done",
  "group": null,
  "tasks": [
    { "id": 4, "group": "default", "label": null, "command": "make",
      "status": "Done", "result": "Success", "exitCode": null }
  ],
  "pendingIds": [],
  "failedIds": [],
  "condition": null,
  "unknownIds": []
}
```

`outcome` is the wait-outcome tag: `reached`, `until`, `while`,
`timeout`, `unreachable`, `unknown-tasks`, `interrupted`.

- `condition` is populated only when a condition ended the wait — `{ kind,
  value, exitCode }` — and is `null` otherwise. A `--while` killed by a signal
  reports `exitCode: null`.
- `unknownIds` is populated only for `unknown-tasks`.
- `tasks` carries the selected tasks as of the final poll, in the same reduced
  shape conditions get. It **must not** include pueue's per-task `envs` map, for
  the same reason as R3.5.

Every key is always present; absent values are `null` or `[]` rather than
omitted, so consumers need no existence checks.

### R4.7.2 — Failures are JSON too

An error before the wait resolves prints an object rather than prose, so a
caller can parse stdout unconditionally:

```json
{ "outcome": "error", "exitCode": 5,
  "error": { "kind": "pueue", "message": "..." } }
```

`kind` is `usage` (exit `2`), `pueue` (exit `5`) or `condition` (exit `6`).
stderr stays empty in this mode.

**Usage errors are included**, which requires sniffing `--json` out of the raw
argv: the flag cannot be parsed when parsing is what failed, and a wrong
invocation is precisely when a caller most wants a structured answer.

### R4.7.3 — Stability

The object is a public interface. Adding keys is a compatible change; renaming
or removing them is breaking. Both shapes always carry `outcome` and
`exitCode`, so a consumer can branch on one field before inspecting anything
else.
