import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { conditionEnv, ConditionSpawnError, resolveCommand, runCondition } from '../../src/condition.js';
import type { ConditionContext } from '../../src/condition.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwc-cond-test-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ConditionContext> = {}): ConditionContext {
  return {
    kind: 'until',
    iteration: 3,
    elapsedMs: 4_500,
    selectedIds: [1, 2, 3],
    pendingIds: [2, 3],
    reachedIds: [1],
    failedIds: [1],
    group: 'build',
    targetStatus: 'done',
    snapshotJson: '{"hello":"world"}',
    snapshotPath: '/tmp/snapshot.json',
    ...overrides,
  };
}

function script(name: string, body: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, mode);
  return path;
}

describe('resolveCommand', () => {
  it('runs an executable file directly', () => {
    const path = script('exec.sh', '#!/bin/sh\nexit 0\n');
    assert.deepEqual(resolveCommand(path, '/bin/sh'), { file: path, args: [], viaShell: false });
  });

  it('hands a non-executable file to the shell', () => {
    const path = script('noexec.sh', 'exit 0\n', 0o644);
    assert.deepEqual(resolveCommand(path, '/bin/sh'), {
      file: '/bin/sh',
      args: [path],
      viaShell: true,
    });
  });

  it('treats anything that is not a file as a shell command', () => {
    assert.deepEqual(resolveCommand('test -f /nope', '/bin/sh'), {
      file: '/bin/sh',
      args: ['-c', 'test -f /nope'],
      viaShell: true,
    });
  });

  it('does not mistake a directory for a script', () => {
    const resolved = resolveCommand(dir, '/bin/sh');
    assert.equal(resolved.viaShell, true);
    assert.deepEqual(resolved.args, ['-c', dir]);
  });

  it('resolves a relative path against the cwd', () => {
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      script('rel.sh', '#!/bin/sh\nexit 0\n');
      const resolved = resolveCommand('./rel.sh', '/bin/sh');
      assert.equal(resolved.viaShell, false);
      assert.match(resolved.file, /rel\.sh$/);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('conditionEnv', () => {
  it('exports the whole context', () => {
    const env = conditionEnv(makeContext());
    assert.equal(env.PUEUE_WAIT_COND, '1');
    assert.equal(env.PUEUE_WAIT_KIND, 'until');
    assert.equal(env.PUEUE_WAIT_ITERATION, '3');
    assert.equal(env.PUEUE_WAIT_ELAPSED_MS, '4500');
    assert.equal(env.PUEUE_WAIT_ELAPSED, '4.500');
    assert.equal(env.PUEUE_WAIT_TASK_IDS, '1,2,3');
    assert.equal(env.PUEUE_WAIT_PENDING_TASK_IDS, '2,3');
    assert.equal(env.PUEUE_WAIT_REACHED_TASK_IDS, '1');
    assert.equal(env.PUEUE_WAIT_FAILED_TASK_IDS, '1');
    assert.equal(env.PUEUE_WAIT_GROUP, 'build');
    assert.equal(env.PUEUE_WAIT_TARGET_STATUS, 'done');
    assert.equal(env.PUEUE_WAIT_STATUS_JSON, '/tmp/snapshot.json');
  });

  it('renders a null group as an empty string', () => {
    assert.equal(conditionEnv(makeContext({ group: null })).PUEUE_WAIT_GROUP, '');
  });

  it('renders empty id lists as empty strings', () => {
    const env = conditionEnv(makeContext({ selectedIds: [], pendingIds: [], failedIds: [] }));
    assert.equal(env.PUEUE_WAIT_TASK_IDS, '');
    assert.equal(env.PUEUE_WAIT_PENDING_TASK_IDS, '');
    assert.equal(env.PUEUE_WAIT_FAILED_TASK_IDS, '');
  });
});

describe('runCondition', () => {
  const base = { shell: '/bin/sh', timeoutMs: 5_000 };

  it('passes when the script exits 0', async () => {
    const outcome = await runCondition({ ...base, value: 'exit 0', context: makeContext() });
    assert.equal(outcome.passed, true);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.signal, null);
  });

  it('fails when the script exits non-zero, keeping the code', async () => {
    const outcome = await runCondition({ ...base, value: 'exit 42', context: makeContext() });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.exitCode, 42);
  });

  it('captures stdout and stderr', async () => {
    const outcome = await runCondition({
      ...base,
      value: 'echo out; echo err >&2; exit 0',
      context: makeContext(),
    });
    assert.equal(outcome.stdout, 'out\n');
    assert.equal(outcome.stderr, 'err\n');
  });

  it('feeds the snapshot in on stdin', async () => {
    const outcome = await runCondition({
      ...base,
      value: 'cat',
      context: makeContext({ snapshotJson: '{"a":1}' }),
    });
    assert.equal(outcome.stdout, '{"a":1}');
  });

  it('does not fail when the script ignores stdin', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(500_000) });
    const outcome = await runCondition({
      ...base,
      value: 'exit 0',
      context: makeContext({ snapshotJson: big }),
    });
    assert.equal(outcome.passed, true);
  });

  it('exports the context into the environment', async () => {
    const outcome = await runCondition({
      ...base,
      value: 'echo "$PUEUE_WAIT_KIND/$PUEUE_WAIT_PENDING_TASK_IDS"',
      context: makeContext({ kind: 'while' }),
    });
    assert.equal(outcome.stdout, 'while/2,3\n');
  });

  it('inherits the caller environment alongside the injected vars', async () => {
    const outcome = await runCondition({
      ...base,
      value: 'echo "$CUSTOM_MARKER"',
      context: makeContext(),
      env: { CUSTOM_MARKER: 'yes', PATH: process.env.PATH ?? '' },
    });
    assert.equal(outcome.stdout, 'yes\n');
  });

  it('runs an executable script file', async () => {
    const path = script('ok.sh', '#!/bin/sh\necho ran\nexit 0\n');
    const outcome = await runCondition({ ...base, value: path, context: makeContext() });
    assert.equal(outcome.passed, true);
    assert.equal(outcome.stdout, 'ran\n');
  });

  it('runs a non-executable script file through the shell', async () => {
    const path = script('plain.sh', 'echo shelled\nexit 0\n', 0o644);
    const outcome = await runCondition({ ...base, value: path, context: makeContext() });
    assert.equal(outcome.passed, true);
    assert.equal(outcome.stdout, 'shelled\n');
  });

  it('kills a script that overruns the condition timeout', async () => {
    const outcome = await runCondition({
      ...base,
      timeoutMs: 100,
      value: 'sleep 30',
      context: makeContext(),
    });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.signal, 'SIGTERM');
  });

  it('reports a spawn failure as an error, not as a false condition', async () => {
    await assert.rejects(
      runCondition({
        ...base,
        shell: '/definitely/not/a/shell',
        value: 'exit 0',
        context: makeContext(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConditionSpawnError);
        assert.match(error.message, /not found/);
        return true;
      },
    );
  });

  it('reports a non-ENOENT spawn failure too', async () => {
    // A shell that exists but cannot be executed fails with EACCES, not ENOENT.
    const notExecutable = script('unrunnable-shell', '#!/bin/sh\nexit 0\n', 0o644);
    await assert.rejects(
      runCondition({ ...base, shell: notExecutable, value: 'anything', context: makeContext() }),
      (error: unknown) => {
        assert.ok(error instanceof ConditionSpawnError);
        assert.match(error.message, /Could not run --until condition "anything"/);
        assert.equal(error.message.includes('not found'), false);
        return true;
      },
    );
  });

  it('escalates to SIGKILL when the script ignores SIGTERM', async () => {
    // `sh` cannot reliably ignore SIGTERM while blocked on a foreground child,
    // so the stubborn process is a Node one.
    const path = script(
      'stubborn.js',
      `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
    );
    // The budget has to comfortably exceed interpreter start-up, or SIGTERM
    // lands before the handler is installed and the child dies to it — which
    // flakes when the machine is busy running the rest of the suite.
    const outcome = await runCondition({
      ...base,
      timeoutMs: 2_500,
      value: path,
      context: makeContext(),
    });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.signal, 'SIGKILL');
    assert.equal(outcome.passed, false);
  });

  it('names the condition kind in the spawn error', async () => {
    await assert.rejects(
      runCondition({
        ...base,
        shell: '/definitely/not/a/shell',
        value: 'exit 0',
        context: makeContext({ kind: 'while' }),
      }),
      /--while condition/,
    );
  });

  it('measures duration with the injected clock', async () => {
    let t = 1_000;
    const outcome = await runCondition({
      ...base,
      value: 'exit 0',
      context: makeContext(),
      now: () => {
        const value = t;
        t += 250;
        return value;
      },
    });
    assert.equal(outcome.durationMs, 250);
  });
});
