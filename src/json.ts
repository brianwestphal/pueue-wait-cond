/**
 * `--json` output.
 *
 * One object, on stdout, when the run resolves — success or failure. Every
 * shape carries `outcome` and `exitCode`, so a caller can branch on one field
 * without first working out whether it got a result or an error.
 *
 * This is a public interface: adding fields is fine, renaming or removing them
 * is a breaking change.
 */
import type { TaskState } from './status.js';
import type { WaitResolution } from './wait.js';

export interface JsonTask {
  id: number;
  group: string;
  label: string | null;
  command: string;
  status: string;
  result: string | null;
  exitCode: number | null;
}

export interface JsonCondition {
  kind: 'until' | 'while';
  value: string;
  exitCode: number | null;
}

export type JsonErrorKind = 'usage' | 'pueue' | 'condition';

export interface JsonResult {
  outcome: 'reached' | 'until' | 'while' | 'timeout' | 'unreachable' | 'unknown-tasks' | 'interrupted';
  exitCode: number;
  elapsedMs: number;
  iterations: number;
  targetStatus: string;
  group: string | null;
  tasks: JsonTask[];
  pendingIds: number[];
  failedIds: number[];
  /** The condition that ended the wait, or `null` if none did. */
  condition: JsonCondition | null;
  /** Named ids that never appeared; empty unless `outcome` is `unknown-tasks`. */
  unknownIds: number[];
}

export interface JsonError {
  outcome: 'error';
  exitCode: number;
  error: { kind: JsonErrorKind; message: string };
}

function toJsonTask(task: TaskState): JsonTask {
  return {
    id: task.id,
    group: task.group,
    label: task.label,
    command: task.command,
    status: task.kind,
    result: task.result,
    exitCode: task.exitCode,
  };
}

export function buildJsonResult(resolution: WaitResolution, exitCode: number): JsonResult {
  const condition: JsonCondition | null =
    resolution.kind === 'until'
      ? { kind: 'until', value: resolution.value, exitCode: 0 }
      : resolution.kind === 'while'
        ? { kind: 'while', value: resolution.value, exitCode: resolution.exitCode }
        : null;

  return {
    outcome: resolution.kind,
    exitCode,
    elapsedMs: resolution.meta.elapsedMs,
    iterations: resolution.meta.iterations,
    targetStatus: resolution.meta.targetStatus,
    group: resolution.meta.group,
    tasks: resolution.meta.tasks.map(toJsonTask),
    pendingIds: resolution.meta.pendingIds,
    failedIds: resolution.meta.failedIds,
    condition,
    unknownIds: resolution.kind === 'unknown-tasks' ? resolution.ids : [],
  };
}

export function buildJsonError(kind: JsonErrorKind, message: string, exitCode: number): JsonError {
  return { outcome: 'error', exitCode, error: { kind, message } };
}

/** Serialize for stdout. Pretty-printed: these are read by humans too. */
export function renderJson(value: JsonResult | JsonError): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
