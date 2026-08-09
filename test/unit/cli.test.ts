import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Options } from '../../src/args.js';
import { run } from '../../src/cli.js';
import { EXIT, exitCodeName } from '../../src/exitCodes.js';
import { ConditionSpawnError } from '../../src/condition.js';
import { PueueError } from '../../src/pueue.js';
import { readPackageVersion } from '../../src/version.js';
import { done, failed, makeSnapshot, RUNNING, ScriptedClient, StringWriter } from '../helpers/fakes.js';
import type { Snapshot } from '../../src/status.js';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  seen: Options | null;
}

async function cli(
  argv: string[],
  script: Array<Snapshot | Error> = [makeSnapshot([{ id: 1, status: done() }])],
  env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' },
): Promise<CliResult> {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  let seen: Options | null = null;
  const code = await run({
    argv,
    stdout,
    stderr,
    env,
    createClient: (options) => {
      seen = options;
      return new ScriptedClient(script);
    },
  });
  return { code, stdout: stdout.text, stderr: stderr.text, seen };
}

describe('exitCodeName', () => {
  it('names every documented code', () => {
    assert.equal(exitCodeName(EXIT.OK), 'OK');
    assert.equal(exitCodeName(EXIT.TIMEOUT), 'TIMEOUT');
    assert.equal(exitCodeName(EXIT.CONDITION_FAILED), 'CONDITION_FAILED');
    assert.equal(exitCodeName(EXIT.INTERRUPTED), 'INTERRUPTED');
    assert.equal(exitCodeName(EXIT.UNKNOWN_TASKS), 'UNKNOWN_TASKS');
  });

  it('gives every EXIT member a distinct value and a name', () => {
    const values = Object.values(EXIT);
    assert.equal(new Set(values).size, values.length, 'exit codes must be unique');
    for (const value of values) assert.doesNotMatch(exitCodeName(value), /^UNKNOWN\(/);
  });

  it('falls back for an unknown code', () => {
    assert.equal(exitCodeName(99), 'UNKNOWN(99)');
  });
});

describe('run — help and version', () => {
  it('prints help to stdout and exits 0', async () => {
    const { code, stdout, stderr } = await cli(['--help']);
    assert.equal(code, EXIT.OK);
    assert.match(stdout, /Usage:\s+pueue-wait-cond/);
    assert.equal(stderr, '');
  });

  it('prints the package version', async () => {
    const { code, stdout } = await cli(['--version']);
    assert.equal(code, EXIT.OK);
    assert.equal(stdout.trim(), readPackageVersion());
  });
});

describe('run — usage errors', () => {
  it('exits 2 and points at --help', async () => {
    const { code, stdout, stderr } = await cli(['--nonsense']);
    assert.equal(code, EXIT.USAGE);
    assert.equal(stdout, '');
    assert.match(stderr, /^error: /);
    assert.match(stderr, /Run `pueue-wait-cond --help` for usage\./);
  });

  it('exits 2 on a bad status', async () => {
    assert.equal((await cli(['-s', 'nope'])).code, EXIT.USAGE);
  });

  it('exits 2 on conflicting selectors', async () => {
    assert.equal((await cli(['1', '--all'])).code, EXIT.USAGE);
  });
});

describe('run — wiring', () => {
  it('hands the parsed options to the client factory', async () => {
    const { seen } = await cli(['-g', 'build', '--pueue-binary', '/opt/pueue', '--profile', 'ci']);
    assert.deepEqual(seen?.selection, { mode: 'group', group: 'build' });
    assert.equal(seen?.pueueBinary, '/opt/pueue');
    assert.equal(seen?.pueueProfile, 'ci');
  });

  it('reads $PUEUE_BINARY from the injected environment', async () => {
    const { seen } = await cli([], undefined, { PUEUE_BINARY: '/from/env', PATH: '' });
    assert.equal(seen?.pueueBinary, '/from/env');
  });

  it('reports progress by default and stays silent with --quiet', async () => {
    const noisy = await cli([]);
    assert.match(noisy.stdout, /All 1 task\(s\) reached "done"/);
    const quiet = await cli(['--quiet']);
    assert.equal(quiet.stdout, '');
  });

  it('suppresses colour when NO_COLOR is set', async () => {
    const { stdout } = await cli([], undefined, { NO_COLOR: '1', FORCE_COLOR: '1', PATH: '' });
    assert.equal(stdout.includes('['), false);
  });
});

describe('run — outcomes', () => {
  it('exits 0 when the tasks finish', async () => {
    assert.equal((await cli([])).code, EXIT.OK);
  });

  it('exits 1 with --fail-on-error and a failed task', async () => {
    const script = [makeSnapshot([{ id: 1, status: failed(2) }])];
    assert.equal((await cli(['--fail-on-error'], script)).code, EXIT.TASK_FAILURE);
    assert.equal((await cli([], script)).code, EXIT.OK);
  });

  it('exits 3 on timeout', async () => {
    const script = [makeSnapshot([{ id: 1, status: RUNNING }])];
    const { code } = await cli(['--timeout', '0.001', '--interval', '0.001'], script);
    assert.equal(code, EXIT.TIMEOUT);
  });

  it('exits 4 when a --while condition fails', async () => {
    const script = [makeSnapshot([{ id: 1, status: RUNNING }])];
    const { code } = await cli(['--while', 'exit 1'], script);
    assert.equal(code, EXIT.CONDITION_FAILED);
  });

  it('exits 0 when an --until condition passes', async () => {
    const script = [makeSnapshot([{ id: 1, status: RUNNING }])];
    const { code } = await cli(['--until', 'exit 0'], script);
    assert.equal(code, EXIT.OK);
  });

  it('exits 5 when pueue cannot be reached', async () => {
    const { code, stderr } = await cli([], [new PueueError('daemon is down')]);
    assert.equal(code, EXIT.PUEUE_ERROR);
    assert.match(stderr, /error: daemon is down/);
  });

  it('exits 6 when a condition script cannot be run', async () => {
    const script = [makeSnapshot([{ id: 1, status: RUNNING }])];
    const { code, stderr } = await cli(['--until', 'x', '--shell', '/no/such/shell'], script);
    assert.equal(code, EXIT.CONDITION_ERROR);
    assert.match(stderr, /error: Could not run --until condition/);
  });

  it('exits 130 when interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const stdout = new StringWriter();
    const stderr = new StringWriter();
    const code = await run({
      argv: [],
      stdout,
      stderr,
      env: { PATH: process.env.PATH ?? '' },
      signal: controller.signal,
      createClient: () => new ScriptedClient([makeSnapshot([{ id: 1, status: RUNNING }])]),
    });
    assert.equal(code, EXIT.INTERRUPTED);
  });

  it('rethrows anything it does not recognise', async () => {
    await assert.rejects(cli([], [new RangeError('boom')]), RangeError);
  });

  it('classifies a ConditionSpawnError raised from the client path', async () => {
    await assert.rejects(
      (async () => {
        throw new ConditionSpawnError('x', 'nope');
      })(),
      ConditionSpawnError,
    );
  });
});

describe('run — --json', () => {
  const parse = (text: string): Record<string, unknown> =>
    JSON.parse(text) as Record<string, unknown>;

  it('prints one parseable object and no progress lines', async () => {
    const { code, stdout } = await cli(['--json']);
    assert.equal(code, EXIT.OK);
    const json = parse(stdout);
    assert.equal(json.outcome, 'reached');
    assert.equal(json.exitCode, 0);
    assert.equal(stdout.includes('reached "done"'), false, 'progress must not be mixed in');
  });

  it('implies --quiet', async () => {
    const { seen } = await cli(['--json']);
    assert.equal(seen?.quiet, true);
    assert.equal(seen?.json, true);
  });

  it('leaves --quiet off when --json is absent', async () => {
    const { seen } = await cli([]);
    assert.equal(seen?.quiet, false);
    assert.equal(seen?.json, false);
  });

  it('carries the run metadata', async () => {
    const script = [makeSnapshot([{ id: 1, status: RUNNING }]), makeSnapshot([{ id: 1, status: done() }])];
    const { stdout } = await cli(['--json', '--interval', '0.001'], script);
    const json = parse(stdout);
    assert.equal(json.iterations, 2);
    assert.equal(typeof json.elapsedMs, 'number');
    assert.equal(json.targetStatus, 'done');
    assert.deepEqual(json.pendingIds, []);
  });

  it('reports a failed task in failedIds', async () => {
    const { code, stdout } = await cli(['--json', '--fail-on-error'], [
      makeSnapshot([{ id: 1, status: failed(3) }]),
    ]);
    assert.equal(code, EXIT.TASK_FAILURE);
    const json = parse(stdout);
    assert.deepEqual(json.failedIds, [1]);
    assert.equal(json.exitCode, 1);
    assert.deepEqual((json.tasks as Array<Record<string, unknown>>)[0]?.exitCode, 3);
  });

  it('names the condition that ended the wait', async () => {
    const script = [makeSnapshot([{ id: 1, status: RUNNING }])];
    const { stdout } = await cli(['--json', '--until', 'exit 0', '--interval', '0.001'], script);
    const json = parse(stdout);
    assert.equal(json.outcome, 'until');
    assert.deepEqual(json.condition, { kind: 'until', value: 'exit 0', exitCode: 0 });
  });

  it('reports a usage error as JSON on stdout', async () => {
    const { code, stdout, stderr } = await cli(['--json', '--nonsense']);
    assert.equal(code, EXIT.USAGE);
    assert.equal(stderr, '');
    const json = parse(stdout);
    assert.equal(json.outcome, 'error');
    assert.equal(json.exitCode, 2);
    assert.equal((json.error as Record<string, unknown>).kind, 'usage');
  });

  it('reports a pueue error as JSON', async () => {
    const { code, stdout } = await cli(['--json'], [new PueueError('daemon is down')]);
    assert.equal(code, EXIT.PUEUE_ERROR);
    const json = parse(stdout);
    assert.equal(json.outcome, 'error');
    assert.equal((json.error as Record<string, unknown>).kind, 'pueue');
    assert.match(String((json.error as Record<string, unknown>).message), /daemon is down/);
  });

  it('reports a condition spawn error as JSON', async () => {
    const script = [makeSnapshot([{ id: 1, status: RUNNING }])];
    const { code, stdout } = await cli(
      ['--json', '--until', 'x', '--shell', '/no/such/shell'],
      script,
    );
    assert.equal(code, EXIT.CONDITION_ERROR);
    assert.equal((parse(stdout).error as Record<string, unknown>).kind, 'condition');
  });

  it('still prints prose errors without --json', async () => {
    const { stdout, stderr } = await cli([], [new PueueError('daemon is down')]);
    assert.equal(stdout, '');
    assert.match(stderr, /error: daemon is down/);
  });
});

describe('readPackageVersion', () => {
  it('finds the manifest from the source tree', () => {
    assert.match(readPackageVersion(), /^\d+\.\d+\.\d+/);
  });

  it('falls back when there is no manifest above the start directory', () => {
    assert.equal(readPackageVersion('/'), '0.0.0');
  });
});
