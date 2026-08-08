/**
 * Thin wrapper around the `pueue` CLI.
 *
 * We shell out to `pueue status --json` rather than speaking the daemon's socket
 * protocol directly: the JSON output is a stable, documented surface, and it
 * keeps this package free of runtime dependencies and of any pueue version
 * coupling beyond "has `status --json`".
 */
import { execFile } from 'node:child_process';

import type { Snapshot } from './status.js';
import { parseSnapshot, PueueParseError } from './status.js';

export class PueueError extends Error {}

export interface PueueClientOptions {
  /** Path to (or name of) the pueue binary. */
  binary: string;
  /** Forwarded as `--config`. */
  config?: string | undefined;
  /** Forwarded as `--profile`. */
  profile?: string | undefined;
  /** Milliseconds before a `pueue status` invocation is considered hung. */
  timeoutMs?: number;
}

export interface PueueClient {
  fetchSnapshot(): Promise<Snapshot>;
  /** The argv that would be run, for diagnostics and tests. */
  describe(): string;
}

const DEFAULT_STATUS_TIMEOUT_MS = 30_000;

function statusArgs(options: PueueClientOptions): string[] {
  const args: string[] = [];
  if (options.config !== undefined) args.push('--config', options.config);
  if (options.profile !== undefined) args.push('--profile', options.profile);
  args.push('status', '--json');
  return args;
}

function runStatus(options: PueueClientOptions): Promise<string> {
  const args = statusArgs(options);
  return new Promise((resolve, reject) => {
    execFile(
      options.binary,
      args,
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS,
        // pueue dumps every task's full environment into the JSON, so the
        // payload gets large fast on a busy daemon. 64 MiB of headroom.
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          reject(
            new PueueError(
              `Could not find the pueue binary "${options.binary}". ` +
                `Install pueue, or point at it with --pueue-binary / $PUEUE_BINARY.`,
            ),
          );
          return;
        }
        const detail = (stderr || stdout || error.message).trim();
        reject(new PueueError(`\`${options.binary} ${args.join(' ')}\` failed:\n${detail}`));
      },
    );
  });
}

export function createPueueClient(options: PueueClientOptions): PueueClient {
  return {
    describe: () => [options.binary, ...statusArgs(options)].join(' '),
    async fetchSnapshot(): Promise<Snapshot> {
      const stdout = await runStatus(options);
      let raw: unknown;
      try {
        raw = JSON.parse(stdout) as unknown;
      } catch (error) {
        throw new PueueError(
          `Could not parse the JSON from \`${options.binary} status --json\`: ${(error as Error).message}`,
        );
      }
      try {
        return parseSnapshot(raw);
      } catch (error) {
        if (error instanceof PueueParseError) throw new PueueError(error.message);
        throw error;
      }
    },
  };
}
