import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildJsonError, buildJsonResult, renderJson } from '../../src/json.js';
import type { JsonResult } from '../../src/json.js';
import { EXIT } from '../../src/exitCodes.js';
import type { TaskState } from '../../src/status.js';
import type { WaitMeta, WaitOutcome, WaitResolution } from '../../src/wait.js';

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 4,
    group: 'default',
    label: null,
    command: 'make',
    kind: 'Done',
    result: 'Success',
    exitCode: null,
    ...overrides,
  };
}

function meta(overrides: Partial<WaitMeta> = {}): WaitMeta {
  return {
    elapsedMs: 12_500,
    iterations: 6,
    targetStatus: 'done',
    group: null,
    tasks: [task()],
    pendingIds: [],
    failedIds: [],
    ...overrides,
  };
}

function resolve(outcome: WaitOutcome, metaOverrides: Partial<WaitMeta> = {}): WaitResolution {
  return { ...outcome, meta: meta(metaOverrides) } as WaitResolution;
}

describe('buildJsonResult', () => {
  it('renders a completed wait', () => {
    const json = buildJsonResult(resolve({ kind: 'reached', tasks: [], failed: [] }), EXIT.OK);
    assert.equal(json.outcome, 'reached');
    assert.equal(json.exitCode, 0);
    assert.equal(json.elapsedMs, 12_500);
    assert.equal(json.iterations, 6);
    assert.equal(json.targetStatus, 'done');
    assert.equal(json.group, null);
    assert.equal(json.condition, null);
    assert.deepEqual(json.unknownIds, []);
  });

  it('flattens tasks into a stable shape', () => {
    const json = buildJsonResult(
      resolve({ kind: 'reached', tasks: [], failed: [] }, {
        tasks: [task({ id: 9, label: 'build', kind: 'Done', result: 'Failed', exitCode: 3 })],
      }),
      EXIT.TASK_FAILURE,
    );
    assert.deepEqual(json.tasks, [
      {
        id: 9,
        group: 'default',
        label: 'build',
        command: 'make',
        status: 'Done',
        result: 'Failed',
        exitCode: 3,
      },
    ]);
  });

  it('never leaks the pueue task environment', () => {
    const json = buildJsonResult(resolve({ kind: 'reached', tasks: [], failed: [] }), EXIT.OK);
    assert.equal(JSON.stringify(json).includes('envs'), false);
  });

  it('reports the --until condition that ended the wait', () => {
    const json = buildJsonResult(resolve({ kind: 'until', value: './ready.sh' }), EXIT.OK);
    assert.equal(json.outcome, 'until');
    assert.deepEqual(json.condition, { kind: 'until', value: './ready.sh', exitCode: 0 });
  });

  it('reports the --while condition that broke, with its exit code', () => {
    const json = buildJsonResult(
      resolve({ kind: 'while', value: './guard.sh', exitCode: 3 }),
      EXIT.CONDITION_FAILED,
    );
    assert.deepEqual(json.condition, { kind: 'while', value: './guard.sh', exitCode: 3 });
    assert.equal(json.exitCode, 4);
  });

  it('carries a signal-killed --while as a null exit code', () => {
    const json = buildJsonResult(
      resolve({ kind: 'while', value: 'g', exitCode: null }),
      EXIT.CONDITION_FAILED,
    );
    assert.equal(json.condition?.exitCode, null);
  });

  it('reports the pending ids on timeout', () => {
    const json = buildJsonResult(
      resolve({ kind: 'timeout', pendingIds: [4, 5] }, { pendingIds: [4, 5] }),
      EXIT.TIMEOUT,
    );
    assert.equal(json.outcome, 'timeout');
    assert.deepEqual(json.pendingIds, [4, 5]);
    assert.equal(json.condition, null);
  });

  it('reports unknown ids only for the unknown-tasks outcome', () => {
    const unknown = buildJsonResult(
      resolve({ kind: 'unknown-tasks', ids: [42, 43] }),
      EXIT.UNKNOWN_TASKS,
    );
    assert.deepEqual(unknown.unknownIds, [42, 43]);

    const other = buildJsonResult(resolve({ kind: 'timeout', pendingIds: [] }), EXIT.TIMEOUT);
    assert.deepEqual(other.unknownIds, []);
  });

  it('renders the remaining outcome kinds', () => {
    const unreachable = buildJsonResult(
      resolve({ kind: 'unreachable', tasks: [], failed: [] }),
      EXIT.TASK_FAILURE,
    );
    assert.equal(unreachable.outcome, 'unreachable');

    const interrupted = buildJsonResult(resolve({ kind: 'interrupted' }), EXIT.INTERRUPTED);
    assert.equal(interrupted.outcome, 'interrupted');
    assert.equal(interrupted.exitCode, 130);
  });

  it('passes the group through', () => {
    const json = buildJsonResult(
      resolve({ kind: 'reached', tasks: [], failed: [] }, { group: 'build' }),
      EXIT.OK,
    );
    assert.equal(json.group, 'build');
  });

  it('always includes every documented key', () => {
    const json = buildJsonResult(resolve({ kind: 'reached', tasks: [], failed: [] }), EXIT.OK);
    const expected: Array<keyof JsonResult> = [
      'outcome',
      'exitCode',
      'elapsedMs',
      'iterations',
      'targetStatus',
      'group',
      'tasks',
      'pendingIds',
      'failedIds',
      'condition',
      'unknownIds',
    ];
    assert.deepEqual(Object.keys(json).sort(), [...expected].sort());
  });
});

describe('buildJsonError', () => {
  it('renders each error kind', () => {
    assert.deepEqual(buildJsonError('usage', 'bad flag', EXIT.USAGE), {
      outcome: 'error',
      exitCode: 2,
      error: { kind: 'usage', message: 'bad flag' },
    });
    assert.equal(buildJsonError('pueue', 'down', EXIT.PUEUE_ERROR).error.kind, 'pueue');
    assert.equal(buildJsonError('condition', 'nope', EXIT.CONDITION_ERROR).error.kind, 'condition');
  });

  it('shares the outcome/exitCode contract with results', () => {
    const error = buildJsonError('pueue', 'x', EXIT.PUEUE_ERROR);
    assert.ok('outcome' in error && 'exitCode' in error);
  });
});

describe('renderJson', () => {
  it('emits pretty-printed JSON with a trailing newline', () => {
    const text = renderJson(buildJsonError('usage', 'x', EXIT.USAGE));
    assert.ok(text.endsWith('\n'));
    assert.ok(text.includes('\n  "exitCode"'), 'should be indented');
    assert.deepEqual(JSON.parse(text), {
      outcome: 'error',
      exitCode: 2,
      error: { kind: 'usage', message: 'x' },
    });
  });

  it('round-trips a result', () => {
    const json = buildJsonResult(resolve({ kind: 'until', value: 'go' }), EXIT.OK);
    assert.deepEqual(JSON.parse(renderJson(json)), json);
  });
});
