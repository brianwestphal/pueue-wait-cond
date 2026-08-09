import { parseArgs } from 'node:util';

import type { TargetStatus } from './status.js';
import { isTargetStatus, TARGET_STATUSES } from './status.js';

export class UsageError extends Error {}

export type Selection =
  | { mode: 'ids'; ids: number[] }
  | { mode: 'group'; group: string }
  | { mode: 'all' };

export interface Options {
  selection: Selection;
  targetStatus: TargetStatus;
  quiet: boolean;
  /** Overall wall-clock budget in ms; `null` means wait forever. */
  timeoutMs: number | null;
  /** Poll period in ms. */
  intervalMs: number;
  /** Per-invocation budget for a condition script, in ms. */
  conditionTimeoutMs: number;
  /**
   * How long a named task id may be absent from pueue before the wait gives up.
   * `null` means tolerate it forever (the pre-0.1.1 behaviour).
   */
  taskGraceMs: number | null;
  until: string[];
  while: string[];
  /** Exit non-zero when the wait completes but some task did not succeed. */
  failOnError: boolean;
  pueueBinary: string;
  pueueConfig: string | undefined;
  pueueProfile: string | undefined;
  /** Shell used to run condition strings that are not executable files. */
  shell: string;
}

export type ParseResult =
  | { kind: 'run'; options: Options }
  | { kind: 'help'; text: string }
  | { kind: 'version' };

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
};

/**
 * Parse a duration. A bare number is seconds (that is what the CLI documents);
 * an explicit `ms` / `s` / `m` / `h` suffix is also accepted for convenience.
 */
export function parseDuration(raw: string, flag: string): number {
  const text = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/.exec(text);
  if (match === null) {
    throw new UsageError(`${flag} expects a duration in seconds, got "${raw}"`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? '';
  if (!Number.isFinite(value)) {
    throw new UsageError(`${flag} expects a duration in seconds, got "${raw}"`);
  }
  const multiplier = unit === '' ? 1_000 : DURATION_UNITS[unit];
  if (multiplier === undefined) {
    throw new UsageError(
      `${flag} got an unknown duration unit "${unit}" (use one of ms, s, m, h)`,
    );
  }
  return Math.round(value * multiplier);
}

function parseTaskId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(
      `Task ids must be non-negative integers, got "${raw}". ` +
        `(If you meant an option, note that options must come before or after the ids, not be misspelled.)`,
    );
  }
  return Number(raw);
}

export function helpText(): string {
  return `pueue-wait-cond — pueue wait, plus timeouts and script conditions

Usage:
  pueue-wait-cond [TASK_IDS]... [OPTIONS]

Examples:
  pueue-wait-cond 42 --timeout 5m
  pueue-wait-cond 42 --until 'test -f /tmp/ready'          # inline command
  pueue-wait-cond 42 --until ./healthcheck.sh              # script file
  pueue-wait-cond -g build --while 'test -f /var/run/deploy.lock'

Arguments:
  [TASK_IDS]...            Wait for these specific tasks to finish.
                           With no ids and no -g/-a, waits on the default group.

Task selection (mutually exclusive):
  -g, --group <GROUP>      Wait for all tasks in a specific group
  -a, --all                Wait for all tasks across all groups

Wait target:
  -s, --status <STATUS>    Wait for tasks to reach a specific status
                           [default: done]
                           one of: ${TARGET_STATUSES.slice(0, 5).join(', ')},
                                   ${TARGET_STATUSES.slice(5).join(', ')}
      --fail-on-error      Exit ${1} if the wait completes but a task did not succeed

Conditions (repeatable; a condition "passes" when it exits 0).
Each takes either a SCRIPT path or an inline shell COMMAND — see below:
  -u, --until <SCRIPT|COMMAND>
                           Stop waiting successfully as soon as any --until passes
  -w, --while <SCRIPT|COMMAND>
                           Give up waiting as soon as any --while fails
      --condition-timeout <SECONDS>
                           Kill a condition that runs this long [default: 30]

Timing:
  -t, --timeout <SECONDS>  Give up after this long [default: no timeout]
  -i, --interval <SECONDS> Poll period [default: 2]
      --task-grace <SECONDS|forever>
                           How long a named TASK_ID may be missing from pueue
                           before giving up with exit ${7} [default: 5].
                           Covers the "pueue add" then wait race; "0" fails on
                           the first poll, "forever" never gives up.

pueue plumbing:
      --pueue-binary <PATH>  pueue executable [default: $PUEUE_BINARY or "pueue"]
      --config <PATH>        Forwarded to pueue as --config
      --profile <NAME>       Forwarded to pueue as --profile
      --shell <PATH>         Shell for inline commands and non-executable
                             scripts [default: /bin/sh]

Output:
  -q, --quiet              Don't show any log output while waiting
  -h, --help               Print help
  -V, --version            Print version

Writing conditions:
  A condition value that names an EXISTING FILE is executed as a script (through
  --shell if it is not executable). Anything else is run as an INLINE SHELL
  COMMAND, so full shell syntax works — pipelines, &&, $(...), if/then, and
  multiple lines:

      --until 'curl -sf localhost:8080/health'
      --until 'pueue log 42 | grep -q "Listening on"'
      --while 'test -f /var/run/deploy.lock && test -s /var/run/deploy.lock'

  Conditions receive the pueue snapshot as JSON on stdin, the same JSON in the
  file named by $PUEUE_WAIT_STATUS_JSON, and context in the environment:
  $PUEUE_WAIT_TASK_IDS, $PUEUE_WAIT_PENDING_TASK_IDS, $PUEUE_WAIT_REACHED_TASK_IDS,
  $PUEUE_WAIT_FAILED_TASK_IDS, $PUEUE_WAIT_ELAPSED, $PUEUE_WAIT_ELAPSED_MS,
  $PUEUE_WAIT_ITERATION, $PUEUE_WAIT_GROUP, $PUEUE_WAIT_TARGET_STATUS,
  $PUEUE_WAIT_KIND.

      --until 'test -z "$PUEUE_WAIT_PENDING_TASK_IDS"'
      --until 'jq -e ".tasks[0].result == \\"Success\\"" >/dev/null'

  Quote inline commands with SINGLE quotes. Double quotes let your own shell
  expand $PUEUE_WAIT_* to nothing before this tool ever sees it.

  A bare one-word command is shadowed by a same-named file in the working
  directory, because existing files win: with a ./true file present,
  --until 'true' runs that file, not the shell builtin.

Exit codes:
  0  tasks reached the target status, or an --until condition passed
  1  the wait completed but a task failed (--fail-on-error / --status success)
  2  usage error
  3  --timeout elapsed
  4  a --while condition failed
  5  pueue could not be reached or understood
  6  a condition script could not be executed
  7  named task ids never appeared (see --task-grace)
`;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        group: { type: 'string', short: 'g' },
        all: { type: 'boolean', short: 'a' },
        quiet: { type: 'boolean', short: 'q' },
        status: { type: 'string', short: 's' },
        timeout: { type: 'string', short: 't' },
        interval: { type: 'string', short: 'i' },
        until: { type: 'string', short: 'u', multiple: true },
        while: { type: 'string', short: 'w', multiple: true },
        'condition-timeout': { type: 'string' },
        'task-grace': { type: 'string' },
        'fail-on-error': { type: 'boolean' },
        'pueue-binary': { type: 'string' },
        config: { type: 'string' },
        profile: { type: 'string' },
        shell: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const values = parsed.values;
  if (values.help === true) return { kind: 'help', text: helpText() };
  if (values.version === true) return { kind: 'version' };

  const ids = parsed.positionals.map(parseTaskId);
  const group = values.group;
  const all = values.all === true;

  const selectors = [ids.length > 0, group !== undefined, all].filter(Boolean).length;
  if (selectors > 1) {
    throw new UsageError('Task ids, --group and --all are mutually exclusive');
  }
  if (group !== undefined && group.trim() === '') {
    throw new UsageError('--group expects a non-empty group name');
  }

  const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
  const selection: Selection =
    uniqueIds.length > 0
      ? { mode: 'ids', ids: uniqueIds }
      : group !== undefined
        ? { mode: 'group', group }
        : all
          ? { mode: 'all' }
          : { mode: 'group', group: 'default' };

  const statusRaw = (values.status ?? 'done').toLowerCase();
  if (!isTargetStatus(statusRaw)) {
    throw new UsageError(
      `--status got "${values.status}"; expected one of: ${TARGET_STATUSES.join(', ')}`,
    );
  }
  const targetStatus: TargetStatus = statusRaw;

  const timeoutMs = values.timeout === undefined ? null : parseDuration(values.timeout, '--timeout');
  if (timeoutMs !== null && timeoutMs <= 0) {
    throw new UsageError('--timeout must be greater than zero');
  }

  const intervalMs = values.interval === undefined ? 2_000 : parseDuration(values.interval, '--interval');
  if (intervalMs <= 0) {
    throw new UsageError('--interval must be greater than zero');
  }

  const conditionTimeoutMs =
    values['condition-timeout'] === undefined
      ? 30_000
      : parseDuration(values['condition-timeout'], '--condition-timeout');
  if (conditionTimeoutMs <= 0) {
    throw new UsageError('--condition-timeout must be greater than zero');
  }

  // `forever` restores the pre-0.1.1 behaviour of tolerating an unknown id
  // indefinitely; `0` fails on the first snapshot that lacks it.
  const graceRaw = values['task-grace'];
  const taskGraceMs =
    graceRaw === undefined
      ? 5_000
      : graceRaw.trim().toLowerCase() === 'forever'
        ? null
        : parseDuration(graceRaw, '--task-grace');
  if (taskGraceMs !== null && taskGraceMs < 0) {
    throw new UsageError('--task-grace must not be negative');
  }

  const until = (values.until ?? []).map((s) => s.trim()).filter((s) => s !== '');
  const whileConds = (values.while ?? []).map((s) => s.trim()).filter((s) => s !== '');
  if ((values.until ?? []).length !== until.length) {
    throw new UsageError('--until expects a script path or shell command, got an empty value');
  }
  if ((values.while ?? []).length !== whileConds.length) {
    throw new UsageError('--while expects a script path or shell command, got an empty value');
  }

  return {
    kind: 'run',
    options: {
      selection,
      targetStatus,
      quiet: values.quiet === true,
      timeoutMs,
      intervalMs,
      conditionTimeoutMs,
      taskGraceMs,
      until,
      while: whileConds,
      failOnError: values['fail-on-error'] === true,
      pueueBinary: values['pueue-binary'] ?? env.PUEUE_BINARY ?? 'pueue',
      pueueConfig: values.config,
      pueueProfile: values.profile,
      shell: values.shell ?? '/bin/sh',
    },
  };
}
