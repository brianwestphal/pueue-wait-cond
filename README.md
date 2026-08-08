# pueue-wait-cond

`pueue wait`, plus **timeouts** and **script conditions**.

[pueue](https://github.com/Nukesor/pueue) can wait for tasks to finish. It cannot
give up after a while, and it cannot stop early because *something else* became
true. `pueue-wait-cond` does both, while keeping every option and output line
`pueue wait` already gives you.

```console
$ pueue-wait-cond 42 --timeout 300 --until ./deploy-is-live.sh
09:20:07 - Task 42 changed from Queued to Running
09:21:44 - --until condition "./deploy-is-live.sh" satisfied; done waiting
```

## Install

```sh
npm install -g pueue-wait-cond
# or, without installing:
npx pueue-wait-cond --help
```

Requires **Node.js ≥ 20** and a `pueue` binary on `$PATH` (point elsewhere with
`--pueue-binary` or `$PUEUE_BINARY`). No runtime dependencies.

## Usage

```
pueue-wait-cond [TASK_IDS]... [OPTIONS]
```

### Task selection

Identical to `pueue wait`, and mutually exclusive:

| Option | Meaning |
| --- | --- |
| `[TASK_IDS]...` | Wait for these specific tasks |
| `-g, --group <GROUP>` | Wait for every task in a group |
| `-a, --all` | Wait for every task in every group |
| *(none of the above)* | Wait on the `default` group |

### Wait target

| Option | Meaning |
| --- | --- |
| `-s, --status <STATUS>` | `queued`, `stashed`, `running`, `paused`, `locked`, `done` (default), `success`, `failed` |
| `--fail-on-error` | Exit `1` if the wait completes but a task did not succeed |

Statuses on the queued → running → done line are **"has reached"**, not "is
exactly": a task that finished between two polls still satisfies
`--status running`, so short tasks can't slip past the poller.

### Conditions

| Option | Meaning |
| --- | --- |
| `-u, --until <SCRIPT>` | Stop waiting **successfully** as soon as any `--until` exits `0` |
| `-w, --while <SCRIPT>` | **Give up** as soon as any `--while` exits non-zero |
| `--condition-timeout <SECONDS>` | Kill a condition that runs this long (default `30`) |

Both are repeatable. A condition that names an existing file is executed
directly (or handed to `--shell` if it isn't executable); anything else is run as
an inline shell command, so `--until 'test -f /tmp/ready'` works without a
wrapper script.

### Timing

| Option | Meaning |
| --- | --- |
| `-t, --timeout <SECONDS>` | Give up after this long (default: never) |
| `-i, --interval <SECONDS>` | Poll period (default `2`) |

Durations are seconds by default; `ms` / `s` / `m` / `h` suffixes also work
(`--timeout 5m`).

### pueue plumbing and output

| Option | Meaning |
| --- | --- |
| `--pueue-binary <PATH>` | pueue executable (default `$PUEUE_BINARY` or `pueue`) |
| `--config <PATH>`, `--profile <NAME>` | Forwarded to `pueue` |
| `--shell <PATH>` | Shell for non-executable conditions (default `/bin/sh`) |
| `-q, --quiet` | No progress output |
| `-h, --help`, `-V, --version` | |

## What conditions receive

Each time a condition runs it gets a JSON snapshot of the wait on **stdin**, the
same JSON in a file named by `$PUEUE_WAIT_STATUS_JSON`, and this environment:

| Variable | Example |
| --- | --- |
| `PUEUE_WAIT_COND` | `1` |
| `PUEUE_WAIT_KIND` | `until` or `while` |
| `PUEUE_WAIT_ITERATION` | `0`, `1`, … (poll number) |
| `PUEUE_WAIT_ELAPSED` / `_MS` | `12.500` / `12500` |
| `PUEUE_WAIT_TASK_IDS` | `4,5,6` |
| `PUEUE_WAIT_PENDING_TASK_IDS` | `5,6` |
| `PUEUE_WAIT_REACHED_TASK_IDS` | `4` |
| `PUEUE_WAIT_FAILED_TASK_IDS` | `4` |
| `PUEUE_WAIT_GROUP` | `build` (empty unless `--group`) |
| `PUEUE_WAIT_TARGET_STATUS` | `done` |
| `PUEUE_WAIT_STATUS_JSON` | `/tmp/pueue-wait-cond-XXXX/status.json` |

The snapshot carries the selected tasks and the group table. It deliberately
**omits the per-task environment** that `pueue status --json` includes — that
payload is huge and routinely holds secrets.

```json
{
  "kind": "until",
  "iteration": 3,
  "elapsedMs": 6000,
  "targetStatus": "done",
  "group": "default",
  "selectedIds": [4, 5],
  "pendingIds": [5],
  "reachedIds": [4],
  "failedIds": [],
  "tasks": [
    { "id": 4, "group": "default", "label": null, "command": "make",
      "status": "Done", "result": "Success", "exitCode": null }
  ],
  "groups": { "default": { "status": "Running", "parallelTasks": 4 } }
}
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every selected task reached the target status, **or** an `--until` condition passed |
| `1` | The wait completed but a task failed (`--fail-on-error`, or `--status success`/`failed` became impossible) |
| `2` | Usage error |
| `3` | `--timeout` elapsed |
| `4` | A `--while` condition failed |
| `5` | pueue could not be reached or its output not understood |
| `6` | A condition script could not be executed at all |
| `130` | Interrupted (SIGINT/SIGTERM) |

A condition that *cannot run* (missing file, bad `--shell`) is exit `6`, never
"the condition is false" — a typo in `--while` must not quietly end your wait.

## How a poll is decided

Each interval, in this order:

1. Fetch `pueue status --json` and report any task status changes.
2. **All selected tasks reached the target?** → exit `0` (or `1`).
3. **Any `--until` passed?** → exit `0`.
4. **Any `--while` failed?** → exit `4`.
5. **`--timeout` elapsed?** → exit `3`.

Completion is checked *before* the conditions on purpose: if the tasks are
already done, a stale `--while` guard should not turn a successful wait into a
failure. `--until` outranks `--while` for the same reason.

## Examples

Give a build 10 minutes, but bail out early if the deploy lock disappears:

```sh
pueue-wait-cond -g build --timeout 10m --while 'test -f /var/run/deploy.lock'
```

Wait only until the log says the server is listening — the task itself never
exits:

```sh
pueue-wait-cond 42 --until 'pueue log 42 | grep -q "Listening on"'
```

Block a CI step on success specifically, not merely on completion:

```sh
pueue-wait-cond -g ci --status success || echo "the build did not pass"
```

Stop as soon as *any* of several things becomes true:

```sh
pueue-wait-cond -a --until ./healthy.sh --until ./cancelled.sh --timeout 120
```

## Differences from `pueue wait`

- Extra options: `--timeout`, `--until`, `--while`, `--interval`,
  `--condition-timeout`, `--fail-on-error`, `--pueue-binary`, `--shell`.
- `--status` accepts a **superset** of pueue's values (`stashed`, `paused`,
  `locked`, `failed` in addition to `queued`, `running`, `success`, `done`).
- Waiting on a task id the daemon has never heard of **warns and keeps waiting**
  (so `pueue add` immediately followed by a wait isn't a race) instead of
  failing. Bound it with `--timeout`.
- Exit codes are meaningful; `pueue wait` returns `0` almost regardless.

## Development

```sh
npm install
npm run build          # tsc → dist/
npm test               # unit + E2E
npm run coverage       # merged unit + E2E coverage → coverage/
npm run lint
npm run typecheck
```

The E2E suite starts its **own** `pueued` in a temp directory with its own
socket and state, so it never touches your daemon. If `pueue`/`pueued` aren't
installed those tests skip.

See [`docs/`](docs/) for the requirements documents and the codebase map.

## License

MIT
