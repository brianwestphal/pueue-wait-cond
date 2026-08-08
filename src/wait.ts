/**
 * The wait loop.
 *
 * Each poll does, in order:
 *   1. fetch a snapshot and report any task status changes
 *   2. if every selected task reached the target status → done
 *   3. if any `--until` condition passes → done
 *   4. if any `--while` condition fails → give up
 *   5. if `--timeout` elapsed → give up
 *
 * Completion is checked before the conditions on purpose: when the tasks are
 * already finished there is no reason to let a stale `--while` guard turn a
 * successful wait into a failure.
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Options } from './args.js';
import type { ConditionContext, ConditionKind } from './condition.js';
import { ConditionSpawnError, runCondition } from './condition.js';
import { EXIT } from './exitCodes.js';
import type { PueueClient } from './pueue.js';
import { PueueError } from './pueue.js';
import type { Reporter } from './reporter.js';
import type { Snapshot, TaskState } from './status.js';
import { hasReached, isFailure, isUnreachable } from './status.js';

export type WaitOutcome =
  | { kind: 'reached'; tasks: TaskState[]; failed: TaskState[] }
  | { kind: 'until'; value: string }
  | { kind: 'while'; value: string; exitCode: number | null }
  | { kind: 'timeout'; pendingIds: number[] }
  | { kind: 'unreachable'; tasks: TaskState[]; failed: TaskState[] }
  | { kind: 'interrupted' };

export interface WaitDeps {
  client: PueueClient;
  reporter: Reporter;
  options: Options;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

/** The tasks a run is waiting on, given the current snapshot. */
export function selectTasks(snapshot: Snapshot, options: Options): TaskState[] {
  const selection = options.selection;
  if (selection.mode === 'ids') {
    const found: TaskState[] = [];
    for (const id of selection.ids) {
      const task = snapshot.tasks.get(id);
      if (task !== undefined) found.push(task);
    }
    return found;
  }
  const all = [...snapshot.tasks.values()];
  if (selection.mode === 'all') return all.sort((a, b) => a.id - b.id);
  return all.filter((t) => t.group === selection.group).sort((a, b) => a.id - b.id);
}

/** Ids named on the command line that the daemon has never heard of. */
export function missingIds(snapshot: Snapshot, options: Options): number[] {
  if (options.selection.mode !== 'ids') return [];
  return options.selection.ids.filter((id) => !snapshot.tasks.has(id));
}

export function selectionGroup(options: Options): string | null {
  return options.selection.mode === 'group' ? options.selection.group : null;
}

/**
 * Serialise the snapshot for condition scripts.
 *
 * pueue embeds each task's whole environment in `status --json`, which is both
 * enormous and full of secrets; conditions get the useful fields instead.
 */
export function snapshotForConditions(
  snapshot: Snapshot,
  selected: TaskState[],
  context: Omit<ConditionContext, 'snapshotJson' | 'snapshotPath'>,
): string {
  return JSON.stringify(
    {
      kind: context.kind,
      iteration: context.iteration,
      elapsedMs: context.elapsedMs,
      targetStatus: context.targetStatus,
      group: context.group,
      selectedIds: context.selectedIds,
      pendingIds: context.pendingIds,
      reachedIds: context.reachedIds,
      failedIds: context.failedIds,
      tasks: selected.map((t) => ({
        id: t.id,
        group: t.group,
        label: t.label,
        command: t.command,
        status: t.kind,
        result: t.result,
        exitCode: t.exitCode,
      })),
      groups: Object.fromEntries(
        [...snapshot.groups].map(([name, g]) => [
          name,
          { status: g.status, parallelTasks: g.parallelTasks },
        ]),
      ),
    },
    null,
    2,
  );
}

interface ConditionCheck {
  kind: ConditionKind;
  value: string;
  passed: boolean;
  exitCode: number | null;
}

export async function waitForConditions(deps: WaitDeps): Promise<WaitOutcome> {
  const { client, reporter, options } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const controller = new AbortController();
  const signal = deps.signal ?? controller.signal;

  const startedAt = now();
  const needsSnapshotFile = options.until.length > 0 || options.while.length > 0;
  const scratchDir = needsSnapshotFile ? mkdtempSync(join(tmpdir(), 'pueue-wait-cond-')) : null;
  const snapshotPath = scratchDir === null ? '' : join(scratchDir, 'status.json');

  let previous = new Map<number, TaskState>();
  let announced = false;
  let warnedMissing = false;
  let iteration = 0;

  try {
    for (;;) {
      if (signal.aborted) return { kind: 'interrupted' };

      const snapshot = await client.fetchSnapshot();
      const selected = selectTasks(snapshot, options);

      const absent = missingIds(snapshot, options);
      if (absent.length > 0 && !warnedMissing) {
        warnedMissing = true;
        reporter.warn(
          `warning: pueue has no task(s) ${absent.join(', ')}; ` +
            `continuing in case they show up. Ctrl-C or use --timeout to bound the wait.`,
        );
      }

      if (!announced) {
        announced = true;
        reporter.watching(selected);
      } else {
        for (const task of selected) reporter.taskChanged(previous.get(task.id), task);
      }
      previous = new Map(selected.map((t) => [t.id, t]));

      const reached = selected.filter((t) => hasReached(t, options.targetStatus));
      const pending = selected.filter((t) => !hasReached(t, options.targetStatus));
      const failed = selected.filter(isFailure);

      // 1. Primary completion. An empty selection only counts as complete when
      //    the user did not name specific ids — `wait 42` before task 42 exists
      //    should keep waiting, not claim instant success.
      const selectionSatisfiable = selected.length > 0 || options.selection.mode !== 'ids';
      if (pending.length === 0 && selectionSatisfiable && absent.length === 0) {
        reporter.allReached(options.targetStatus, reached.length);
        return { kind: 'reached', tasks: reached, failed };
      }

      // 1b. A finished task can never become `success`/`failed` after the fact,
      //     so stop rather than spin until the timeout.
      const stuck = pending.filter((t) => isUnreachable(t, options.targetStatus));
      if (stuck.length > 0) {
        reporter.warn(
          `Task(s) ${stuck.map((t) => t.id).join(', ')} finished without reaching ` +
            `"${options.targetStatus}"; giving up.`,
        );
        return { kind: 'unreachable', tasks: selected, failed };
      }

      const baseContext = {
        iteration,
        elapsedMs: now() - startedAt,
        selectedIds: selected.map((t) => t.id),
        pendingIds: pending.map((t) => t.id),
        reachedIds: reached.map((t) => t.id),
        failedIds: failed.map((t) => t.id),
        group: selectionGroup(options),
        targetStatus: options.targetStatus,
      };

      const evaluate = async (kind: ConditionKind, values: string[]): Promise<ConditionCheck[]> => {
        const checks: ConditionCheck[] = [];
        for (const value of values) {
          const context: ConditionContext = {
            ...baseContext,
            kind,
            snapshotJson: '',
            snapshotPath,
          };
          context.snapshotJson = snapshotForConditions(snapshot, selected, context);
          if (scratchDir !== null) writeFileSync(snapshotPath, context.snapshotJson, 'utf8');

          const outcome = await runCondition({
            value,
            shell: options.shell,
            timeoutMs: options.conditionTimeoutMs,
            context,
            ...(deps.env !== undefined ? { env: deps.env } : {}),
          });
          reporter.conditionOutput(kind, value, outcome.stdout, outcome.stderr);
          reporter.conditionResult(kind, value, outcome);
          checks.push({ kind, value, passed: outcome.passed, exitCode: outcome.exitCode });
        }
        return checks;
      };

      // 2. `--until`: any pass ends the wait successfully.
      for (const check of await evaluate('until', options.until)) {
        if (check.passed) {
          reporter.untilSatisfied(check.value);
          return { kind: 'until', value: check.value };
        }
      }

      // 3. `--while`: any failure abandons the wait.
      for (const check of await evaluate('while', options.while)) {
        if (!check.passed) {
          reporter.whileViolated(check.value, check.exitCode);
          return { kind: 'while', value: check.value, exitCode: check.exitCode };
        }
      }

      // 4. Timeout, checked after the conditions so a condition that resolves on
      //    the very last poll still wins over the deadline.
      const elapsed = now() - startedAt;
      if (options.timeoutMs !== null && elapsed >= options.timeoutMs) {
        reporter.timedOut(options.timeoutMs, pending.map((t) => t.id));
        return { kind: 'timeout', pendingIds: pending.map((t) => t.id) };
      }

      // Never sleep past the deadline.
      const remaining =
        options.timeoutMs === null
          ? options.intervalMs
          : Math.max(0, Math.min(options.intervalMs, options.timeoutMs - elapsed));
      await sleep(remaining, signal);
      iteration += 1;
    }
  } finally {
    if (scratchDir !== null) {
      try {
        unlinkSync(snapshotPath);
      } catch {
        // Already gone; nothing to clean up.
      }
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // Best effort — a leftover temp dir is not worth failing the run over.
      }
    }
  }
}

/** Map a {@link WaitOutcome} onto the process exit code. */
export function outcomeToExitCode(outcome: WaitOutcome, options: Options): number {
  switch (outcome.kind) {
    case 'reached':
      return options.failOnError && outcome.failed.length > 0 ? EXIT.TASK_FAILURE : EXIT.OK;
    case 'until':
      return EXIT.OK;
    case 'while':
      return EXIT.CONDITION_FAILED;
    case 'timeout':
      return EXIT.TIMEOUT;
    case 'unreachable':
      return EXIT.TASK_FAILURE;
    case 'interrupted':
      return EXIT.INTERRUPTED;
  }
}

export { ConditionSpawnError, PueueError };
