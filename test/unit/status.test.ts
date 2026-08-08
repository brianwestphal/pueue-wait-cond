import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeStatus,
  hasReached,
  isFailure,
  isFinished,
  isSuccess,
  isTargetStatus,
  isUnreachable,
  parseSnapshot,
  PueueParseError,
  TARGET_STATUSES,
} from '../../src/status.js';
import type { TargetStatus, TaskState } from '../../src/status.js';
import { done, failed, LOCKED, makeSnapshot, PAUSED, QUEUED, RUNNING, STASHED } from '../helpers/fakes.js';

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 1,
    group: 'default',
    label: null,
    command: 'true',
    kind: 'Queued',
    result: null,
    exitCode: null,
    ...overrides,
  };
}

describe('parseSnapshot', () => {
  it('flattens bare-string status variants', () => {
    const snap = makeSnapshot([{ id: 1, status: QUEUED }]);
    assert.equal(snap.tasks.get(1)?.kind, 'Queued');
    assert.equal(snap.tasks.get(1)?.result, null);
  });

  it('flattens object status variants', () => {
    const snap = makeSnapshot([{ id: 2, status: RUNNING }]);
    assert.equal(snap.tasks.get(2)?.kind, 'Running');
  });

  it('extracts the Done result', () => {
    const snap = makeSnapshot([{ id: 3, status: done('Success') }]);
    assert.equal(snap.tasks.get(3)?.kind, 'Done');
    assert.equal(snap.tasks.get(3)?.result, 'Success');
    assert.equal(snap.tasks.get(3)?.exitCode, null);
  });

  it('extracts the exit code from a Failed result', () => {
    const snap = makeSnapshot([{ id: 4, status: failed(7) }]);
    assert.equal(snap.tasks.get(4)?.result, 'Failed');
    assert.equal(snap.tasks.get(4)?.exitCode, 7);
  });

  it('handles Killed and DependencyFailed results', () => {
    const snap = makeSnapshot([
      { id: 5, status: done('Killed') },
      { id: 6, status: done('DependencyFailed') },
    ]);
    assert.equal(snap.tasks.get(5)?.result, 'Killed');
    assert.equal(snap.tasks.get(5)?.exitCode, null);
    assert.equal(snap.tasks.get(6)?.result, 'DependencyFailed');
  });

  it('ignores a result variant it cannot recognise', () => {
    const snap = parseSnapshot({
      tasks: { a: { id: 1, status: { Done: { result: { A: 1, B: 2 } } } } },
    });
    assert.equal(snap.tasks.get(1)?.kind, 'Done');
    assert.equal(snap.tasks.get(1)?.result, null);
    assert.equal(snap.tasks.get(1)?.exitCode, null);
  });

  it('tolerates a non-numeric Failed payload', () => {
    const snap = parseSnapshot({
      tasks: { a: { id: 1, status: { Done: { result: { Failed: 'boom' } } } } },
    });
    assert.equal(snap.tasks.get(1)?.result, 'Failed');
    assert.equal(snap.tasks.get(1)?.exitCode, null);
  });

  it('tolerates a Done payload with no result at all', () => {
    const snap = parseSnapshot({ tasks: { a: { id: 1, status: { Done: { start: 'x' } } } } });
    assert.equal(snap.tasks.get(1)?.kind, 'Done');
    assert.equal(snap.tasks.get(1)?.result, null);
  });

  it('keeps group, label and command', () => {
    const snap = makeSnapshot([
      { id: 7, status: QUEUED, group: 'build', label: 'lbl', command: 'make' },
    ]);
    const t = snap.tasks.get(7);
    assert.equal(t?.group, 'build');
    assert.equal(t?.label, 'lbl');
    assert.equal(t?.command, 'make');
  });

  it('parses the groups map', () => {
    const snap = makeSnapshot([], { alpha: { status: 'Paused', parallel_tasks: 4 } });
    assert.deepEqual(snap.groups.get('alpha'), { status: 'Paused', parallelTasks: 4 });
  });

  it('tolerates a missing groups key', () => {
    const snap = parseSnapshot({ tasks: {} });
    assert.equal(snap.groups.size, 0);
  });

  it('skips entries that are not task objects', () => {
    const snap = parseSnapshot({ tasks: { a: null, b: 5, c: { id: 9, status: QUEUED } } });
    assert.deepEqual([...snap.tasks.keys()], [9]);
  });

  it('skips tasks without a numeric id', () => {
    const snap = parseSnapshot({ tasks: { a: { id: 'x', status: QUEUED } } });
    assert.equal(snap.tasks.size, 0);
  });

  it('falls back to sane defaults for missing fields', () => {
    const snap = parseSnapshot({ tasks: { a: { id: 1 } } });
    const t = snap.tasks.get(1);
    assert.equal(t?.group, 'default');
    assert.equal(t?.label, null);
    assert.equal(t?.command, '');
    assert.equal(t?.kind, 'Unknown');
  });

  it('treats a multi-key status object as Unknown', () => {
    const snap = parseSnapshot({ tasks: { a: { id: 1, status: { A: 1, B: 2 } } } });
    assert.equal(snap.tasks.get(1)?.kind, 'Unknown');
  });

  it('tolerates a non-object group entry', () => {
    const snap = parseSnapshot({ tasks: {}, groups: { g: null } });
    assert.deepEqual(snap.groups.get('g'), { status: 'Unknown', parallelTasks: 0 });
  });

  it('rejects non-object payloads', () => {
    assert.throws(() => parseSnapshot('nope'), PueueParseError);
    assert.throws(() => parseSnapshot(null), PueueParseError);
  });

  it('rejects payloads with no tasks object', () => {
    assert.throws(() => parseSnapshot({ groups: {} }), PueueParseError);
    assert.throws(() => parseSnapshot({ tasks: 'x' }), PueueParseError);
  });
});

describe('isTargetStatus', () => {
  it('accepts every documented status', () => {
    for (const s of TARGET_STATUSES) assert.equal(isTargetStatus(s), true);
  });

  it('rejects anything else', () => {
    assert.equal(isTargetStatus('finished'), false);
    assert.equal(isTargetStatus(''), false);
  });
});

describe('hasReached', () => {
  // The full status × target matrix. `true` means "stop waiting".
  const kinds: Array<[string, TaskState]> = [
    ['Queued', task({ kind: 'Queued' })],
    ['Running', task({ kind: 'Running' })],
    ['Success', task({ kind: 'Done', result: 'Success' })],
    ['Failed', task({ kind: 'Done', result: 'Failed', exitCode: 2 })],
    ['Killed', task({ kind: 'Done', result: 'Killed' })],
    ['Stashed', task({ kind: 'Stashed' })],
    ['Paused', task({ kind: 'Paused' })],
    ['Locked', task({ kind: 'Locked' })],
    ['Unknown', task({ kind: 'Unknown' })],
  ];

  const expected: Record<string, Partial<Record<TargetStatus, boolean>>> = {
    Queued: { queued: true, running: false, done: false, success: false, failed: false, stashed: false, paused: false, locked: false },
    Running: { queued: true, running: true, done: false, success: false, failed: false, stashed: false, paused: false, locked: false },
    Success: { queued: true, running: true, done: true, success: true, failed: false, stashed: false, paused: false, locked: false },
    Failed: { queued: true, running: true, done: true, success: false, failed: true, stashed: false, paused: false, locked: false },
    Killed: { queued: true, running: true, done: true, success: false, failed: true, stashed: false, paused: false, locked: false },
    Stashed: { queued: false, running: false, done: false, success: false, failed: false, stashed: true, paused: false, locked: false },
    Paused: { queued: false, running: false, done: false, success: false, failed: false, stashed: false, paused: true, locked: false },
    Locked: { queued: false, running: false, done: false, success: false, failed: false, stashed: false, paused: false, locked: true },
    Unknown: { queued: false, running: false, done: false, success: false, failed: false, stashed: false, paused: false, locked: false },
  };

  for (const [name, state] of kinds) {
    for (const target of TARGET_STATUSES) {
      it(`${name} vs --status ${target}`, () => {
        assert.equal(hasReached(state, target), expected[name]?.[target]);
      });
    }
  }

  it('lets a task that raced past Running still satisfy --status running', () => {
    assert.equal(hasReached(task({ kind: 'Done', result: 'Success' }), 'running'), true);
  });
});

describe('isUnreachable', () => {
  it('is false for anything still in flight', () => {
    for (const kind of ['Queued', 'Running', 'Stashed', 'Paused', 'Locked']) {
      assert.equal(isUnreachable(task({ kind }), 'success'), false, kind);
    }
  });

  it('flags a failed task waiting for success', () => {
    assert.equal(isUnreachable(task({ kind: 'Done', result: 'Failed', exitCode: 1 }), 'success'), true);
  });

  it('flags a successful task waiting for failure', () => {
    assert.equal(isUnreachable(task({ kind: 'Done', result: 'Success' }), 'failed'), true);
  });

  it('does not flag a finished task for reachable targets', () => {
    const t = task({ kind: 'Done', result: 'Success' });
    assert.equal(isUnreachable(t, 'done'), false);
    assert.equal(isUnreachable(t, 'success'), false);
    // Restartable, so we keep waiting rather than declaring it impossible.
    assert.equal(isUnreachable(t, 'queued'), false);
    assert.equal(isUnreachable(t, 'stashed'), false);
  });
});

describe('isFinished / isSuccess / isFailure', () => {
  it('classifies terminal states', () => {
    const ok = task({ kind: 'Done', result: 'Success' });
    const bad = task({ kind: 'Done', result: 'Failed', exitCode: 3 });
    const running = task({ kind: 'Running' });

    assert.equal(isFinished(ok), true);
    assert.equal(isFinished(running), false);
    assert.equal(isSuccess(ok), true);
    assert.equal(isSuccess(bad), false);
    assert.equal(isFailure(bad), true);
    assert.equal(isFailure(ok), false);
    assert.equal(isFailure(running), false);
  });
});

describe('describeStatus', () => {
  it('renders in-flight states verbatim', () => {
    assert.equal(describeStatus(task({ kind: 'Running' })), 'Running');
  });

  it('renders success plainly', () => {
    assert.equal(describeStatus(task({ kind: 'Done', result: 'Success' })), 'Success');
  });

  it('renders a failure with its exit code', () => {
    assert.equal(describeStatus(task({ kind: 'Done', result: 'Failed', exitCode: 9 })), 'Failed(9)');
  });

  it('renders a code-less failure by result name', () => {
    assert.equal(describeStatus(task({ kind: 'Done', result: 'Killed' })), 'Killed');
  });

  it('renders a result-less Done', () => {
    assert.equal(describeStatus(task({ kind: 'Done', result: null })), 'Done');
  });
});

describe('status fixture coverage', () => {
  it('parses every off-line variant used by the fixtures', () => {
    const snap = makeSnapshot([
      { id: 1, status: STASHED },
      { id: 2, status: PAUSED },
      { id: 3, status: LOCKED },
    ]);
    assert.equal(snap.tasks.get(1)?.kind, 'Stashed');
    assert.equal(snap.tasks.get(2)?.kind, 'Paused');
    assert.equal(snap.tasks.get(3)?.kind, 'Locked');
  });
});
