import type { Options } from './args.js';
import { helpText, parseCliArgs, UsageError } from './args.js';
import { ConditionSpawnError } from './condition.js';
import { EXIT } from './exitCodes.js';
import { buildJsonError, buildJsonResult, renderJson } from './json.js';
import type { JsonErrorKind } from './json.js';
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

  // A usage error happens before the arguments are understood, so `--json` has
  // to be sniffed out of argv directly — otherwise the one case a caller most
  // needs machine-readable (they got the invocation wrong) would print prose.
  const wantsJson = options.argv.includes('--json');
  const fail = (kind: JsonErrorKind, message: string, code: number): number => {
    if (wantsJson) {
      stdout.write(renderJson(buildJsonError(kind, message, code)));
    } else {
      stderr.write(`error: ${message}\n`);
    }
    return code;
  };

  let parsed;
  try {
    parsed = parseCliArgs(options.argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      if (wantsJson) return fail('usage', error.message, EXIT.USAGE);
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
    const resolution = await waitForConditions({
      client: makeClient(opts),
      reporter,
      options: opts,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      env,
    });
    const code = outcomeToExitCode(resolution, opts);
    if (opts.json) stdout.write(renderJson(buildJsonResult(resolution, code)));
    return code;
  } catch (error) {
    if (error instanceof PueueError) {
      return fail('pueue', error.message, EXIT.PUEUE_ERROR);
    }
    if (error instanceof ConditionSpawnError) {
      return fail('condition', error.message, EXIT.CONDITION_ERROR);
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
