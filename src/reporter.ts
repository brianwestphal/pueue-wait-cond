/**
 * Progress output.
 *
 * Deliberately mirrors `pueue wait`'s own lines (`HH:MM:SS - Task 5 changed from
 * Queued to Running`) so this binary can be dropped in as a replacement without
 * breaking anything that scrapes the output.
 */
import type { TaskState } from './status.js';
import { describeStatus } from './status.js';

export interface Writer {
  write(chunk: string): void;
}

export interface ReporterOptions {
  quiet: boolean;
  out: Writer;
  err: Writer;
  color: boolean;
  now?: () => Date;
}

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';

export function shouldUseColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return stream.isTTY === true;
}

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class Reporter {
  private readonly quiet: boolean;
  private readonly out: Writer;
  private readonly err: Writer;
  private readonly color: boolean;
  private readonly now: () => Date;

  constructor(options: ReporterOptions) {
    this.quiet = options.quiet;
    this.out = options.out;
    this.err = options.err;
    this.color = options.color;
    this.now = options.now ?? (() => new Date());
  }

  private paint(text: string, code: string): string {
    return this.color ? `${code}${text}${RESET}` : text;
  }

  /** A progress line, suppressed by `--quiet`. */
  private line(text: string): void {
    if (this.quiet) return;
    this.out.write(`${timestamp(this.now())} - ${text}\n`);
  }

  /** Errors and warnings always go to stderr, even when quiet. */
  error(text: string): void {
    this.err.write(`${text}\n`);
  }

  warn(text: string): void {
    if (this.quiet) return;
    this.err.write(`${text}\n`);
  }

  taskChanged(previous: TaskState | undefined, current: TaskState): void {
    if (previous === undefined) return;
    const before = describeStatus(previous);
    const after = describeStatus(current);
    if (before === after) return;

    if (current.kind === 'Done' && previous.kind !== 'Done') {
      this.taskFinished(current);
      return;
    }
    this.line(`Task ${current.id} changed from ${before} to ${after}`);
  }

  taskFinished(task: TaskState): void {
    if (task.result === 'Success') {
      this.line(`Task ${task.id} ${this.paint('succeeded', GREEN)} with 0`);
      return;
    }
    const detail = task.exitCode !== null ? String(task.exitCode) : (task.result ?? 'unknown');
    this.line(`Task ${task.id} ${this.paint('failed', RED)} with ${detail}`);
  }

  /**
   * First sighting of a task, so `--quiet`-less runs show what is being waited on.
   *
   * Tasks that already finished before we ever looked also get their usual
   * `succeeded`/`failed` line: anything scraping the output for "failed with"
   * should see every failure we observed, not just the ones we watched happen.
   */
  watching(tasks: TaskState[]): void {
    if (tasks.length === 0) return;
    const summary = tasks.map((t) => `${t.id} (${describeStatus(t)})`).join(', ');
    this.line(this.paint(`Waiting on ${tasks.length} task(s): ${summary}`, DIM));
    for (const task of tasks) {
      if (task.kind === 'Done') this.taskFinished(task);
    }
  }

  conditionResult(
    kind: 'until' | 'while',
    value: string,
    outcome: { exitCode: number | null; signal: string | null; timedOut: boolean },
  ): void {
    const status = outcome.timedOut
      ? 'timed out'
      : outcome.exitCode !== null
        ? `exit ${outcome.exitCode}`
        : `killed by ${outcome.signal ?? 'signal'}`;
    this.line(`--${kind} condition "${value}" ${status}`);
  }

  conditionOutput(kind: 'until' | 'while', value: string, stdout: string, stderr: string): void {
    if (this.quiet) return;
    const body = `${stdout}${stderr}`.trimEnd();
    if (body === '') return;
    for (const raw of body.split('\n')) {
      this.err.write(`${this.paint(`[--${kind} ${value}]`, DIM)} ${raw}\n`);
    }
  }

  untilSatisfied(value: string): void {
    this.line(this.paint(`--until condition "${value}" satisfied; done waiting`, GREEN));
  }

  whileViolated(value: string, exitCode: number | null): void {
    const detail = exitCode !== null ? `exit ${exitCode}` : 'killed by signal';
    this.line(this.paint(`--while condition "${value}" failed (${detail}); giving up`, RED));
  }

  timedOut(timeoutMs: number, pendingIds: number[]): void {
    const pending = pendingIds.length > 0 ? ` Still waiting on: ${pendingIds.join(', ')}.` : '';
    this.line(this.paint(`Timed out after ${(timeoutMs / 1000).toFixed(3)}s.${pending}`, RED));
  }

  unknownTasks(ids: number[], graceMs: number): void {
    this.line(
      this.paint(
        `pueue still has no task(s) ${ids.join(', ')} after ${(graceMs / 1000).toFixed(3)}s; ` +
          `giving up. Use --task-grace to wait longer, or "forever" to wait indefinitely.`,
        RED,
      ),
    );
  }

  allReached(targetStatus: string, count: number): void {
    this.line(this.paint(`All ${count} task(s) reached "${targetStatus}"`, GREEN));
  }
}
