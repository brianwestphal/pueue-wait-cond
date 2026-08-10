/**
 * End-to-end coverage against a real `pueued`.
 *
 * The daemon runs in its own temp directory with its own socket and state, so
 * these never see — or disturb — the developer's own pueue instance.
 */
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { EXIT } from '../../src/exitCodes.js';
import { HAS_PUEUE, makeTempDir, REQUIRE_PUEUE, runCli, TestDaemon, writeScript } from '../helpers/e2e.js';

let daemon: TestDaemon;
let dir: string;

before(async () => {
  if (!HAS_PUEUE) return;
  dir = makeTempDir('pwc-e2e-daemon-');
  daemon = await TestDaemon.start();
}, { timeout: 60_000 });

after(async () => {
  if (!HAS_PUEUE) return;
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

const skip = HAS_PUEUE ? false : 'pueue/pueued are not installed (set PWC_REQUIRE_PUEUE=1 to fail instead)';

describe('e2e (real daemon): preconditions', () => {
  it('finds pueue when the environment demands it', () => {
    if (!REQUIRE_PUEUE) {
      assert.equal(typeof HAS_PUEUE, 'boolean');
      return;
    }
    assert.ok(
      HAS_PUEUE,
      'PWC_REQUIRE_PUEUE is set but pueue/pueued are not on $PATH. ' +
        'The real-daemon suite would have skipped silently, producing a green ' +
        'but empty run. Install pueue (.github/scripts/install-pueue.sh) or ' +
        'unset PWC_REQUIRE_PUEUE.',
    );
  });
});

describe('e2e (real daemon): basic waiting', { skip }, () => {
  it('waits for a single task to finish', async () => {
    const id = await daemon.add('sleep 0.5; exit 0');
    const run = await runCli([...daemon.cliArgs(), String(id), '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, new RegExp(`Task ${id} succeeded with 0`));
  });

  it('returns immediately for an already-finished task', async () => {
    const id = await daemon.add('true');
    await runCli([...daemon.cliArgs(), String(id), '--interval', '0.2']);
    const run = await runCli([...daemon.cliArgs(), String(id), '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
  });

  it('reports a failing task and still exits 0 by default', async () => {
    const id = await daemon.add('exit 5');
    const run = await runCli([...daemon.cliArgs(), String(id), '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, new RegExp(`Task ${id} failed with 5`));
  });

  it('exits 1 for a failing task with --fail-on-error', async () => {
    const id = await daemon.add('exit 5');
    const run = await runCli([
      ...daemon.cliArgs(),
      String(id),
      '--fail-on-error',
      '--interval',
      '0.2',
    ]);
    assert.equal(run.code, EXIT.TASK_FAILURE);
  });

  it('waits for several tasks at once', async () => {
    const a = await daemon.add('sleep 0.3');
    const b = await daemon.add('sleep 0.6');
    const run = await runCli([
      ...daemon.cliArgs(),
      String(a),
      String(b),
      '--interval',
      '0.2',
    ]);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, new RegExp(`Task ${a} succeeded`));
    assert.match(run.stdout, new RegExp(`Task ${b} succeeded`));
  });

  it('waits on a whole group', async () => {
    await daemon.addGroup('e2e-group');
    await daemon.add('sleep 0.3', ['-g', 'e2e-group']);
    await daemon.add('sleep 0.4', ['-g', 'e2e-group']);
    const run = await runCli([...daemon.cliArgs(), '--group', 'e2e-group', '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, /All 2 task\(s\) reached "done"/);
  });

  it('is silent on stdout with --quiet', async () => {
    const id = await daemon.add('sleep 0.3');
    const run = await runCli([...daemon.cliArgs(), String(id), '--quiet', '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    assert.equal(run.stdout, '');
  });
});

describe('e2e (real daemon): --status', { skip }, () => {
  it('returns as soon as a task starts running', async () => {
    const id = await daemon.add('sleep 3');
    const started = Date.now();
    const run = await runCli([
      ...daemon.cliArgs(),
      String(id),
      '--status',
      'running',
      '--interval',
      '0.1',
    ]);
    assert.equal(run.code, EXIT.OK);
    assert.ok(Date.now() - started < 3_000, 'should not have waited for the task to finish');
    await daemon.pueue(['kill', String(id)]).catch(() => undefined);
  });

  it('exits 1 when --status success meets a failing task', async () => {
    const id = await daemon.add('exit 4');
    const run = await runCli([
      ...daemon.cliArgs(),
      String(id),
      '--status',
      'success',
      '--interval',
      '0.2',
    ]);
    assert.equal(run.code, EXIT.TASK_FAILURE);
    assert.match(run.stderr, /finished without reaching "success"/);
  });

  it('waits for a stashed task', async () => {
    const id = await daemon.add('true', ['--stashed']);
    const run = await runCli([
      ...daemon.cliArgs(),
      String(id),
      '--status',
      'stashed',
      '--interval',
      '0.2',
    ]);
    assert.equal(run.code, EXIT.OK);
    await daemon.pueue(['enqueue', String(id)]).catch(() => undefined);
  });
});

describe('e2e (real daemon): conditions', { skip }, () => {
  it('--until stops the wait early while the task keeps running', async () => {
    const flag = join(dir, 'until-flag');
    if (existsSync(flag)) rmSync(flag);
    const id = await daemon.add(`sleep 1; touch ${flag}; sleep 5`);
    const check = writeScript(dir, 'until-flag.sh', `#!/bin/sh\ntest -f "${flag}"\n`);

    const started = Date.now();
    const run = await runCli([...daemon.cliArgs(), String(id), '--until', check, '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, /satisfied; done waiting/);
    assert.ok(Date.now() - started < 6_000, 'should not have waited out the whole task');
    await daemon.pueue(['kill', String(id)]).catch(() => undefined);
  });

  it('--while abandons the wait when the guard breaks', async () => {
    const flag = join(dir, 'while-flag');
    if (existsSync(flag)) rmSync(flag);
    const id = await daemon.add(`sleep 1; touch ${flag}; sleep 10`);
    // Hold only while the flag is absent.
    const guard = writeScript(dir, 'while-flag.sh', `#!/bin/sh\ntest ! -f "${flag}"\n`);

    const run = await runCli([...daemon.cliArgs(), String(id), '--while', guard, '--interval', '0.2']);
    assert.equal(run.code, EXIT.CONDITION_FAILED);
    assert.match(run.stdout, /giving up/);
    await daemon.pueue(['kill', String(id)]).catch(() => undefined);
  });

  it('gives conditions a real snapshot of the daemon state', async () => {
    const id = await daemon.add('sleep 2');
    const check = writeScript(
      dir,
      'inspect-real.sh',
      [
        '#!/bin/sh',
        'snapshot=$(cat)',
        `echo "$snapshot" | grep -q '"id": ${id}' || exit 1`,
        `test "$PUEUE_WAIT_TASK_IDS" = "${id}" || exit 1`,
        'test -s "$PUEUE_WAIT_STATUS_JSON" || exit 1',
        'exit 0',
      ].join('\n') + '\n',
    );
    const run = await runCli([...daemon.cliArgs(), String(id), '--until', check, '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    await daemon.pueue(['kill', String(id)]).catch(() => undefined);
  });

  it('--timeout bounds a task that outlives it', async () => {
    const id = await daemon.add('sleep 30');
    const started = Date.now();
    const run = await runCli([...daemon.cliArgs(), String(id), '--timeout', '1', '--interval', '0.2']);
    assert.equal(run.code, EXIT.TIMEOUT);
    assert.ok(Date.now() - started < 10_000);
    assert.match(run.stdout, new RegExp(`Still waiting on: ${id}`));
    await daemon.pueue(['kill', String(id)]).catch(() => undefined);
  });
});

describe('e2e (real daemon): lifecycle transitions', { skip }, () => {
  it('follows a task from queued through running to done', async () => {
    // Saturate the workers so the task under test is observably queued first.
    await daemon.addGroup('e2e-serial');
    await daemon.pueue(['parallel', '1', '-g', 'e2e-serial']);
    const blocker = await daemon.add('sleep 1.5', ['-g', 'e2e-serial']);
    const id = await daemon.add('sleep 0.3', ['-g', 'e2e-serial']);

    const run = await runCli([...daemon.cliArgs(), String(id), '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, new RegExp(`Waiting on 1 task\\(s\\): ${id} \\(Queued\\)`));
    assert.match(run.stdout, new RegExp(`Task ${id} succeeded with 0`));
    assert.ok(blocker >= 0);
  });

  it('waits for a dependent task through its dependency', async () => {
    const first = await daemon.add('sleep 0.5');
    const second = await daemon.add('true', ['--after', String(first)]);
    const run = await runCli([...daemon.cliArgs(), String(second), '--interval', '0.2']);
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, new RegExp(`Task ${second} succeeded with 0`));
  });

  it('reports a killed task as a failure', async () => {
    const id = await daemon.add('sleep 30');
    // Let it start, then kill it out from under the wait.
    const runPromise = runCli([
      ...daemon.cliArgs(),
      String(id),
      '--fail-on-error',
      '--interval',
      '0.2',
    ]);
    await new Promise((r) => setTimeout(r, 1_000));
    await daemon.pueue(['kill', String(id)]);
    const run = await runPromise;
    assert.equal(run.code, EXIT.TASK_FAILURE);
    assert.match(run.stdout, new RegExp(`Task ${id} failed with`));
  });

  it('picks up a task enqueued into the group after the wait started', async () => {
    await daemon.addGroup('e2e-late');
    const first = await daemon.add('sleep 1', ['-g', 'e2e-late']);
    const runPromise = runCli([...daemon.cliArgs(), '--group', 'e2e-late', '--interval', '0.2']);
    await new Promise((r) => setTimeout(r, 400));
    const late = await daemon.add('sleep 1', ['-g', 'e2e-late']);
    const run = await runPromise;
    assert.equal(run.code, EXIT.OK);
    assert.match(run.stdout, new RegExp(`Task ${late} succeeded with 0`));
    assert.ok(first >= 0);
  });
});
