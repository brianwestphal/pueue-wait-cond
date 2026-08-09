import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConditionSpawnError } from '../../src/condition.js';
import { EXIT } from '../../src/exitCodes.js';
import { PueueError } from '../../src/pueue.js';
import type { Snapshot } from '../../src/status.js';
import {
  missingIds,
  outcomeToExitCode,
  selectionGroup,
  selectTasks,
  snapshotForConditions,
  waitForConditions,
} from '../../src/wait.js';
import type { WaitOutcome } from '../../src/wait.js';
import {
  done,
  failed,
  fakeSleep,
  makeOptions,
  makeReporter,
  makeSnapshot,
  PAUSED,
  QUEUED,
  RUNNING,
  ScriptedClient,
  STASHED,
} from '../helpers/fakes.js';
import type { Harness } from '../helpers/fakes.js';
import type { Options } from '../../src/args.js';

/**
 * A groups fixture whose own `status` is not `Running`, so a condition that
 * greps the snapshot for a *task* status cannot match the group line instead.
 */
const IDLE_GROUPS = { default: { status: 'Paused', parallel_tasks: 1 } };

interface RunResult {
  outcome: WaitOutcome;
  polls: number;
  delays: number[];
  harness: Harness;
  exitCode: number;
}

async function runWait(
  script: Array<Snapshot | Error>,
  overrides: Partial<Options> = {},
  extra: { quiet?: boolean; nowStep?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const options = makeOptions({ quiet: extra.quiet ?? true, ...overrides });
  const client = new ScriptedClient(script);
  const harness = makeReporter(options.quiet);
  const { sleep, delays } = fakeSleep();
  let t = 0;
  const step = extra.nowStep ?? 0;

  const outcome = await waitForConditions({
    client,
    reporter: harness.reporter,
    options,
    sleep,
    now: () => {
      const value = t;
      t += step;
      return value;
    },
    ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
    env: { PATH: process.env.PATH ?? '' },
  });

  return { outcome, polls: client.calls, delays, harness, exitCode: outcomeToExitCode(outcome, options) };
}

describe('selectTasks', () => {
  const snapshot = makeSnapshot([
    { id: 1, status: QUEUED, group: 'default' },
    { id: 2, status: RUNNING, group: 'build' },
    { id: 3, status: done(), group: 'build' },
  ]);

  it('selects explicit ids, skipping ones the daemon does not know', () => {
    const tasks = selectTasks(snapshot, makeOptions({ selection: { mode: 'ids', ids: [2, 99] } }));
    assert.deepEqual(tasks.map((t) => t.id), [2]);
  });

  it('selects a group', () => {
    const tasks = selectTasks(snapshot, makeOptions({ selection: { mode: 'group', group: 'build' } }));
    assert.deepEqual(tasks.map((t) => t.id), [2, 3]);
  });

  it('selects everything for --all, sorted by id', () => {
    const tasks = selectTasks(snapshot, makeOptions({ selection: { mode: 'all' } }));
    assert.deepEqual(tasks.map((t) => t.id), [1, 2, 3]);
  });

  it('returns an empty list for an unknown group', () => {
    assert.deepEqual(selectTasks(snapshot, makeOptions({ selection: { mode: 'group', group: 'nope' } })), []);
  });
});

describe('missingIds / selectionGroup', () => {
  const snapshot = makeSnapshot([{ id: 1, status: QUEUED }]);

  it('reports ids the daemon has never seen', () => {
    assert.deepEqual(missingIds(snapshot, makeOptions({ selection: { mode: 'ids', ids: [1, 4] } })), [4]);
  });

  it('reports nothing for group and all selections', () => {
    assert.deepEqual(missingIds(snapshot, makeOptions({ selection: { mode: 'all' } })), []);
  });

  it('exposes the group name only in group mode', () => {
    assert.equal(selectionGroup(makeOptions({ selection: { mode: 'group', group: 'g' } })), 'g');
    assert.equal(selectionGroup(makeOptions({ selection: { mode: 'all' } })), null);
    assert.equal(selectionGroup(makeOptions({ selection: { mode: 'ids', ids: [1] } })), null);
  });
});

describe('snapshotForConditions', () => {
  it('summarises the selected tasks and the groups', () => {
    const snapshot = makeSnapshot(
      [
        { id: 1, status: failed(3), label: 'a', command: 'make' },
        { id: 2, status: RUNNING },
      ],
      { default: { status: 'Running', parallel_tasks: 2 } },
    );
    const selected = [...snapshot.tasks.values()];
    const json = snapshotForConditions(snapshot, selected, {
      kind: 'until',
      iteration: 0,
      elapsedMs: 10,
      selectedIds: [1, 2],
      pendingIds: [2],
      reachedIds: [1],
      failedIds: [1],
      group: 'default',
      targetStatus: 'done',
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.equal(parsed.kind, 'until');
    assert.deepEqual(parsed.pendingIds, [2]);
    assert.deepEqual(parsed.groups, { default: { status: 'Running', parallelTasks: 2 } });
    assert.deepEqual((parsed.tasks as unknown[])[0], {
      id: 1,
      group: 'default',
      label: 'a',
      command: 'make',
      status: 'Done',
      result: 'Failed',
      exitCode: 3,
    });
  });

  it('never leaks the task environment that pueue reports', () => {
    const snapshot = makeSnapshot([{ id: 1, status: QUEUED }]);
    const json = snapshotForConditions(snapshot, [...snapshot.tasks.values()], {
      kind: 'while',
      iteration: 0,
      elapsedMs: 0,
      selectedIds: [1],
      pendingIds: [1],
      reachedIds: [],
      failedIds: [],
      group: null,
      targetStatus: 'done',
    });
    assert.equal(json.includes('envs'), false);
  });
});

describe('waitForConditions — primary completion', () => {
  it('returns immediately when everything is already done', async () => {
    const { outcome, polls, exitCode } = await runWait([makeSnapshot([{ id: 1, status: done() }])]);
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 1);
    assert.equal(exitCode, EXIT.OK);
  });

  it('polls until the last task finishes', async () => {
    const { outcome, polls } = await runWait([
      makeSnapshot([{ id: 1, status: QUEUED }, { id: 2, status: QUEUED }]),
      makeSnapshot([{ id: 1, status: RUNNING }, { id: 2, status: QUEUED }]),
      makeSnapshot([{ id: 1, status: done() }, { id: 2, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: done() }, { id: 2, status: done() }]),
    ]);
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 4);
  });

  it('treats an empty group as complete', async () => {
    const { outcome } = await runWait([makeSnapshot([])]);
    assert.equal(outcome.kind, 'reached');
  });

  it('keeps waiting for a named task that does not exist yet', async () => {
    const { outcome, polls, harness } = await runWait(
      [makeSnapshot([]), makeSnapshot([]), makeSnapshot([{ id: 7, status: done() }])],
      { selection: { mode: 'ids', ids: [7] } },
      { quiet: false },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 3);
    assert.match(harness.err.text, /has no task\(s\) 7/);
  });

  it('warns about a missing task only once', async () => {
    const { harness } = await runWait(
      [makeSnapshot([]), makeSnapshot([]), makeSnapshot([{ id: 7, status: done() }])],
      { selection: { mode: 'ids', ids: [7] } },
      { quiet: false },
    );
    assert.equal(harness.err.text.match(/has no task/g)?.length, 1);
  });

  it('does not report success while some named ids are still unknown', async () => {
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([{ id: 1, status: done() }]),
        makeSnapshot([{ id: 1, status: done() }, { id: 2, status: done() }]),
      ],
      { selection: { mode: 'ids', ids: [1, 2] } },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 2);
  });
});

describe('waitForConditions — --task-grace', () => {
  const idOpts = (graceMs: number | null) => ({
    selection: { mode: 'ids' as const, ids: [7] },
    taskGraceMs: graceMs,
  });

  it('gives up once the grace expires', async () => {
    const { outcome, exitCode, harness } = await runWait(
      [makeSnapshot([])],
      idOpts(100),
      { nowStep: 60, quiet: false },
    );
    assert.equal(outcome.kind, 'unknown-tasks');
    if (outcome.kind === 'unknown-tasks') assert.deepEqual(outcome.ids, [7]);
    assert.equal(exitCode, EXIT.UNKNOWN_TASKS);
    assert.match(harness.out.text, /still has no task\(s\) 7 after 0\.100s; giving up/);
  });

  it('fails on the first poll with a zero grace', async () => {
    const { outcome, polls } = await runWait([makeSnapshot([])], idOpts(0));
    assert.equal(outcome.kind, 'unknown-tasks');
    assert.equal(polls, 1);
  });

  it('still covers the add-then-wait race within the grace', async () => {
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([]),
        makeSnapshot([]),
        makeSnapshot([{ id: 7, status: RUNNING }]),
        makeSnapshot([{ id: 7, status: done() }]),
      ],
      idOpts(10_000),
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 4);
  });

  it('waits indefinitely with a null grace', async () => {
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([]),
        makeSnapshot([]),
        makeSnapshot([]),
        makeSnapshot([{ id: 7, status: done() }]),
      ],
      idOpts(null),
      { nowStep: 100_000 },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 4);
  });

  it('never fires for group or --all selections', async () => {
    const { outcome } = await runWait([makeSnapshot([])], {
      selection: { mode: 'all' },
      taskGraceMs: 0,
    });
    assert.equal(outcome.kind, 'reached');
  });

  it('resets the grace when the id reappears', async () => {
    // Present → cleaned away → present again. Because the timer restarts on
    // each reappearance, the total absent time can exceed the grace without
    // any single gap doing so.
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([{ id: 7, status: RUNNING }]),
        makeSnapshot([]),
        makeSnapshot([{ id: 7, status: RUNNING }]),
        makeSnapshot([]),
        makeSnapshot([{ id: 7, status: done() }]),
      ],
      idOpts(150),
      { nowStep: 50 },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 5);
  });

  it('gives up on a task that vanishes mid-wait and stays gone', async () => {
    const { outcome, exitCode } = await runWait(
      [
        makeSnapshot([{ id: 7, status: RUNNING }]),
        makeSnapshot([]),
        makeSnapshot([]),
        makeSnapshot([]),
      ],
      idOpts(100),
      { nowStep: 60 },
    );
    assert.equal(outcome.kind, 'unknown-tasks');
    assert.equal(exitCode, EXIT.UNKNOWN_TASKS);
  });

  it('reports only the ids that are actually missing', async () => {
    const { outcome } = await runWait(
      [makeSnapshot([{ id: 1, status: done() }])],
      { selection: { mode: 'ids', ids: [1, 2, 3] }, taskGraceMs: 0 },
    );
    assert.equal(outcome.kind, 'unknown-tasks');
    if (outcome.kind === 'unknown-tasks') assert.deepEqual(outcome.ids, [2, 3]);
  });

  it('warns once, naming the grace', async () => {
    const { harness } = await runWait(
      [makeSnapshot([]), makeSnapshot([]), makeSnapshot([{ id: 7, status: done() }])],
      idOpts(10_000),
      { quiet: false },
    );
    assert.equal(harness.err.text.match(/has no task/g)?.length, 1);
    assert.match(harness.err.text, /giving them 10\.000s to appear \(--task-grace\)/);
  });

  it('says so when the grace is forever', async () => {
    const { harness } = await runWait(
      [makeSnapshot([]), makeSnapshot([{ id: 7, status: done() }])],
      idOpts(null),
      { quiet: false },
    );
    assert.match(harness.err.text, /waiting indefinitely \(--task-grace forever\)/);
  });

  it('treats the grace as a floor, firing on the first poll at or past it', async () => {
    // Evaluated at poll boundaries, so a 100ms grace with a clock that advances
    // 60ms per read cannot fire on the first poll.
    const { outcome, polls } = await runWait([makeSnapshot([])], idOpts(100), { nowStep: 60 });
    assert.equal(outcome.kind, 'unknown-tasks');
    assert.ok(polls > 1, 'should not have given up before the grace elapsed');
  });

  it('loses to completion when the last missing id arrives already done', async () => {
    const { outcome } = await runWait(
      [makeSnapshot([{ id: 7, status: done() }])],
      idOpts(0),
    );
    assert.equal(outcome.kind, 'reached');
  });
});

describe('waitForConditions — --status targets', () => {
  it('stops as soon as tasks start running', async () => {
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([{ id: 1, status: QUEUED }]),
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: done() }]),
      ],
      { targetStatus: 'running' },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 2);
  });

  it('is satisfied by a task that finished between polls', async () => {
    const { outcome, polls } = await runWait(
      [makeSnapshot([{ id: 1, status: done() }])],
      { targetStatus: 'running' },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 1);
  });

  it('waits for a stashed task', async () => {
    const { outcome, polls } = await runWait(
      [makeSnapshot([{ id: 1, status: QUEUED }]), makeSnapshot([{ id: 1, status: STASHED }])],
      { targetStatus: 'stashed' },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 2);
  });

  it('waits for a paused task', async () => {
    const { outcome } = await runWait([makeSnapshot([{ id: 1, status: PAUSED }])], {
      targetStatus: 'paused',
    });
    assert.equal(outcome.kind, 'reached');
  });

  it('gives up when a task fails but success was required', async () => {
    const { outcome, exitCode, harness } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }]), makeSnapshot([{ id: 1, status: failed(2) }])],
      { targetStatus: 'success' },
      { quiet: false },
    );
    assert.equal(outcome.kind, 'unreachable');
    assert.equal(exitCode, EXIT.TASK_FAILURE);
    assert.match(harness.err.text, /finished without reaching "success"/);
  });

  it('gives up when a task succeeds but failure was required', async () => {
    const { outcome, exitCode } = await runWait([makeSnapshot([{ id: 1, status: done() }])], {
      targetStatus: 'failed',
    });
    assert.equal(outcome.kind, 'unreachable');
    assert.equal(exitCode, EXIT.TASK_FAILURE);
  });

  it('succeeds when the task fails the way --status failed asked for', async () => {
    const { outcome, exitCode } = await runWait([makeSnapshot([{ id: 1, status: failed(1) }])], {
      targetStatus: 'failed',
    });
    assert.equal(outcome.kind, 'reached');
    assert.equal(exitCode, EXIT.OK);
  });
});

describe('waitForConditions — --fail-on-error', () => {
  it('exits 0 on a failed task by default, matching pueue wait', async () => {
    const { exitCode } = await runWait([makeSnapshot([{ id: 1, status: failed(3) }])]);
    assert.equal(exitCode, EXIT.OK);
  });

  it('exits 1 on a failed task when asked to', async () => {
    const { exitCode } = await runWait([makeSnapshot([{ id: 1, status: failed(3) }])], {
      failOnError: true,
    });
    assert.equal(exitCode, EXIT.TASK_FAILURE);
  });

  it('exits 0 when every task succeeded', async () => {
    const { exitCode } = await runWait([makeSnapshot([{ id: 1, status: done() }])], {
      failOnError: true,
    });
    assert.equal(exitCode, EXIT.OK);
  });

  it('counts Killed and DependencyFailed as failures', async () => {
    const { exitCode } = await runWait(
      [makeSnapshot([{ id: 1, status: done('Killed') }, { id: 2, status: done('DependencyFailed') }])],
      { failOnError: true },
    );
    assert.equal(exitCode, EXIT.TASK_FAILURE);
  });
});

describe('waitForConditions — --until', () => {
  it('stops as soon as the condition passes', async () => {
    const { outcome, polls, exitCode } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }])],
      { until: ['exit 0'] },
    );
    assert.equal(outcome.kind, 'until');
    assert.equal(polls, 1);
    assert.equal(exitCode, EXIT.OK);
  });

  it('keeps waiting while the condition fails', async () => {
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: done() }]),
      ],
      { until: ['exit 1'] },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 3);
  });

  it('is satisfied when any of several conditions passes', async () => {
    const { outcome } = await runWait([makeSnapshot([{ id: 1, status: RUNNING }])], {
      until: ['exit 1', 'exit 0'],
    });
    assert.equal(outcome.kind, 'until');
    if (outcome.kind === 'until') assert.equal(outcome.value, 'exit 0');
  });

  it('loses to the primary completion check when both fire on the same poll', async () => {
    const { outcome } = await runWait([makeSnapshot([{ id: 1, status: done() }])], {
      until: ['exit 0'],
    });
    assert.equal(outcome.kind, 'reached');
  });

  it('sees the iteration counter advance', async () => {
    const { outcome, polls } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }])],
      { until: ['test "$PUEUE_WAIT_ITERATION" -ge 2'] },
    );
    assert.equal(outcome.kind, 'until');
    assert.equal(polls, 3);
  });

  it('can read the snapshot from stdin', async () => {
    const { outcome } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING, label: 'marker-a' }], IDLE_GROUPS)],
      { until: ['grep -q \'"label": "marker-a"\''] },
    );
    assert.equal(outcome.kind, 'until');
  });

  it('can read the snapshot from $PUEUE_WAIT_STATUS_JSON', async () => {
    const { outcome } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING, label: 'marker-b' }], IDLE_GROUPS)],
      { until: ['grep -q marker-b "$PUEUE_WAIT_STATUS_JSON"'] },
    );
    assert.equal(outcome.kind, 'until');
  });

  it('surfaces a broken condition as a spawn error', async () => {
    await assert.rejects(
      runWait([makeSnapshot([{ id: 1, status: RUNNING }])], {
        until: ['exit 0'],
        shell: '/definitely/not/a/shell',
      }),
      ConditionSpawnError,
    );
  });
});

describe('waitForConditions — --while', () => {
  it('keeps waiting while the condition passes', async () => {
    const { outcome, polls } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }]), makeSnapshot([{ id: 1, status: done() }])],
      { while: ['exit 0'] },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 2);
  });

  it('gives up as soon as the condition fails', async () => {
    const { outcome, polls, exitCode } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }])],
      { while: ['exit 5'] },
    );
    assert.equal(outcome.kind, 'while');
    if (outcome.kind === 'while') assert.equal(outcome.exitCode, 5);
    assert.equal(polls, 1);
    assert.equal(exitCode, EXIT.CONDITION_FAILED);
  });

  it('gives up when any of several conditions fails', async () => {
    const { outcome } = await runWait([makeSnapshot([{ id: 1, status: RUNNING }])], {
      while: ['exit 0', 'exit 3'],
    });
    assert.equal(outcome.kind, 'while');
    if (outcome.kind === 'while') assert.equal(outcome.value, 'exit 3');
  });

  it('never turns an already-complete wait into a failure', async () => {
    const { outcome, exitCode } = await runWait([makeSnapshot([{ id: 1, status: done() }])], {
      while: ['exit 1'],
    });
    assert.equal(outcome.kind, 'reached');
    assert.equal(exitCode, EXIT.OK);
  });

  it('loses to --until when both fire on the same poll', async () => {
    const { outcome } = await runWait([makeSnapshot([{ id: 1, status: RUNNING }])], {
      until: ['exit 0'],
      while: ['exit 1'],
    });
    assert.equal(outcome.kind, 'until');
  });
});

describe('waitForConditions — --timeout', () => {
  it('gives up once the budget is spent', async () => {
    const { outcome, exitCode } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }])],
      { timeoutMs: 100 },
      { nowStep: 60 },
    );
    assert.equal(outcome.kind, 'timeout');
    if (outcome.kind === 'timeout') assert.deepEqual(outcome.pendingIds, [1]);
    assert.equal(exitCode, EXIT.TIMEOUT);
  });

  it('never sleeps past the deadline', async () => {
    const { delays } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }])],
      { timeoutMs: 100, intervalMs: 1_000 },
      { nowStep: 30 },
    );
    for (const delay of delays) assert.ok(delay <= 100, `slept ${delay}ms past a 100ms budget`);
  });

  it('lets a condition satisfied on the final poll win over the deadline', async () => {
    const { outcome } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }])],
      { timeoutMs: 1, until: ['exit 0'] },
      { nowStep: 1_000 },
    );
    assert.equal(outcome.kind, 'until');
  });

  it('lets completion on the final poll win over the deadline', async () => {
    const { outcome } = await runWait(
      [makeSnapshot([{ id: 1, status: done() }])],
      { timeoutMs: 1 },
      { nowStep: 1_000 },
    );
    assert.equal(outcome.kind, 'reached');
  });

  it('waits forever when no timeout is set', async () => {
    const { outcome, polls } = await runWait([
      makeSnapshot([{ id: 1, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: done() }]),
    ]);
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 4);
  });
});

describe('waitForConditions — interruption and errors', () => {
  it('reports an interruption when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { outcome, polls, exitCode } = await runWait(
      [makeSnapshot([{ id: 1, status: RUNNING }])],
      {},
      { signal: controller.signal },
    );
    assert.equal(outcome.kind, 'interrupted');
    assert.equal(polls, 0);
    assert.equal(exitCode, EXIT.INTERRUPTED);
  });

  it('propagates a pueue failure', async () => {
    await assert.rejects(runWait([new PueueError('daemon is down')]), PueueError);
  });

  it('wakes out of a real sleep the moment it is aborted', async () => {
    // No injected `sleep` here, so this exercises the production timer path.
    const controller = new AbortController();
    const client = new ScriptedClient([makeSnapshot([{ id: 1, status: RUNNING }])]);
    const harness = makeReporter(true);

    const started = Date.now();
    const promise = waitForConditions({
      client,
      reporter: harness.reporter,
      options: makeOptions({ intervalMs: 60_000 }),
      signal: controller.signal,
      env: { PATH: process.env.PATH ?? '' },
    });
    setTimeout(() => controller.abort(), 100);

    const outcome = await promise;
    assert.equal(outcome.kind, 'interrupted');
    assert.ok(Date.now() - started < 10_000, 'should not have slept out the full interval');
  });

  it('completes a real sleep when nothing aborts it', async () => {
    const client = new ScriptedClient([
      makeSnapshot([{ id: 1, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: done() }]),
    ]);
    const harness = makeReporter(true);
    const outcome = await waitForConditions({
      client,
      reporter: harness.reporter,
      options: makeOptions({ intervalMs: 20 }),
      env: { PATH: process.env.PATH ?? '' },
    });
    assert.equal(outcome.kind, 'reached');
    assert.equal(client.calls, 2);
  });
});

describe('waitForConditions — state transition sequences', () => {
  // Coverage of the individual states says nothing about the *paths* between
  // them, so these walk realistic multi-step sequences end to end.

  it('queued → running → done, reporting each hop exactly once', async () => {
    const { harness } = await runWait(
      [
        makeSnapshot([{ id: 1, status: QUEUED }]),
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: done() }]),
      ],
      {},
      { quiet: false },
    );
    const lines = harness.out.lines;
    assert.equal(lines.filter((l) => l.includes('changed from Queued to Running')).length, 1);
    assert.equal(lines.filter((l) => l.includes('succeeded with 0')).length, 1);
  });

  it('stashed → queued → running → done', async () => {
    const { outcome, polls } = await runWait([
      makeSnapshot([{ id: 1, status: STASHED }]),
      makeSnapshot([{ id: 1, status: QUEUED }]),
      makeSnapshot([{ id: 1, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: done() }]),
    ]);
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 4);
  });

  it('running → paused → running → done keeps waiting through the pause', async () => {
    const { outcome, polls } = await runWait([
      makeSnapshot([{ id: 1, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: PAUSED }]),
      makeSnapshot([{ id: 1, status: RUNNING }]),
      makeSnapshot([{ id: 1, status: done() }]),
    ]);
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 4);
  });

  it('picks up tasks added to the group mid-wait', async () => {
    const { outcome, polls } = await runWait([
      makeSnapshot([{ id: 1, status: done() }, { id: 2, status: RUNNING }]),
      // Task 3 appears after the first poll and must not be missed.
      makeSnapshot([
        { id: 1, status: done() },
        { id: 2, status: done() },
        { id: 3, status: QUEUED },
      ]),
      makeSnapshot([
        { id: 1, status: done() },
        { id: 2, status: done() },
        { id: 3, status: done() },
      ]),
    ]);
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 3);
  });

  it('does not pick up new group members once the group has drained', async () => {
    // The wait ends at the first fully-drained poll; a task enqueued later is
    // somebody else's problem.
    const { outcome, polls } = await runWait([
      makeSnapshot([{ id: 1, status: done() }]),
      makeSnapshot([{ id: 1, status: done() }, { id: 2, status: QUEUED }]),
    ]);
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 1);
  });

  it('ignores tasks outside the selected group throughout', async () => {
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([
          { id: 1, status: done(), group: 'build' },
          { id: 2, status: RUNNING, group: 'other' },
        ]),
      ],
      { selection: { mode: 'group', group: 'build' } },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 1);
  });

  it('a --while guard that flips false mid-run wins over later completion', async () => {
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: done() }]),
      ],
      { while: ['test "$PUEUE_WAIT_ITERATION" -lt 1'] },
    );
    assert.equal(outcome.kind, 'while');
    assert.equal(polls, 2);
  });

  it('an --until that only becomes true after a status change still fires', async () => {
    // The condition inspects the snapshot, so the loop must hand it a *fresh*
    // one each poll rather than reusing the first.
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([{ id: 1, status: QUEUED }, { id: 2, status: QUEUED }], IDLE_GROUPS),
        makeSnapshot([{ id: 1, status: RUNNING }, { id: 2, status: QUEUED }], IDLE_GROUPS),
      ],
      { until: ['grep -q \'"status": "Running"\''] },
    );
    assert.equal(outcome.kind, 'until');
    assert.equal(polls, 2);
  });

  it('survives an empty-then-refilled task list', async () => {
    // Poll 1: the named id is absent → warn and keep waiting. Poll 2: it exists
    // but is still running. Poll 3: finished.
    const { outcome, polls } = await runWait(
      [
        makeSnapshot([]),
        makeSnapshot([{ id: 1, status: RUNNING }]),
        makeSnapshot([{ id: 1, status: done() }]),
      ],
      { selection: { mode: 'ids', ids: [1] } },
    );
    assert.equal(outcome.kind, 'reached');
    assert.equal(polls, 3);
  });

  it('handles repeated identical snapshots without re-reporting', async () => {
    const same = makeSnapshot([{ id: 1, status: RUNNING }]);
    const { harness } = await runWait(
      [same, same, same, makeSnapshot([{ id: 1, status: done() }])],
      {},
      { quiet: false },
    );
    assert.equal(harness.out.lines.filter((l) => l.includes('changed from')).length, 0);
  });
});

describe('outcomeToExitCode', () => {
  const options = makeOptions();

  it('maps every outcome kind', () => {
    assert.equal(outcomeToExitCode({ kind: 'reached', tasks: [], failed: [] }, options), EXIT.OK);
    assert.equal(outcomeToExitCode({ kind: 'until', value: 'x' }, options), EXIT.OK);
    assert.equal(outcomeToExitCode({ kind: 'while', value: 'x', exitCode: 1 }, options), EXIT.CONDITION_FAILED);
    assert.equal(outcomeToExitCode({ kind: 'timeout', pendingIds: [1] }, options), EXIT.TIMEOUT);
    assert.equal(outcomeToExitCode({ kind: 'unreachable', tasks: [], failed: [] }, options), EXIT.TASK_FAILURE);
    assert.equal(outcomeToExitCode({ kind: 'unknown-tasks', ids: [1] }, options), EXIT.UNKNOWN_TASKS);
    assert.equal(outcomeToExitCode({ kind: 'interrupted' }, options), EXIT.INTERRUPTED);
  });
});
