import type { Options, Selection } from '../../src/args.js';
import type { PueueClient } from '../../src/pueue.js';
import { Reporter } from '../../src/reporter.js';
import type { Writer } from '../../src/reporter.js';
import type { Snapshot } from '../../src/status.js';
import { parseSnapshot } from '../../src/status.js';

/** A `Writer` that keeps everything it is handed. */
export class StringWriter implements Writer {
  chunks: string[] = [];
  isTTY = false;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  get text(): string {
    return this.chunks.join('');
  }

  get lines(): string[] {
    return this.text.split('\n').filter((l) => l !== '');
  }
}

export interface RawTaskSpec {
  id: number;
  status: unknown;
  group?: string;
  label?: string | null;
  command?: string;
}

/** Build a raw `pueue status --json` payload, then parse it like the real thing. */
export function makeSnapshot(
  tasks: RawTaskSpec[],
  groups: Record<string, { status: string; parallel_tasks: number }> = {
    default: { status: 'Running', parallel_tasks: 1 },
  },
): Snapshot {
  const raw = {
    tasks: Object.fromEntries(
      tasks.map((t) => [
        String(t.id),
        {
          id: t.id,
          group: t.group ?? 'default',
          label: t.label ?? null,
          command: t.command ?? `echo ${t.id}`,
          status: t.status,
        },
      ]),
    ),
    groups,
  };
  return parseSnapshot(raw);
}

export const QUEUED = 'Queued';
export const RUNNING = { Running: { enqueued_at: 'x', start: 'y' } };
export const STASHED = { Stashed: { enqueued_at: null } };
export const PAUSED = 'Paused';
export const LOCKED = 'Locked';

export function done(result: unknown = 'Success'): unknown {
  return { Done: { enqueued_at: 'x', start: 'y', end: 'z', result } };
}

export function failed(exitCode = 1): unknown {
  return done({ Failed: exitCode });
}

/** Thrown when a wait loop polls far past the end of its script. */
export class RunawayLoopError extends Error {}

/**
 * A client that walks a scripted list of snapshots, repeating the last one so a
 * loop that polls a few extra times still behaves.
 *
 * Because the tests inject a no-op `sleep`, a wait that never resolves would
 * spin the CPU forever rather than failing, so polling well past the script is
 * treated as a test bug and raised immediately.
 */
export class ScriptedClient implements PueueClient {
  calls = 0;
  constructor(
    private readonly script: Array<Snapshot | Error>,
    private readonly maxCalls = 50,
    readonly onFetch?: (call: number) => void,
  ) {}

  describe(): string {
    return 'scripted-pueue status --json';
  }

  async fetchSnapshot(): Promise<Snapshot> {
    if (this.calls >= this.maxCalls) {
      throw new RunawayLoopError(
        `wait loop polled ${this.calls} times for a ${this.script.length}-step script; ` +
          `it is not converging`,
      );
    }
    const index = Math.min(this.calls, this.script.length - 1);
    this.calls += 1;
    this.onFetch?.(this.calls);
    const entry = this.script[index];
    if (entry === undefined) throw new Error('ScriptedClient has an empty script');
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

export function makeOptions(overrides: Partial<Options> = {}): Options {
  const selection: Selection = overrides.selection ?? { mode: 'group', group: 'default' };
  return {
    selection,
    targetStatus: 'done',
    quiet: true,
    timeoutMs: null,
    intervalMs: 1,
    conditionTimeoutMs: 5_000,
    // Tests that care about the grace set it explicitly; `forever` keeps every
    // other test on the pre-existing "tolerate unknown ids" behaviour.
    taskGraceMs: null,
    until: [],
    while: [],
    failOnError: false,
    pueueBinary: 'pueue',
    pueueConfig: undefined,
    pueueProfile: undefined,
    shell: '/bin/sh',
    ...overrides,
  };
}

export interface Harness {
  out: StringWriter;
  err: StringWriter;
  reporter: Reporter;
}

export function makeReporter(quiet = false): Harness {
  const out = new StringWriter();
  const err = new StringWriter();
  const reporter = new Reporter({
    quiet,
    out,
    err,
    color: false,
    now: () => new Date(2026, 0, 1, 12, 0, 0),
  });
  return { out, err, reporter };
}

/** A `sleep` that never actually waits, but records how long it was asked for. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

/** A monotonic clock that advances a fixed amount per read. */
export function fakeClock(stepMs: number, startMs = 0): () => number {
  let t = startMs;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}
