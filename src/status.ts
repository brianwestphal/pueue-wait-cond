/**
 * Model of the `pueue status --json` payload, plus the status matching rules
 * used to decide when a task has "reached" the status we are waiting for.
 *
 * pueue serializes a task's status as a serde-tagged enum, which comes out as
 * either a bare string (`"Queued"`) or a single-key object
 * (`{ "Done": { "result": "Success", ... } }`). We normalize both shapes into a
 * flat {@link TaskState}.
 */

/** The status names accepted by `--status`. */
export const TARGET_STATUSES = [
  'queued',
  'stashed',
  'running',
  'paused',
  'locked',
  'done',
  'success',
  'failed',
] as const;

export type TargetStatus = (typeof TARGET_STATUSES)[number];

export function isTargetStatus(value: string): value is TargetStatus {
  return (TARGET_STATUSES as readonly string[]).includes(value);
}

/** Normalized, flattened view of a pueue task status. */
export interface TaskState {
  id: number;
  group: string;
  label: string | null;
  command: string;
  /** The serde variant name, e.g. `Queued`, `Running`, `Done`, `Stashed`. */
  kind: string;
  /** Set when `kind === 'Done'`: `Success`, `Failed`, `Killed`, `DependencyFailed`, ... */
  result: string | null;
  /** Set when the task finished with a non-zero exit code. */
  exitCode: number | null;
}

export interface Snapshot {
  tasks: Map<number, TaskState>;
  groups: Map<string, { status: string; parallelTasks: number }>;
}

/**
 * How far along the queued → running → done lifecycle a status sits.
 *
 * Waiting for `running` must also be satisfied by a task that already blew past
 * running and finished, otherwise a short task that completes between two polls
 * would hang the wait forever. Ordering the main-line states gives us that for
 * free; the off-to-the-side states (stashed / paused / locked) are not on the
 * line and are matched exactly instead.
 */
const LIFECYCLE_RANK: Record<string, number> = {
  Queued: 1,
  Running: 2,
  Done: 3,
};

const OFF_LINE_KINDS = new Set(['Stashed', 'Paused', 'Locked']);

const TARGET_RANK: Record<TargetStatus, number> = {
  queued: 1,
  running: 2,
  done: 3,
  success: 3,
  failed: 3,
  // Off-line targets are matched by kind, not by rank; the value is unused.
  stashed: 0,
  paused: 0,
  locked: 0,
};

/** Task kinds that a given off-line target status matches. */
const OFF_LINE_TARGET_KIND: Partial<Record<TargetStatus, string>> = {
  stashed: 'Stashed',
  paused: 'Paused',
  locked: 'Locked',
};

export function isFinished(task: TaskState): boolean {
  return task.kind === 'Done';
}

export function isSuccess(task: TaskState): boolean {
  return task.kind === 'Done' && task.result === 'Success';
}

export function isFailure(task: TaskState): boolean {
  return task.kind === 'Done' && task.result !== 'Success';
}

/** True when `task` has reached (or moved past) `target`. */
export function hasReached(task: TaskState, target: TargetStatus): boolean {
  const offLineKind = OFF_LINE_TARGET_KIND[target];
  if (offLineKind !== undefined) return task.kind === offLineKind;

  if (target === 'success') return isSuccess(task);
  if (target === 'failed') return isFailure(task);

  // A task parked in an off-line state has not progressed along the lifecycle.
  if (OFF_LINE_KINDS.has(task.kind)) return false;

  const rank = LIFECYCLE_RANK[task.kind];
  if (rank === undefined) return false;
  return rank >= TARGET_RANK[target];
}

/**
 * True when `task` can never reach `target`, so continuing to wait is pointless.
 *
 * Deliberately narrow: only a finished task's *result* is a terminal fact. A
 * finished task could in principle be restarted back into `Queued`/`Stashed`,
 * so we keep waiting for those targets rather than declaring them impossible.
 */
export function isUnreachable(task: TaskState, target: TargetStatus): boolean {
  if (!isFinished(task)) return false;
  if (target === 'success') return !isSuccess(task);
  if (target === 'failed') return !isFailure(task);
  return false;
}

/** Human-readable status, in the same spirit as pueue's own `status` column. */
export function describeStatus(task: TaskState): string {
  if (task.kind !== 'Done') return task.kind;
  if (task.result === 'Success') return 'Success';
  if (task.result === null) return 'Done';
  if (task.exitCode !== null) return `${task.result}(${task.exitCode})`;
  return task.result;
}

interface RawTask {
  id?: unknown;
  group?: unknown;
  label?: unknown;
  command?: unknown;
  status?: unknown;
}

/** Pull the variant name and payload out of a serde-tagged enum value. */
function unpackEnum(value: unknown): { kind: string; payload: Record<string, unknown> | null } {
  if (typeof value === 'string') return { kind: value, payload: null };
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const kind = keys[0];
    if (keys.length === 1 && kind !== undefined) {
      const inner = (value as Record<string, unknown>)[kind];
      return {
        kind,
        payload: inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>) : null,
      };
    }
  }
  return { kind: 'Unknown', payload: null };
}

/**
 * `result` is itself a tagged enum: `"Success"`, `"Killed"`, `"DependencyFailed"`,
 * or `{ "Failed": 7 }` carrying the exit code.
 */
function unpackResult(value: unknown): { result: string | null; exitCode: number | null } {
  if (value === undefined || value === null) return { result: null, exitCode: null };
  const { kind, payload } = unpackEnum(value);
  if (kind === 'Unknown') return { result: null, exitCode: null };
  if (payload === null && typeof value === 'object') {
    // `{ "Failed": 7 }` — the payload is a scalar, not an object.
    const inner = (value as Record<string, unknown>)[kind];
    return { result: kind, exitCode: typeof inner === 'number' ? inner : null };
  }
  return { result: kind, exitCode: null };
}

export class PueueParseError extends Error {}

/** Parse the object returned by `pueue status --json` into a {@link Snapshot}. */
export function parseSnapshot(raw: unknown): Snapshot {
  if (raw === null || typeof raw !== 'object') {
    throw new PueueParseError('pueue status did not return a JSON object');
  }
  const root = raw as { tasks?: unknown; groups?: unknown };
  if (root.tasks === null || typeof root.tasks !== 'object') {
    throw new PueueParseError('pueue status JSON has no "tasks" object');
  }

  const tasks = new Map<number, TaskState>();
  for (const value of Object.values(root.tasks as Record<string, RawTask>)) {
    if (value === null || typeof value !== 'object') continue;
    const id = typeof value.id === 'number' ? value.id : Number.NaN;
    if (!Number.isFinite(id)) continue;

    const { kind, payload } = unpackEnum(value.status);
    const { result, exitCode } = unpackResult(payload?.result);

    tasks.set(id, {
      id,
      group: typeof value.group === 'string' ? value.group : 'default',
      label: typeof value.label === 'string' ? value.label : null,
      command: typeof value.command === 'string' ? value.command : '',
      kind,
      result,
      exitCode,
    });
  }

  const groups = new Map<string, { status: string; parallelTasks: number }>();
  if (root.groups !== null && typeof root.groups === 'object') {
    for (const [name, value] of Object.entries(root.groups as Record<string, unknown>)) {
      const g = (value ?? {}) as { status?: unknown; parallel_tasks?: unknown };
      groups.set(name, {
        status: typeof g.status === 'string' ? g.status : 'Unknown',
        parallelTasks: typeof g.parallel_tasks === 'number' ? g.parallel_tasks : 0,
      });
    }
  }

  return { tasks, groups };
}
