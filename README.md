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

Requires **Node.js ≥ 20** and **pueue** (see below). No runtime dependencies.

**macOS and Linux only.** Windows is not supported — conditions run through
`/bin/sh` and the tool relies on POSIX signals — so `package.json` declares
`"os": ["darwin", "linux"]` and `npm install` refuses up front rather than
failing later at the first condition.

## Installing pueue

[pueue](https://github.com/Nukesor/pueue) is a shell task queue: you hand it
long-running commands, it runs them in the background, and you query or wait on
them later. It is not in most default distro repos, so it usually needs
installing explicitly. `pueue-wait-cond` is useless without it.

It ships **two** binaries and you need both:

| Binary | Role |
| --- | --- |
| `pueued` | the daemon — actually runs your tasks |
| `pueue` | the client — what `pueue-wait-cond` shells out to |

### macOS

```sh
brew install pueue
brew services start pueue        # start now, and again at login
```

If you'd rather not run it as a background service, start the daemon by hand
instead: `pueued -d`.

### Linux

The upstream project recommends your system package manager first, since distro
packages also drop in the service files and shell completions. Coverage varies a
lot by distro — check the
[repology table](https://repology.org/project/pueue/versions) for yours.

Otherwise, either build it:

```sh
cargo install --locked pueue     # installs to ~/.cargo/bin
```

…or grab the prebuilt binaries (Linux incl. ARM, macOS) from the
[releases page](https://github.com/Nukesor/pueue/releases) — download both
`pueue` and `pueued`, rename them if the asset names carry a target suffix, and
put them on your `$PATH`.

Then start the daemon. Package installs ship a systemd **user** unit:

```sh
systemctl --user enable --now pueued.service
```

For a cargo or tarball install there is no unit file, so either daemonize it
directly or [copy the unit](https://github.com/Nukesor/pueue/blob/main/utils/pueued.service)
and fix its `ExecStart` path:

```sh
pueued -d
```

### Check it works

```sh
pueue status          # should print a task table, not a connection error
pueue add -- 'sleep 5'
pueue-wait-cond --timeout 30
```

If `pueue status` reports it cannot reach the daemon, `pueued` is not running —
that is a pueue setup problem, not a `pueue-wait-cond` one. `pueue-wait-cond`
surfaces the same error and exits `5`.

### Notes

- `pueue-wait-cond` only ever invokes the **client** (`pueue status --json`), so
  strictly it needs `pueue` on `$PATH` and a daemon it can reach — the daemon
  itself may live elsewhere. Point at a non-default binary with
  `--pueue-binary` or `$PUEUE_BINARY`, and at a non-default daemon with
  `--config` / `--profile`.
- Developed and tested against **pueue 4.x**. The only coupling is that
  `pueue status --json` exists and emits the usual `tasks` / `groups` payload.

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
| `-u, --until <SCRIPT\|COMMAND>` | Stop waiting **successfully** as soon as any `--until` exits `0` |
| `-w, --while <SCRIPT\|COMMAND>` | **Give up** as soon as any `--while` exits non-zero |
| `--condition-timeout <SECONDS>` | Kill a condition that runs this long (default `30`) |

Both are repeatable: `--until` fires when **any** of them passes, `--while`
gives up when **any** of them fails.

Each takes either a **script path** or an **inline shell command** — see below.

## Inline conditions

You do not need a wrapper script. A condition value that names an **existing
file** is executed as a script; **anything else is run as an inline shell
command** (`/bin/sh -c`), so full shell syntax is available:

```sh
# a plain test
pueue-wait-cond 42 --until 'test -f /tmp/ready'

# an HTTP healthcheck
pueue-wait-cond 42 --until 'curl -sf localhost:8080/health'

# a pipeline over the task's own log
pueue-wait-cond 42 --until 'pueue log 42 | grep -q "Listening on"'

# && chaining, in a guard
pueue-wait-cond -g build --while 'test -f /run/deploy.lock && pgrep -q deployd'
```

Multiple statements, `if`/`then`, and multiple lines all work. The **exit status
of the last command** is the verdict:

```sh
pueue-wait-cond -g build --timeout 10m --until '
  ids=$PUEUE_WAIT_PENDING_TASK_IDS
  test -n "$ids" || exit 1
  echo "still pending: $ids" >&2
  curl -sf localhost:8080/health
'
```

Inline commands get the same inputs as script files — the snapshot on stdin, the
same JSON at `$PUEUE_WAIT_STATUS_JSON`, and the `PUEUE_WAIT_*` environment:

```sh
# stop once nothing is left pending
pueue-wait-cond -a --until 'test -z "$PUEUE_WAIT_PENDING_TASK_IDS"'

# query the snapshot on stdin with jq
pueue-wait-cond 42 --until 'jq -e ".tasks[0].result == \"Success\"" >/dev/null'

# or read it from the file, for tools that want a path
pueue-wait-cond 42 --until 'grep -q Running "$PUEUE_WAIT_STATUS_JSON"'
```

Use `--shell /bin/bash` if you want bashisms such as `[[ ]]`.

### Two things that will bite you

**Quote with single quotes.** With double quotes, *your* shell expands
`$PUEUE_WAIT_*` before `pueue-wait-cond` ever sees the string:

```sh
--until "test $PUEUE_WAIT_ITERATION -ge 3"   # ✗ becomes: test  -ge 3
--until 'test $PUEUE_WAIT_ITERATION -ge 3'   # ✓
```

**Existing files win over command names.** Because the rule is "file path first,
shell command otherwise", a bare one-word value collides with a same-named file
in the working directory — with a `./true` file present, `--until 'true'` runs
*that file*, not the shell builtin. Anything containing a space, flag or
redirect can't collide.

**Tip:** a long inline script is echoed in full into the progress and
`[--until …]` output prefixes, which gets noisy. Move it to a script file once it
outgrows a line or two.

### Timing

| Option | Meaning |
| --- | --- |
| `-t, --timeout <SECONDS>` | Give up after this long (default: never) |
| `-i, --interval <SECONDS>` | Poll period (default `2`) |
| `--task-grace <SECONDS\|forever>` | How long a named task id may be missing from pueue before giving up with exit `7` (default `5`) |

Durations are seconds by default; `ms` / `s` / `m` / `h` suffixes also work
(`--timeout 5m`).

### pueue plumbing and output

| Option | Meaning |
| --- | --- |
| `--pueue-binary <PATH>` | pueue executable (default `$PUEUE_BINARY` or `pueue`) |
| `--config <PATH>`, `--profile <NAME>` | Forwarded to `pueue` |
| `--shell <PATH>` | Shell for non-executable conditions (default `/bin/sh`) |
| `-q, --quiet` | No progress output |
| `--json` | One JSON object on stdout instead of progress (implies `--quiet`) |
| `-h, --help`, `-V, --version` | |

### JSON output

`--json` prints **exactly one object on stdout** when the run resolves, so you
can branch on the result rather than scraping progress lines:

```console
$ pueue-wait-cond -g build --json --until ./ready.sh | jq -r '.outcome, .elapsedMs'
until
8231
```

```json
{
  "outcome": "reached",
  "exitCode": 0,
  "elapsedMs": 12500,
  "iterations": 6,
  "targetStatus": "done",
  "group": "build",
  "tasks": [
    { "id": 4, "group": "build", "label": null, "command": "make",
      "status": "Done", "result": "Success", "exitCode": null }
  ],
  "pendingIds": [],
  "failedIds": [],
  "condition": null,
  "unknownIds": []
}
```

`outcome` is one of `reached`, `until`, `while`, `timeout`, `unreachable`,
`unknown-tasks`, `interrupted`. `condition` is filled in only when a condition
ended the wait; `unknownIds` only for `unknown-tasks`. Every key is always
present — absent values are `null` or `[]`, never omitted.

**Errors are JSON too**, so you never have to guess whether stdout is parseable:

```json
{ "outcome": "error", "exitCode": 5,
  "error": { "kind": "pueue", "message": "..." } }
```

`kind` is `usage`, `pueue` or `condition`. This includes usage errors — getting
the invocation wrong is exactly when a script wants a structured answer. In this
mode stderr stays empty.

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
| `7` | Named task ids never appeared within `--task-grace` |
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
- Waiting on a task id the daemon has never heard of **warns and keeps waiting
  for `--task-grace` (5s), then exits `7`** — long enough that `pueue add`
  immediately followed by a wait isn't a race, short enough that a typo doesn't
  hang. `--task-grace forever` restores the indefinite wait.
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
installed those tests **skip silently** — see [Installing pueue](#installing-pueue)
if you want them to actually run, or set `PWC_REQUIRE_PUEUE=1` to turn the skip
into a failure.

### Releasing

```sh
npm run release            # interactive stable release  -> tag v{version}
npm run release:beta       # same, but                   -> tag v{version}-beta.N
npm run release:beta:auto  # non-interactive beta, for automation
```

Nothing publishes locally. The scripts bump the version, prepend to
`CHANGELOG.md`, run the gates, commit, and push an annotated `v*` tag;
`.github/workflows/release.yml` takes it from there — re-running the gates,
publishing to npm with provenance under `latest` or `beta`, and opening a GitHub
Release. `npm run release` is resumable if you abort part-way.

CI (`.github/workflows/ci.yml`) runs lint, typecheck and both suites on
**ubuntu + macOS × Node 20 and 22**, plus a merged coverage job. It installs
pueue from prebuilt release binaries via `.github/scripts/install-pueue.sh` and
sets `PWC_REQUIRE_PUEUE=1`, so a failed install can't masquerade as a green run.

See [`docs/`](docs/) for the requirements documents and the codebase map.

## License

MIT
