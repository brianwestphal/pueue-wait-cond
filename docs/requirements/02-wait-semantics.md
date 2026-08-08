# Requirements: wait semantics

Status: **Shipped**

Related: [01-cli-surface.md](01-cli-surface.md) · [03-conditions.md](03-conditions.md) ·
[04-output-and-exit-codes.md](04-output-and-exit-codes.md)

## R2.1 — Source of truth

State comes from shelling out to `pueue status --json`, not from speaking the
daemon socket protocol. The JSON is a documented, stable surface; using it keeps
the package free of runtime dependencies and of pueue-version coupling beyond
"has `status --json`".

`--config` and `--profile` are forwarded verbatim so the tool can target the
same daemon the user's `pueue` would.

## R2.2 — Status normalisation

pueue serialises a task status as a serde-tagged enum: either a bare string
(`"Queued"`) or a single-key object (`{"Done": {"result": {"Failed": 7}}}`).
Both shapes normalise to a flat record of `kind`, `result` and `exitCode`.

Malformed or unrecognised payloads must not crash the wait:

- a task entry that is not an object, or has no numeric `id`, is skipped;
- missing `group`/`label`/`command` fall back to `default`/`null`/`""`;
- an unrecognised status or result variant becomes `Unknown` / `null`;
- a `Failed` payload that is not a number yields a `null` exit code.

A payload that is not an object, or that has no `tasks` object, **is** an error
(exit `5`) — that means we are not talking to pueue at all.

## R2.3 — Selection is re-evaluated every poll

The selected task set is recomputed from each fresh snapshot:

- **ids**: exactly those ids, skipping ones the daemon does not (yet) know;
- **group**: every task currently in that group;
- **all**: every task the daemon knows.

Consequence, and it is intended: a task enqueued into the watched group *while
the wait is running* is picked up and waited for. A task enqueued after the
group has already drained is not — the wait ended at the drained poll.

## R2.4 — "Has reached", not "is exactly"

Statuses on the main lifecycle line are ordered `queued` < `running` < `done`. A
task satisfies the target when its status is **at or past** it.

This is what makes the poller correct: a task that starts and finishes between
two polls still satisfies `--status running`. Exact-match semantics would hang
forever on any task shorter than the interval.

`stashed`, `paused` and `locked` are off that line and are matched exactly. A
task parked in one of them has not progressed, so it satisfies no lifecycle
target.

`success` and `failed` are refinements of `done`: `Done` with result `Success`,
and `Done` with any other result (`Failed`, `Killed`, `DependencyFailed`, …).

## R2.5 — Unreachable targets

A finished task's *result* is terminal. Waiting for `success` when a task has
already failed (or `failed` when it has already succeeded) can never be
satisfied, so the wait stops immediately with exit `1` and an explanatory line
on stderr, rather than spinning to the timeout.

Nothing else counts as unreachable. A finished task could in principle be
restarted back into `queued` or `stashed`, so those targets keep waiting.

## R2.6 — Unknown task ids

Naming an id the daemon has never heard of **warns once on stderr and keeps
waiting**, rather than failing.

The alternative — erroring out — would lose a real race: `pueue add` followed
immediately by a wait can legitimately observe the daemon before the task is
visible. The warning names the ids and points at `--timeout` so a typo does not
hang silently forever.

While any named id is still missing, the wait cannot report success, even if
every id it *can* see has finished.

## R2.7 — Empty selections

An empty `--group` or `--all` selection is complete immediately (there is
nothing to wait for). An empty **id** selection is not — see R2.6.

## R2.8 — Polling and the deadline

The loop polls every `--interval`. It never sleeps past the `--timeout`
deadline: the final sleep is clamped to whatever budget remains, so the timeout
fires on time rather than one interval late.

## R2.9 — Interruption

SIGINT and SIGTERM abort the wait promptly — including out of an in-progress
sleep — and exit `130`.
