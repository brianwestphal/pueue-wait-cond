# Manual test plan

For behaviour that automated tests cannot reliably cover. Keep this current: add
items when you ship something unautomatable, and when you later automate one,
delete it here and note it under **Automated coverage summary**.

Prerequisites: `npm run build`, a running `pueued`, and `alias pwc="node
$(pwd)/bin/pueue-wait-cond.js"`.

## M1 — Colour in a real terminal

Automated tests force `NO_COLOR`, so the actual escape sequences are never seen
by a human.

1. `pueue add -- 'sleep 3; exit 1'`, note the id.
2. `pwc <id>` in a real terminal → `failed` is red; a succeeding task shows
   `succeeded` in green; the "Waiting on…" line is dim.
3. `NO_COLOR=1 pwc <id>` → no escape sequences.
4. `pwc <id> | cat` → no escape sequences (not a TTY).
5. `FORCE_COLOR=1 pwc <id> | cat` → colour present despite the pipe.

**Expected:** colour only in cases 2 and 5.

## M2 — Ctrl-C ergonomics

Signal *delivery from a terminal* (process group, terminal state) differs from
`kill` in a test harness.

1. `pueue add -- 'sleep 120'`, then `pwc <id>`.
2. Press Ctrl-C.

**Expected:** returns to the prompt immediately (not after the poll interval),
no stack trace, no orphaned condition process, `echo $?` → `130`. The pueue task
keeps running — the wait was interrupted, not the task.

Repeat with `--until 'sleep 60'` in flight: the condition child must not survive
the parent. Check with `ps`.

## M3 — Very large daemon state

The 64 MiB `maxBuffer` is sized for real-world `pueue status --json` output; the
tests only synthesise a few MB.

1. On a daemon with 500+ finished tasks carrying large environments, run
   `pueue status --json | wc -c` and note the size.
2. `pwc -a --timeout 5`.

**Expected:** no `maxBuffer exceeded` error, no noticeable stall per poll.

## M4 — Terminal resize / long output lines

1. `pwc -a` in a narrow (40-column) terminal with many tasks.

**Expected:** the "Waiting on N task(s): …" line wraps rather than being
truncated or corrupting the display.

## M5 — A real long-running deployment scenario

The end-to-end story the tool exists for, with real timing.

1. `pueue add -- './deploy.sh'` (something that runs for minutes and writes a
   readiness marker partway through).
2. `pwc <id> --timeout 15m --until './healthcheck.sh' --while './lock-held.sh'`.

**Expected:** exits `0` at the moment the healthcheck first passes, well before
the task finishes; the elapsed time matches the healthcheck flipping; removing
the lock file mid-run instead yields exit `4` promptly.

## M6 — Cross-platform

Automated coverage runs on macOS only.

- **Linux:** run the full suite (`npm test`). Watch for `/bin/sh` differences in
  condition resolution and for `pueue_directory` isolation in `TestDaemon`.
- **Windows:** **not supported, by decision** (HS-6). `package.json` declares
  `"os": ["darwin", "linux"]`. The check here is only that the *refusal* is
  clean: on a Windows box, `npm install pueue-wait-cond` must fail immediately
  with `EBADPLATFORM` and name the supported platforms — it must not install
  and then fail at the first condition. See
  [requirements/05-packaging.md](requirements/05-packaging.md) R5.2.1.

  **This one genuinely needs a Windows machine.** `npm install --os=win32` does
  *not* simulate it: that flag exists to let you fetch optional dependencies
  *for* another platform, so it relaxes the check rather than tightening it, and
  the install succeeds. Enforcement was verified indirectly instead, by
  installing a package declaring `"os": ["aix"]` on macOS — npm exits `1` with
  `EBADPLATFORM` and installs nothing, which is the mechanism this relies on.

## M7 — Publish dry-run

1. `npm pack --dry-run`.

**Expected:** the tarball contains `bin/`, `dist/src/`, `README.md`, `LICENSE`
and nothing else — no `test/`, no `src/*.ts`, no configs.

## Automated coverage summary

Previously-manual checks now covered automatically:

| Item | Covered by |
| --- | --- |
| Real daemon lifecycle (queued → running → done, dependencies, kill) | `test/e2e/daemon.test.ts` |
| `--until` / `--while` against real tasks | `test/e2e/daemon.test.ts` |
| Isolation from the developer's own pueue daemon | `test/helpers/e2e.ts` `TestDaemon` |
| SIGINT / SIGTERM exit code | `test/e2e/cli.test.ts`, `test/unit/main.test.ts` |
| Condition SIGTERM → SIGKILL escalation | `test/unit/condition.test.ts` |
| Colour gating logic (not the rendering) | `test/unit/reporter.test.ts` |
| Large `pueue status --json` payloads (~8 MB) | `test/unit/pueue.test.ts` |
