# Requirements: conditions

Status: **Shipped**

Related: [01-cli-surface.md](01-cli-surface.md) · [02-wait-semantics.md](02-wait-semantics.md) ·
[04-output-and-exit-codes.md](04-output-and-exit-codes.md)

## R3.1 — Meaning

A condition **passes** when its process exits `0`.

- `--until` is an *early success*: when it passes, stop waiting and exit `0`.
- `--while` is a *guard*: while it passes, keep waiting; when it fails, abandon
  the wait and exit `4`.

Both are repeatable. `--until` is satisfied when **any** of them passes;
`--while` is violated when **any** of them fails. Conditions are evaluated in
the order given and evaluation short-circuits on the first decisive result.

## R3.2 — Order of decisions per poll

1. All selected tasks reached the target status → exit `0` / `1`.
2. Any `--until` passed → exit `0`.
3. Any `--while` failed → exit `4`.
4. `--timeout` elapsed → exit `3`.

Completion is checked **first** so that an already-finished wait is never turned
into a failure by a stale `--while`. `--until` outranks `--while` for the same
reason: two conditions disagreeing should resolve toward success.

The timeout is checked **last** so a condition that resolves on the very last
poll still wins over the deadline.

## R3.3 — Resolving what to run

Given a condition value:

1. If it names an **existing file**:
   - executable → run it directly (its shebang applies);
   - not executable → run it as `<shell> <path>`, so a forgotten `chmod +x`
     still works.
2. Otherwise → run it as `<shell> -c <value>`, i.e. an **inline shell command**.

Relative paths resolve against the process's working directory. `<shell>` is
`--shell`, default `/bin/sh`.

Both forms are first-class and must stay documented as such — in `helpText()`,
in the README, and here. The option is spelled `<SCRIPT|COMMAND>` precisely
because `<SCRIPT>` alone reads as "path only" and hides half the feature.

### R3.3.1 — Inline commands are full shell commands

Rule 2 hands the value to `sh -c` unmodified, so everything the shell can do is
available: pipelines, `&&`/`||`, `;`, `$(...)`, redirects, `if`/`then`,
variable assignment, and multi-line bodies. The **exit status of the last
command** is the verdict.

```sh
--until 'curl -sf localhost:8080/health'
--until 'pueue log 42 | grep -q "Listening on"'
--until 'test -z "$PUEUE_WAIT_PENDING_TASK_IDS"'
--while 'test -f /run/deploy.lock && pgrep -q deployd'
```

Inline commands receive exactly the same inputs as script files (R3.4): the
snapshot on stdin, `$PUEUE_WAIT_STATUS_JSON`, and the `PUEUE_WAIT_*`
environment.

### R3.3.2 — Two consequences users must be warned about

**Quoting.** The `PUEUE_WAIT_*` variables exist only in the *condition's*
environment. Double-quoting an inline command lets the calling shell expand them
to empty first, silently changing the test. Single quotes are required, and the
help text and README both say so.

**Path shadowing.** Because rule 1 is checked first, a bare one-word value is
shadowed by a same-named file in the working directory: with an executable
`./true` present, `--until 'true'` runs that file rather than the shell builtin.

This ordering is deliberate — the ticket specified `<script-path>`, so a path
must win — and it is only reachable for single-word values with no space, flag
or redirect. It is documented rather than fixed; changing it would break the
documented primary form.


## R3.4 — What a condition receives

**stdin**: a JSON snapshot of the wait (see R3.5).

**A file**: the same JSON, at the path in `$PUEUE_WAIT_STATUS_JSON`, rewritten
before each condition run, for scripts that cannot conveniently read stdin. The
file lives in a temp directory created only when conditions are configured and
removed when the process exits.

**Environment**: the caller's environment plus

| Variable | Contents |
| --- | --- |
| `PUEUE_WAIT_COND` | always `1` |
| `PUEUE_WAIT_KIND` | `until` or `while` |
| `PUEUE_WAIT_ITERATION` | 0-based poll number |
| `PUEUE_WAIT_ELAPSED_MS` | elapsed milliseconds |
| `PUEUE_WAIT_ELAPSED` | elapsed seconds, 3 decimal places |
| `PUEUE_WAIT_TASK_IDS` | comma-separated selected ids |
| `PUEUE_WAIT_PENDING_TASK_IDS` | selected ids not yet at the target |
| `PUEUE_WAIT_REACHED_TASK_IDS` | selected ids at the target |
| `PUEUE_WAIT_FAILED_TASK_IDS` | selected ids finished without success |
| `PUEUE_WAIT_GROUP` | the `--group` name, or empty |
| `PUEUE_WAIT_TARGET_STATUS` | the `--status` value |
| `PUEUE_WAIT_STATUS_JSON` | path to the snapshot file |

Empty id lists render as the empty string.

## R3.5 — Snapshot contents

The snapshot carries `kind`, `iteration`, `elapsedMs`, `targetStatus`, `group`,
the four id lists, a `tasks` array (`id`, `group`, `label`, `command`, `status`,
`result`, `exitCode`) for the **selected** tasks, and the `groups` table.

It **must not** include the per-task `envs` map that `pueue status --json`
returns. That payload is large and routinely contains API keys; conditions have
no need for it.

## R3.6 — Failure to run is not a false condition

If a condition cannot be executed at all — the file is missing, `--shell` does
not exist or is not executable — that is exit `6` with a message naming the
condition and its kind. It is **never** reported as "the condition is false".

A mistyped `--while` path must not look like "the guard broke" and silently end
the wait.

## R3.7 — Runaway conditions

A condition that runs longer than `--condition-timeout` is sent `SIGTERM`, then
`SIGKILL` two seconds later if it is still alive. A killed condition counts as
**not passing** (it did not exit `0`), and the progress line says `timed out`
rather than showing an exit code.

## R3.8 — Condition output

A condition's stdout and stderr are captured and, unless `--quiet`, re-emitted
on the wait's **stderr**, one line at a time, prefixed `[--until <value>]` /
`[--while <value>]`. They never reach the wait's stdout, which stays reserved
for progress lines.

A condition that ignores the snapshot on stdin must not fail because of it
(`EPIPE` while writing stdin is ignored).
