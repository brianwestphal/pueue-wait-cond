import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Reporter, shouldUseColor } from '../../src/reporter.js';
import type { TaskState } from '../../src/status.js';
import { makeReporter, StringWriter } from '../helpers/fakes.js';

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 5,
    group: 'default',
    label: null,
    command: 'true',
    kind: 'Queued',
    result: null,
    exitCode: null,
    ...overrides,
  };
}

describe('shouldUseColor', () => {
  it('follows the TTY by default', () => {
    assert.equal(shouldUseColor({ isTTY: true }, {}), true);
    assert.equal(shouldUseColor({ isTTY: false }, {}), false);
    assert.equal(shouldUseColor({}, {}), false);
  });

  it('honours NO_COLOR over everything', () => {
    assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' }), false);
    assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: '', FORCE_COLOR: '1' }), true);
  });

  it('honours FORCE_COLOR without a TTY', () => {
    assert.equal(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
    assert.equal(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '0' }), false);
    assert.equal(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '' }), false);
  });
});

describe('Reporter', () => {
  it('stamps progress lines with the wall clock', () => {
    const { out, reporter } = makeReporter();
    reporter.taskFinished(task({ kind: 'Done', result: 'Success' }));
    assert.equal(out.text, '12:00:00 - Task 5 succeeded with 0\n');
  });

  it('zero-pads the timestamp', () => {
    const out = new StringWriter();
    const reporter = new Reporter({
      quiet: false,
      out,
      err: new StringWriter(),
      color: false,
      now: () => new Date(2026, 0, 1, 4, 5, 6),
    });
    reporter.taskFinished(task({ kind: 'Done', result: 'Success' }));
    assert.match(out.text, /^04:05:06 - /);
  });

  it('renders a failure with its exit code', () => {
    const { out, reporter } = makeReporter();
    reporter.taskFinished(task({ kind: 'Done', result: 'Failed', exitCode: 7 }));
    assert.match(out.text, /Task 5 failed with 7\n$/);
  });

  it('renders a code-less failure by result name', () => {
    const { out, reporter } = makeReporter();
    reporter.taskFinished(task({ kind: 'Done', result: 'Killed' }));
    assert.match(out.text, /Task 5 failed with Killed\n$/);
  });

  it('renders a result-less Done as unknown', () => {
    const { out, reporter } = makeReporter();
    reporter.taskFinished(task({ kind: 'Done', result: null }));
    assert.match(out.text, /failed with unknown\n$/);
  });

  it('reports a status transition', () => {
    const { out, reporter } = makeReporter();
    reporter.taskChanged(task({ kind: 'Queued' }), task({ kind: 'Running' }));
    assert.match(out.text, /Task 5 changed from Queued to Running\n$/);
  });

  it('collapses a transition into Done to the finished line', () => {
    const { out, reporter } = makeReporter();
    reporter.taskChanged(task({ kind: 'Running' }), task({ kind: 'Done', result: 'Success' }));
    assert.match(out.text, /Task 5 succeeded with 0\n$/);
    assert.equal(out.text.includes('changed from'), false);
  });

  it('says nothing when the status is unchanged', () => {
    const { out, reporter } = makeReporter();
    reporter.taskChanged(task({ kind: 'Running' }), task({ kind: 'Running' }));
    assert.equal(out.text, '');
  });

  it('says nothing for a task it has not seen before', () => {
    const { out, reporter } = makeReporter();
    reporter.taskChanged(undefined, task({ kind: 'Running' }));
    assert.equal(out.text, '');
  });

  it('reports a Done → Done result change', () => {
    const { out, reporter } = makeReporter();
    reporter.taskChanged(
      task({ kind: 'Done', result: 'Success' }),
      task({ kind: 'Done', result: 'Failed', exitCode: 1 }),
    );
    assert.match(out.text, /changed from Success to Failed\(1\)\n$/);
  });

  it('summarises the tasks being watched', () => {
    const { out, reporter } = makeReporter();
    reporter.watching([task({ id: 1, kind: 'Queued' }), task({ id: 2, kind: 'Running' })]);
    assert.match(out.text, /Waiting on 2 task\(s\): 1 \(Queued\), 2 \(Running\)\n$/);
  });

  it('says nothing when there is nothing to watch', () => {
    const { out, reporter } = makeReporter();
    reporter.watching([]);
    assert.equal(out.text, '');
  });

  it('still reports tasks that finished before the first poll', () => {
    const { out, reporter } = makeReporter();
    reporter.watching([
      task({ id: 1, kind: 'Done', result: 'Failed', exitCode: 7 }),
      task({ id: 2, kind: 'Running' }),
      task({ id: 3, kind: 'Done', result: 'Success' }),
    ]);
    assert.match(out.text, /Task 1 failed with 7/);
    assert.match(out.text, /Task 3 succeeded with 0/);
    assert.equal(out.text.includes('Task 2 succeeded'), false);
    assert.equal(out.text.includes('Task 2 failed'), false);
  });

  it('describes condition results', () => {
    const { out, reporter } = makeReporter();
    reporter.conditionResult('until', 'check.sh', { exitCode: 1, signal: null, timedOut: false });
    reporter.conditionResult('while', 'guard.sh', { exitCode: null, signal: null, timedOut: true });
    reporter.conditionResult('while', 'g2.sh', { exitCode: null, signal: 'SIGKILL', timedOut: false });
    reporter.conditionResult('while', 'g3.sh', { exitCode: null, signal: null, timedOut: false });
    const lines = out.lines;
    assert.match(lines[0] ?? '', /--until condition "check\.sh" exit 1/);
    assert.match(lines[1] ?? '', /--while condition "guard\.sh" timed out/);
    assert.match(lines[2] ?? '', /--while condition "g2\.sh" killed by SIGKILL/);
    assert.match(lines[3] ?? '', /--while condition "g3\.sh" killed by signal/);
  });

  it('prefixes condition output on stderr', () => {
    const { out, err, reporter } = makeReporter();
    reporter.conditionOutput('until', 'c.sh', 'one\ntwo\n', 'three\n');
    assert.equal(out.text, '');
    assert.deepEqual(err.lines, ['[--until c.sh] one', '[--until c.sh] two', '[--until c.sh] three']);
  });

  it('says nothing for silent conditions', () => {
    const { err, reporter } = makeReporter();
    reporter.conditionOutput('until', 'c.sh', '', '   \n');
    assert.equal(err.text, '');
  });

  it('reports the terminal outcomes', () => {
    const { out, reporter } = makeReporter();
    reporter.untilSatisfied('go.sh');
    reporter.whileViolated('guard.sh', 3);
    reporter.whileViolated('guard.sh', null);
    reporter.timedOut(1_500, [4, 5]);
    reporter.timedOut(1_500, []);
    reporter.allReached('done', 2);
    const text = out.text;
    assert.match(text, /--until condition "go\.sh" satisfied; done waiting/);
    assert.match(text, /--while condition "guard\.sh" failed \(exit 3\); giving up/);
    assert.match(text, /--while condition "guard\.sh" failed \(killed by signal\); giving up/);
    assert.match(text, /Timed out after 1\.500s\. Still waiting on: 4, 5\./);
    assert.match(text, /Timed out after 1\.500s\.\n/);
    assert.match(text, /All 2 task\(s\) reached "done"/);
  });

  it('suppresses progress but not errors when quiet', () => {
    const { out, err, reporter } = makeReporter(true);
    reporter.taskFinished(task({ kind: 'Done', result: 'Success' }));
    reporter.watching([task()]);
    reporter.warn('a warning');
    reporter.conditionOutput('until', 'c.sh', 'noisy\n', '');
    reporter.error('an error');
    assert.equal(out.text, '');
    assert.equal(err.text, 'an error\n');
  });

  it('emits ANSI codes only when colour is on', () => {
    const plain = new StringWriter();
    const colored = new StringWriter();
    const at = () => new Date(2026, 0, 1, 12, 0, 0);
    new Reporter({ quiet: false, out: plain, err: plain, color: false, now: at }).taskFinished(
      task({ kind: 'Done', result: 'Success' }),
    );
    new Reporter({ quiet: false, out: colored, err: colored, color: true, now: at }).taskFinished(
      task({ kind: 'Done', result: 'Success' }),
    );
    assert.equal(plain.text.includes('['), false);
    assert.equal(colored.text.includes('['), true);
  });

  it('defaults its clock to the real one', () => {
    const out = new StringWriter();
    const reporter = new Reporter({ quiet: false, out, err: new StringWriter(), color: false });
    reporter.allReached('done', 1);
    assert.match(out.text, /^\d{2}:\d{2}:\d{2} - /);
  });
});
