/**
 * Running `--until` / `--while` condition scripts.
 *
 * A condition "passes" when it exits 0. Failing to *run* the condition at all
 * (missing file, spawn failure) is deliberately a different outcome from a
 * non-zero exit: a typo'd `--while` path must not silently look like "the
 * condition became false" and end the wait early.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type ConditionKind = 'until' | 'while';

export interface ConditionContext {
  kind: ConditionKind;
  iteration: number;
  elapsedMs: number;
  selectedIds: number[];
  pendingIds: number[];
  reachedIds: number[];
  failedIds: number[];
  group: string | null;
  targetStatus: string;
  /** JSON snapshot handed to the script on stdin. */
  snapshotJson: string;
  /** Path to a file holding the same JSON, for scripts that can't read stdin. */
  snapshotPath: string;
}

export interface ConditionOutcome {
  /** Exited 0. */
  passed: boolean;
  /** Exit code, or `null` when the process was killed by a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when we killed it for exceeding `--condition-timeout`. */
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** The condition could not be executed at all — a configuration error, not a result. */
export class ConditionSpawnError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedCommand {
  file: string;
  args: string[];
  /** True when we fell back to running the value through a shell. */
  viaShell: boolean;
}

/**
 * Decide how to run a condition value.
 *
 * The CLI documents `<script-path>`, so an existing file wins: it is executed
 * directly if the executable bit is set, and handed to the shell otherwise (so
 * a `chmod`-less `./check.sh` still works). Anything that is not an existing
 * file is treated as an inline shell command, which makes one-liners like
 * `--until 'test -f /tmp/ready'` work without a wrapper script.
 */
export function resolveCommand(value: string, shell: string): ResolvedCommand {
  const asPath = isAbsolute(value) ? value : resolve(process.cwd(), value);
  let isFile = false;
  try {
    isFile = statSync(asPath).isFile();
  } catch {
    isFile = false;
  }

  if (isFile) {
    let executable = false;
    try {
      accessSync(asPath, constants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
    if (executable) return { file: asPath, args: [], viaShell: false };
    return { file: shell, args: [asPath], viaShell: true };
  }

  return { file: shell, args: ['-c', value], viaShell: true };
}

export function conditionEnv(context: ConditionContext): Record<string, string> {
  return {
    PUEUE_WAIT_COND: '1',
    PUEUE_WAIT_KIND: context.kind,
    PUEUE_WAIT_ITERATION: String(context.iteration),
    PUEUE_WAIT_ELAPSED_MS: String(context.elapsedMs),
    PUEUE_WAIT_ELAPSED: (context.elapsedMs / 1000).toFixed(3),
    PUEUE_WAIT_TASK_IDS: context.selectedIds.join(','),
    PUEUE_WAIT_PENDING_TASK_IDS: context.pendingIds.join(','),
    PUEUE_WAIT_REACHED_TASK_IDS: context.reachedIds.join(','),
    PUEUE_WAIT_FAILED_TASK_IDS: context.failedIds.join(','),
    PUEUE_WAIT_GROUP: context.group ?? '',
    PUEUE_WAIT_TARGET_STATUS: context.targetStatus,
    PUEUE_WAIT_STATUS_JSON: context.snapshotPath,
  };
}

export interface RunConditionOptions {
  value: string;
  shell: string;
  timeoutMs: number;
  context: ConditionContext;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests to keep the clock deterministic. */
  now?: () => number;
}

export function runCondition(options: RunConditionOptions): Promise<ConditionOutcome> {
  const { value, shell, timeoutMs, context } = options;
  const now = options.now ?? (() => Date.now());
  const resolved = resolveCommand(value, shell);
  const startedAt = now();

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(resolved.file, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(options.env ?? process.env), ...conditionEnv(context) },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if it ignores SIGTERM. `unref` so a well-behaved script that
      // exits promptly doesn't hold the event loop open for the grace period.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const hint =
        error.code === 'ENOENT'
          ? `Could not run --${context.kind} condition "${value}": ${resolved.file} not found.`
          : `Could not run --${context.kind} condition "${value}": ${error.message}`;
      rejectPromise(new ConditionSpawnError(value, hint));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolvePromise({
        passed: code === 0,
        exitCode: code,
        signal,
        timedOut,
        durationMs: now() - startedAt,
        stdout,
        stderr,
      });
    });

    // The snapshot goes in on stdin. An EPIPE here just means the script chose
    // not to read it, which is fine and must not fail the condition.
    child.stdin.on('error', () => {});
    child.stdin.end(context.snapshotJson);
  });
}
