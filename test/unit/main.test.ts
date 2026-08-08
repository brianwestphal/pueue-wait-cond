/**
 * In-process coverage of `main()` and of `run()`'s real pueue client factory.
 *
 * `test/e2e/cli.test.ts` exercises the same paths through the shipped binary,
 * but that runs in a child process; driving them here keeps them visible to the
 * coverage report and pins the `process.exitCode` contract.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { run, main } from '../../src/cli.js';
import { EXIT } from '../../src/exitCodes.js';
import { StringWriter } from '../helpers/fakes.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwc-main-test-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakePueue(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

/** Run `main()` with a stubbed argv and captured stdout/stderr. */
async function withMain(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const realArgv = process.argv;
  const realExitCode = process.exitCode;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';

  process.argv = [realArgv[0] ?? 'node', 'pueue-wait-cond', ...argv];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    await main();
    return { code: Number(process.exitCode ?? 0), stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.argv = realArgv;
    process.exitCode = realExitCode;
  }
}

afterEach(() => {
  // `main()` cleans up after itself; assert it so a leak fails loudly rather
  // than slowly accumulating handlers across the suite.
  assert.equal(process.listenerCount('SIGINT') <= 1, true);
});

describe('run — real pueue client factory', () => {
  it('drives the pueue binary named on the command line', async () => {
    const binary = fakePueue('real-factory', `echo '{"tasks":{"1":{"id":1,"status":{"Done":{"result":"Success"}}}},"groups":{}}'`);
    const stdout = new StringWriter();
    const stderr = new StringWriter();
    const code = await run({
      argv: ['--pueue-binary', binary],
      stdout,
      stderr,
      env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(code, EXIT.OK);
    assert.match(stdout.text, /All 1 task\(s\) reached "done"/);
  });

  it('reports a missing binary through the real client', async () => {
    const stdout = new StringWriter();
    const stderr = new StringWriter();
    const code = await run({
      argv: ['--pueue-binary', join(dir, 'absent')],
      stdout,
      stderr,
      env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(code, EXIT.PUEUE_ERROR);
    assert.match(stderr.text, /Could not find the pueue binary/);
  });
});

describe('main', () => {
  it('sets exitCode 0 and prints the version', async () => {
    const { code, stdout } = await withMain(['--version']);
    assert.equal(code, EXIT.OK);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it('sets exitCode 2 on a usage error', async () => {
    const { code, stderr } = await withMain(['--not-a-flag']);
    assert.equal(code, EXIT.USAGE);
    assert.match(stderr, /error:/);
  });

  it('sets exitCode 0 when the wait completes', async () => {
    const binary = fakePueue('main-ok', `echo '{"tasks":{},"groups":{}}'`);
    const { code } = await withMain(['--pueue-binary', binary, '--quiet']);
    assert.equal(code, EXIT.OK);
  });

  it('sets exitCode 5 when pueue is unreachable', async () => {
    const binary = fakePueue('main-down', 'echo "no daemon" >&2; exit 1');
    const { code } = await withMain(['--pueue-binary', binary, '--quiet']);
    assert.equal(code, EXIT.PUEUE_ERROR);
  });

  it('sets exitCode 130 when SIGINT arrives mid-wait', async () => {
    const binary = fakePueue(
      'main-sigint',
      `echo '{"tasks":{"1":{"id":1,"status":{"Running":{}}}},"groups":{}}'`,
    );
    const pending = withMain(['--pueue-binary', binary, '--quiet', '--interval', '30']);
    // Give the loop time to reach its first sleep, then deliver the signal the
    // same way the runtime would.
    await new Promise((r) => setTimeout(r, 300));
    process.emit('SIGINT');
    const { code } = await pending;
    assert.equal(code, EXIT.INTERRUPTED);
  });

  it('removes its signal handlers when it returns', async () => {
    const before = process.listenerCount('SIGINT');
    await withMain(['--version']);
    assert.equal(process.listenerCount('SIGINT'), before);
  });

  it('reports an unexpected crash instead of throwing', async () => {
    // Break stdout so the `--version` write blows up inside run().
    const realOut = process.stdout.write.bind(process.stdout);
    const realArgv = process.argv;
    const realExitCode = process.exitCode;
    let stderr = '';
    const realErr = process.stderr.write.bind(process.stderr);

    process.argv = [realArgv[0] ?? 'node', 'pueue-wait-cond', '--version'];
    process.exitCode = undefined;
    process.stdout.write = (() => {
      throw new Error('stdout exploded');
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await main();
      assert.equal(process.exitCode, EXIT.PUEUE_ERROR);
      assert.match(stderr, /stdout exploded/);
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      process.argv = realArgv;
      process.exitCode = realExitCode;
    }
  });
});
