/**
 * Process exit codes.
 *
 * These are part of the public contract of the CLI — scripts branch on them,
 * so treat any change here as a breaking change.
 */
export const EXIT = {
  /** Every selected task reached the target status, or an `--until` condition was satisfied. */
  OK: 0,
  /** Tasks finished but at least one did not succeed (see `--fail-on-error` / `--status success`). */
  TASK_FAILURE: 1,
  /** Bad command line. */
  USAGE: 2,
  /** `--timeout` elapsed before anything else resolved the wait. */
  TIMEOUT: 3,
  /** A `--while` condition exited non-zero, so waiting was abandoned. */
  CONDITION_FAILED: 4,
  /** Could not talk to the pueue daemon, or its output could not be parsed. */
  PUEUE_ERROR: 5,
  /** A condition script could not be executed at all (missing file, spawn failure). */
  CONDITION_ERROR: 6,
  /** Named task ids never showed up within `--task-grace`. */
  UNKNOWN_TASKS: 7,
  /** Interrupted by SIGINT. */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const NAMES: Record<number, string> = {
  [EXIT.OK]: 'OK',
  [EXIT.TASK_FAILURE]: 'TASK_FAILURE',
  [EXIT.USAGE]: 'USAGE',
  [EXIT.TIMEOUT]: 'TIMEOUT',
  [EXIT.CONDITION_FAILED]: 'CONDITION_FAILED',
  [EXIT.PUEUE_ERROR]: 'PUEUE_ERROR',
  [EXIT.CONDITION_ERROR]: 'CONDITION_ERROR',
  [EXIT.UNKNOWN_TASKS]: 'UNKNOWN_TASKS',
  [EXIT.INTERRUPTED]: 'INTERRUPTED',
};

export function exitCodeName(code: number): string {
  return NAMES[code] ?? `UNKNOWN(${code})`;
}
