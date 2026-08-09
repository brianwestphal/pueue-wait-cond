import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { helpText, parseCliArgs, parseDuration, UsageError } from '../../src/args.js';
import type { Options } from '../../src/args.js';

function opts(argv: string[], env: NodeJS.ProcessEnv = {}): Options {
  const result = parseCliArgs(argv, env);
  assert.equal(result.kind, 'run');
  if (result.kind !== 'run') throw new Error('unreachable');
  return result.options;
}

describe('parseDuration', () => {
  it('treats a bare number as seconds', () => {
    assert.equal(parseDuration('30', '--timeout'), 30_000);
    assert.equal(parseDuration('0.5', '--timeout'), 500);
    assert.equal(parseDuration('.25', '--timeout'), 250);
  });

  it('accepts unit suffixes', () => {
    assert.equal(parseDuration('750ms', '--timeout'), 750);
    assert.equal(parseDuration('45s', '--timeout'), 45_000);
    assert.equal(parseDuration('2m', '--timeout'), 120_000);
    assert.equal(parseDuration('1h', '--timeout'), 3_600_000);
    assert.equal(parseDuration('3 min', '--timeout'), 180_000);
    assert.equal(parseDuration('2HRS', '--timeout'), 7_200_000);
  });

  it('rounds to whole milliseconds', () => {
    assert.equal(parseDuration('0.0005', '--timeout'), 1);
  });

  it('rejects nonsense', () => {
    assert.throws(() => parseDuration('soon', '--timeout'), UsageError);
    assert.throws(() => parseDuration('', '--timeout'), UsageError);
    assert.throws(() => parseDuration('-5', '--timeout'), UsageError);
    assert.throws(() => parseDuration('5 5', '--timeout'), UsageError);
  });

  it('rejects unknown units', () => {
    assert.throws(() => parseDuration('5d', '--timeout'), /unknown duration unit "d"/);
  });

  it('rejects a number too large to represent', () => {
    // Digits alone still match the pattern, but overflow to Infinity.
    assert.throws(() => parseDuration('9'.repeat(400), '--timeout'), /expects a duration in seconds/);
  });
});

describe('parseCliArgs — help and version', () => {
  it('returns help for -h and --help', () => {
    for (const flag of ['-h', '--help']) {
      const result = parseCliArgs([flag]);
      assert.equal(result.kind, 'help');
      if (result.kind === 'help') assert.match(result.text, /Usage:\s+pueue-wait-cond/);
    }
  });

  it('returns version for -V and --version', () => {
    for (const flag of ['-V', '--version']) {
      assert.equal(parseCliArgs([flag]).kind, 'version');
    }
  });

  it('prefers help over version', () => {
    assert.equal(parseCliArgs(['--version', '--help']).kind, 'help');
  });

  it('documents every exit code in the help text', () => {
    const text = helpText();
    for (const code of ['0', '1', '2', '3', '4', '5', '6']) {
      assert.match(text, new RegExp(`^ {2}${code} {2}`, 'm'), `exit code ${code}`);
    }
  });
});

describe('parseCliArgs — selection', () => {
  it('defaults to the default group', () => {
    assert.deepEqual(opts([]).selection, { mode: 'group', group: 'default' });
  });

  it('takes positional task ids', () => {
    assert.deepEqual(opts(['3', '1', '2']).selection, { mode: 'ids', ids: [1, 2, 3] });
  });

  it('de-duplicates task ids', () => {
    assert.deepEqual(opts(['5', '5', '5']).selection, { mode: 'ids', ids: [5] });
  });

  it('accepts --group', () => {
    assert.deepEqual(opts(['-g', 'build']).selection, { mode: 'group', group: 'build' });
  });

  it('accepts --all', () => {
    assert.deepEqual(opts(['--all']).selection, { mode: 'all' });
  });

  it('rejects combining selectors', () => {
    assert.throws(() => opts(['1', '-g', 'x']), /mutually exclusive/);
    assert.throws(() => opts(['1', '-a']), /mutually exclusive/);
    assert.throws(() => opts(['-a', '-g', 'x']), /mutually exclusive/);
  });

  it('rejects an empty group name', () => {
    assert.throws(() => opts(['-g', '  ']), /non-empty group name/);
  });

  it('rejects non-numeric task ids', () => {
    assert.throws(() => opts(['abc']), /Task ids must be non-negative integers/);
    assert.throws(() => opts(['-1']), UsageError);
    assert.throws(() => opts(['1.5']), /Task ids must be non-negative integers/);
  });

  it('accepts task id zero', () => {
    assert.deepEqual(opts(['0']).selection, { mode: 'ids', ids: [0] });
  });
});

describe('parseCliArgs — wait target', () => {
  it('defaults to done', () => {
    assert.equal(opts([]).targetStatus, 'done');
  });

  it('accepts each documented status, case-insensitively', () => {
    assert.equal(opts(['-s', 'Success']).targetStatus, 'success');
    assert.equal(opts(['--status', 'RUNNING']).targetStatus, 'running');
  });

  it('rejects an unknown status', () => {
    assert.throws(() => opts(['-s', 'finished']), /expected one of/);
  });

  it('reads --fail-on-error', () => {
    assert.equal(opts([]).failOnError, false);
    assert.equal(opts(['--fail-on-error']).failOnError, true);
  });
});

describe('parseCliArgs — timing', () => {
  it('defaults to no timeout and a 2s interval', () => {
    const o = opts([]);
    assert.equal(o.timeoutMs, null);
    assert.equal(o.intervalMs, 2_000);
    assert.equal(o.conditionTimeoutMs, 30_000);
  });

  it('parses --timeout, --interval and --condition-timeout', () => {
    const o = opts(['-t', '60', '-i', '0.5', '--condition-timeout', '5']);
    assert.equal(o.timeoutMs, 60_000);
    assert.equal(o.intervalMs, 500);
    assert.equal(o.conditionTimeoutMs, 5_000);
  });

  it('rejects non-positive durations', () => {
    assert.throws(() => opts(['-t', '0']), /--timeout must be greater than zero/);
    assert.throws(() => opts(['-i', '0']), /--interval must be greater than zero/);
    assert.throws(() => opts(['--condition-timeout', '0']), /--condition-timeout must be greater than zero/);
  });
});

describe('parseCliArgs — --task-grace', () => {
  it('defaults to 5 seconds', () => {
    assert.equal(opts([]).taskGraceMs, 5_000);
  });

  it('parses a duration', () => {
    assert.equal(opts(['--task-grace', '30']).taskGraceMs, 30_000);
    assert.equal(opts(['--task-grace', '250ms']).taskGraceMs, 250);
  });

  it('accepts zero, meaning fail on the first poll', () => {
    assert.equal(opts(['--task-grace', '0']).taskGraceMs, 0);
  });

  it('accepts "forever", meaning never give up', () => {
    assert.equal(opts(['--task-grace', 'forever']).taskGraceMs, null);
    assert.equal(opts(['--task-grace', '  FOREVER  ']).taskGraceMs, null);
  });

  it('rejects nonsense', () => {
    assert.throws(() => opts(['--task-grace', 'soon']), /--task-grace expects a duration/);
    assert.throws(() => opts(['--task-grace', 'forevr']), /--task-grace expects a duration/);
    // Negatives never reach a range check: the duration pattern admits no sign,
    // so `-1` is taken as an unknown option and rejected during parsing.
    assert.throws(() => opts(['--task-grace', '-1']), UsageError);
  });
});

describe('parseCliArgs — conditions', () => {
  it('defaults to no conditions', () => {
    assert.deepEqual(opts([]).until, []);
    assert.deepEqual(opts([]).while, []);
  });

  it('collects repeated --until and --while', () => {
    const o = opts(['-u', 'a.sh', '--until', 'b.sh', '-w', 'c.sh', '--while', 'd.sh']);
    assert.deepEqual(o.until, ['a.sh', 'b.sh']);
    assert.deepEqual(o.while, ['c.sh', 'd.sh']);
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(opts(['-u', '  ./go.sh  ']).until, ['./go.sh']);
  });

  it('rejects an empty condition', () => {
    assert.throws(() => opts(['-u', '   ']), /--until expects a script path/);
    assert.throws(() => opts(['-w', '']), /--while expects a script path/);
  });
});

describe('parseCliArgs — pueue plumbing', () => {
  it('defaults the binary to pueue', () => {
    assert.equal(opts([]).pueueBinary, 'pueue');
  });

  it('reads $PUEUE_BINARY', () => {
    assert.equal(opts([], { PUEUE_BINARY: '/opt/pueue' }).pueueBinary, '/opt/pueue');
  });

  it('lets --pueue-binary win over the environment', () => {
    assert.equal(opts(['--pueue-binary', '/a'], { PUEUE_BINARY: '/b' }).pueueBinary, '/a');
  });

  it('passes --config and --profile through', () => {
    const o = opts(['--config', '/c.toml', '--profile', 'ci']);
    assert.equal(o.pueueConfig, '/c.toml');
    assert.equal(o.pueueProfile, 'ci');
  });

  it('defaults the shell to /bin/sh and honours --shell', () => {
    assert.equal(opts([]).shell, '/bin/sh');
    assert.equal(opts(['--shell', '/bin/bash']).shell, '/bin/bash');
  });
});

describe('parseCliArgs — misc', () => {
  it('reads --quiet', () => {
    assert.equal(opts([]).quiet, false);
    assert.equal(opts(['-q']).quiet, true);
  });

  it('wraps parse failures as UsageError', () => {
    assert.throws(() => opts(['--nope']), UsageError);
    assert.throws(() => opts(['--group']), UsageError);
  });

  it('allows options after positionals', () => {
    const o = opts(['7', '--timeout', '5']);
    assert.deepEqual(o.selection, { mode: 'ids', ids: [7] });
    assert.equal(o.timeoutMs, 5_000);
  });
});
