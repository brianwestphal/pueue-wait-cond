/**
 * End-to-end coverage of the shipped binary, driven against a stub `pueue`.
 *
 * The stub keeps these deterministic — no daemon, no timing races — so they can
 * assert exact exit codes and output. `daemon.test.ts` covers the real thing.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { EXIT } from '../../src/exitCodes.js';
import { makeTempDir, runCli, writeScript } from '../helpers/e2e.js';

let dir: string;
let stateFile: string;

before(() => {
  dir = makeTempDir('pwc-e2e-cli-');
  stateFile = join(dir, 'call-count');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stub pueue whose `status --json` walks `snapshots`, one per invocation, and
 * sticks on the last entry.
 */
function stubPueue(name: string, snapshots: unknown[]): string {
  const payloads = snapshots.map((s) => JSON.stringify(s));
  const counter = join(dir, `${name}.count`);
  const body = [
    '#!/bin/sh',
    `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
    `echo $((n + 1)) > "${counter}"`,
    'case "$n" in',
    ...payloads.map((p, i) => {
      const guard = i === payloads.length - 1 ? '*' : String(i);
      return `  ${guard}) cat <<'PWCJSON'\n${p}\nPWCJSON\n  ;;`;
    }),
    'esac',
    'exit 0',
  ].join('\n');
  return writeScript(dir, name, `${body}\n`);
}

function tasks(entries: Array<{ id: number; status: unknown; group?: string }>): unknown {
  return {
    tasks: Object.fromEntries(
      entries.map((e) => [
        String(e.id),
        { id: e.id, group: e.group ?? 'default', label: null, command: 'true', status: e.status },
      ]),
    ),
    groups: { default: { status: 'Running', parallel_tasks: 1 } },
  };
}

const doneOk = { Done: { result: 'Success' } };
const doneFail = { Done: { result: { Failed: 7 } } };

describe('e2e: help, version and usage', () => {
  it('prints help and exits 0', async () => {
    const run = await runCli(['--help']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, /Usage:\s+pueue-wait-cond \[TASK_IDS\]\.\.\. \[OPTIONS\]/);
    assert.match(run.stdout, /--until <SCRIPT>/);
    assert.match(run.stdout, /--while <SCRIPT>/);
    assert.equal(run.stderr, '');
  });

  it('prints a semver version', async () => {
    const run = await runCli(['--version']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it('exits 2 on an unknown flag', async () => {
    const run = await runCli(['--bogus']);
    assert.equal(run.code, EXIT.USAGE);
    assert.match(run.stderr, /error:/);
  });

  it('exits 2 on a bad task id', async () => {
    const run = await runCli(['not-a-number']);
    assert.equal(run.code, EXIT.USAGE);
    assert.match(run.stderr, /Task ids must be non-negative integers/);
  });
});

describe('e2e: pueue plumbing', () => {
  it('exits 5 when the pueue binary is missing', async () => {
    const run = await runCli(['--pueue-binary', join(dir, 'nope')]);
    assert.equal(run.code, EXIT.PUEUE_ERROR);
    assert.match(run.stderr, /Could not find the pueue binary/);
  });

  it('exits 5 when pueue cannot reach its daemon', async () => {
    const binary = writeScript(dir, 'down', '#!/bin/sh\necho "daemon down" >&2\nexit 1\n');
    const run = await runCli(['--pueue-binary', binary]);
    assert.equal(run.code, EXIT.PUEUE_ERROR);
    assert.match(run.stderr, /daemon down/);
  });

  it('reads the binary from $PUEUE_BINARY', async () => {
    const binary = stubPueue('env-binary', [tasks([{ id: 1, status: doneOk }])]);
    const run = await runCli([], { env: { PUEUE_BINARY: binary } });
    assert.equal(run.code, EXIT.OK);
  });
});

describe('e2e: waiting', () => {
  it('exits 0 once every task is done', async () => {
    const binary = stubPueue('finish', [
      tasks([{ id: 1, status: 'Queued' }]),
      tasks([{ id: 1, status: { Running: {} } }]),
      tasks([{ id: 1, status: doneOk }]),
    ]);
    const run = await runCli(['--pueue-binary', binary, '--interval', '0.01']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, /Task 1 changed from Queued to Running/);
    assert.match(run.stdout, /Task 1 succeeded with 0/);
  });

  it('says nothing on stdout with --quiet', async () => {
    const binary = stubPueue('quiet', [tasks([{ id: 1, status: doneOk }])]);
    const run = await runCli(['--pueue-binary', binary, '--quiet']);
    assert.equal(run.code, EXIT.OK);
    assert.equal(run.stdout, '');
  });

  it('exits 0 on a failed task by default', async () => {
    const binary = stubPueue('fail-default', [tasks([{ id: 1, status: doneFail }])]);
    const run = await runCli(['--pueue-binary', binary]);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, /Task 1 failed with 7/);
  });

  it('exits 1 on a failed task with --fail-on-error', async () => {
    const binary = stubPueue('fail-opt-in', [tasks([{ id: 1, status: doneFail }])]);
    const run = await runCli(['--pueue-binary', binary, '--fail-on-error']);
    assert.equal(run.code, EXIT.TASK_FAILURE);
  });

  it('honours --group', async () => {
    const binary = stubPueue('group', [
      tasks([
        { id: 1, status: doneOk, group: 'build' },
        { id: 2, status: { Running: {} }, group: 'other' },
      ]),
    ]);
    const run = await runCli(['--pueue-binary', binary, '--group', 'build']);
    assert.equal(run.code, EXIT.OK);
  });

  it('honours --status running', async () => {
    const binary = stubPueue('status-running', [
      tasks([{ id: 1, status: 'Queued' }]),
      tasks([{ id: 1, status: { Running: {} } }]),
    ]);
    const run = await runCli(['--pueue-binary', binary, '--status', 'running', '--interval', '0.01']);
    assert.equal(run.code, EXIT.OK);
  });

  it('exits 1 when --status success meets a failed task', async () => {
    const binary = stubPueue('status-success', [tasks([{ id: 1, status: doneFail }])]);
    const run = await runCli(['--pueue-binary', binary, '--status', 'success']);
    assert.equal(run.code, EXIT.TASK_FAILURE);
    assert.match(run.stderr, /finished without reaching "success"/);
  });
});

describe('e2e: --timeout', () => {
  it('exits 3 when the budget runs out', async () => {
    const binary = stubPueue('timeout', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli(['--pueue-binary', binary, '--timeout', '0.3', '--interval', '0.05']);
    assert.equal(run.code, EXIT.TIMEOUT);
    assert.match(run.stdout, /Timed out after 0\.300s\. Still waiting on: 1\./);
  });

  it('accepts a suffixed duration', async () => {
    const binary = stubPueue('timeout-suffix', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli(['--pueue-binary', binary, '--timeout', '300ms', '--interval', '50ms']);
    assert.equal(run.code, EXIT.TIMEOUT);
  });
});

describe('e2e: --until', () => {
  it('exits 0 as soon as the script passes', async () => {
    const binary = stubPueue('until-pass', [tasks([{ id: 1, status: { Running: {} } }])]);
    const flag = join(dir, 'ready');
    writeScript(dir, 'touch-ready.sh', `#!/bin/sh\ntouch "${flag}"\nexit 0\n`);
    const run = await runCli([
      '--pueue-binary',
      binary,
      '--until',
      join(dir, 'touch-ready.sh'),
      '--interval',
      '0.01',
    ]);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, /--until condition .* satisfied; done waiting/);
  });

  it('accepts an inline shell command', async () => {
    const binary = stubPueue('until-inline', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli([
      '--pueue-binary',
      binary,
      '--until',
      'test "$PUEUE_WAIT_ITERATION" -ge 2',
      '--interval',
      '0.01',
    ]);
    assert.equal(run.code, EXIT.OK);
  });

  it('runs a non-executable script through the shell', async () => {
    const binary = stubPueue('until-noexec', [tasks([{ id: 1, status: { Running: {} } }])]);
    const path = writeScript(dir, 'plain-until.sh', 'exit 0\n', 0o644);
    const run = await runCli(['--pueue-binary', binary, '--until', path, '--interval', '0.01']);
    assert.equal(run.code, EXIT.OK);
  });

  it('exposes the snapshot on stdin and via $PUEUE_WAIT_STATUS_JSON', async () => {
    const binary = stubPueue('until-snapshot', [tasks([{ id: 42, status: { Running: {} } }])]);
    const path = writeScript(
      dir,
      'inspect.sh',
      [
        '#!/bin/sh',
        'stdin=$(cat)',
        'echo "$stdin" | grep -q \'"id": 42\' || exit 1',
        'grep -q \'"id": 42\' "$PUEUE_WAIT_STATUS_JSON" || exit 1',
        'test "$PUEUE_WAIT_PENDING_TASK_IDS" = "42" || exit 1',
        'test "$PUEUE_WAIT_TARGET_STATUS" = "done" || exit 1',
        'exit 0',
      ].join('\n') + '\n',
    );
    const run = await runCli(['--pueue-binary', binary, '--until', path, '--interval', '0.01']);
    assert.equal(run.code, EXIT.OK);
  });

  it('exits 6 when the script does not exist', async () => {
    const binary = stubPueue('until-missing', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli([
      '--pueue-binary',
      binary,
      '--until',
      'x',
      '--shell',
      join(dir, 'no-such-shell'),
    ]);
    assert.equal(run.code, EXIT.CONDITION_ERROR);
    assert.match(run.stderr, /Could not run --until condition/);
  });

  it('kills a condition that overruns --condition-timeout', async () => {
    const binary = stubPueue('until-slow', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli([
      '--pueue-binary',
      binary,
      '--until',
      'sleep 30',
      '--condition-timeout',
      '0.2',
      '--timeout',
      '0.5',
      '--interval',
      '0.01',
    ]);
    assert.equal(run.code, EXIT.TIMEOUT);
    assert.match(run.stdout, /--until condition "sleep 30" timed out/);
  });
});

describe('e2e: --while', () => {
  it('exits 4 when the guard fails', async () => {
    const binary = stubPueue('while-fail', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli(['--pueue-binary', binary, '--while', 'exit 9', '--interval', '0.01']);
    assert.equal(run.code, EXIT.CONDITION_FAILED);
    assert.match(run.stdout, /--while condition "exit 9" failed \(exit 9\); giving up/);
  });

  it('keeps waiting while the guard holds', async () => {
    const binary = stubPueue('while-hold', [
      tasks([{ id: 1, status: { Running: {} } }]),
      tasks([{ id: 1, status: doneOk }]),
    ]);
    const run = await runCli(['--pueue-binary', binary, '--while', 'exit 0', '--interval', '0.01']);
    assert.equal(run.code, EXIT.OK);
  });

  it('forwards condition output to stderr, not stdout', async () => {
    const binary = stubPueue('while-noisy', [tasks([{ id: 1, status: { Running: {} } }])]);
    // The marker must not appear in the command string itself, since progress
    // lines echo the command back.
    const path = writeScript(dir, 'chatty.sh', '#!/bin/sh\necho MARKER-OUT\nexit 1\n');
    const run = await runCli(['--pueue-binary', binary, '--while', path, '--interval', '0.01']);
    assert.equal(run.code, EXIT.CONDITION_FAILED);
    assert.match(run.stderr, /MARKER-OUT/);
    assert.equal(run.stdout.includes('MARKER-OUT'), false);
  });

  it('combines with --until, letting --until win', async () => {
    const binary = stubPueue('both', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli([
      '--pueue-binary',
      binary,
      '--until',
      'exit 0',
      '--while',
      'exit 1',
      '--interval',
      '0.01',
    ]);
    assert.equal(run.code, EXIT.OK);
  });
});

describe('e2e: signals', () => {
  it('exits 130 on SIGINT', async () => {
    const binary = stubPueue('sigint', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli(['--pueue-binary', binary, '--interval', '5'], {
      killAfterMs: 400,
      timeoutMs: 20_000,
    });
    assert.equal(run.code, EXIT.INTERRUPTED);
  });

  it('exits 130 on SIGTERM', async () => {
    const binary = stubPueue('sigterm', [tasks([{ id: 1, status: { Running: {} } }])]);
    const run = await runCli(['--pueue-binary', binary, '--interval', '5'], {
      killAfterMs: 400,
      killSignal: 'SIGTERM',
      timeoutMs: 20_000,
    });
    assert.equal(run.code, EXIT.INTERRUPTED);
  });
});

describe('e2e: stub bookkeeping', () => {
  it('keeps its call counter under the temp dir', () => {
    assert.match(stateFile, /call-count$/);
  });
});
