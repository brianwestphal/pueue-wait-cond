import type { Options } from './args.js';
import { helpText, parseCliArgs, UsageError } from './args.js';
import { ConditionSpawnError } from './condition.js';
import { EXIT } from './exitCodes.js';
import { createPueueClient } from './pueue.js';
import type { PueueClient } from './pueue.js';
import { Reporter, shouldUseColor } from './reporter.js';
import type { Writer } from './reporter.js';
import { readPackageVersion } from './version.js';
import { outcomeToExitCode, waitForConditions } from './wait.js';
import { PueueError } from './pueue.js';

export interface RunOptions {
  argv: string[];
  stdout: Writer & { isTTY?: boolean };
  stderr: Writer & { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Injected in tests so the loop can run against a fake daemon. */
  createClient?: (options: Options) => PueueClient;
}

export async function run(options: RunOptions): Promise<number> {
  const env = options.env ?? process.env;
  const { stdout, stderr } = options;

  let parsed;
  try {
    parsed = parseCliArgs(options.argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`error: ${error.message}\n\nRun \`pueue-wait-cond --help\` for usage.\n`);
      return EXIT.USAGE;
    }
    throw error;
  }

  if (parsed.kind === 'help') {
    stdout.write(parsed.text);
    return EXIT.OK;
  }
  if (parsed.kind === 'version') {
    stdout.write(`${readPackageVersion()}\n`);
    return EXIT.OK;
  }

  const opts = parsed.options;
  const reporter = new Reporter({
    quiet: opts.quiet,
    out: stdout,
    err: stderr,
    color: shouldUseColor(stdout, env),
  });

  const makeClient =
    options.createClient ??
    ((o: Options) =>
      createPueueClient({
        binary: o.pueueBinary,
        config: o.pueueConfig,
        profile: o.pueueProfile,
      }));

  try {
    const outcome = await waitForConditions({
      client: makeClient(opts),
      reporter,
      options: opts,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      env,
    });
    return outcomeToExitCode(outcome, opts);
  } catch (error) {
    if (error instanceof PueueError) {
      reporter.error(`error: ${error.message}`);
      return EXIT.PUEUE_ERROR;
    }
    if (error instanceof ConditionSpawnError) {
      reporter.error(`error: ${error.message}`);
      return EXIT.CONDITION_ERROR;
    }
    throw error;
  }
}

/** Entry point used by `bin/pueue-wait-cond.js`. */
export async function main(): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const code = await run({
      argv: process.argv.slice(2),
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      signal: controller.signal,
    });
    process.exitCode = interrupted && code === EXIT.OK ? EXIT.INTERRUPTED : code;
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = EXIT.PUEUE_ERROR;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export { helpText };
