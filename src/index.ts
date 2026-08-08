/**
 * Programmatic entry point.
 *
 * The CLI is the primary interface, but the wait loop is usable from Node too —
 * handy for test harnesses and for wrapping the tool in a larger script.
 */
export { helpText, parseCliArgs, parseDuration, UsageError } from './args.js';
export type { Options, ParseResult, Selection } from './args.js';
export { conditionEnv, ConditionSpawnError, resolveCommand, runCondition } from './condition.js';
export type { ConditionContext, ConditionKind, ConditionOutcome } from './condition.js';
export { EXIT, exitCodeName } from './exitCodes.js';
export type { ExitCode } from './exitCodes.js';
export { createPueueClient, PueueError } from './pueue.js';
export type { PueueClient, PueueClientOptions } from './pueue.js';
export { Reporter, shouldUseColor } from './reporter.js';
export {
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
} from './status.js';
export type { Snapshot, TargetStatus, TaskState } from './status.js';
export { readPackageVersion } from './version.js';
export { outcomeToExitCode, selectTasks, snapshotForConditions, waitForConditions } from './wait.js';
export type { WaitDeps, WaitOutcome } from './wait.js';
export { main, run } from './cli.js';
export type { RunOptions } from './cli.js';
