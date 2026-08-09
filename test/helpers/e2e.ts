import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const CLI_BIN = join(REPO_ROOT, 'bin', 'pueue-wait-cond.js');

export interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Sent to the child once it has been alive this long; used for SIGINT tests. */
  killAfterMs?: number;
  killSignal?: NodeJS.Signals;
}

/** Run the published entry point as a real child process. */
export function runCli(args: string[], options: CliRunOptions = {}): Promise<CliRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });

    const hardTimer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`pueue-wait-cond ${args.join(' ')} did not exit in time`));
    }, options.timeoutMs ?? 60_000);

    const killTimer =
      options.killAfterMs === undefined
        ? null
        : setTimeout(() => child.kill(options.killSignal ?? 'SIGINT'), options.killAfterMs);

    child.on('error', (error) => {
      clearTimeout(hardTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      rejectPromise(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(hardTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

/** Write an executable helper script into `dir` and return its path. */
export function writeScript(dir: string, name: string, body: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, mode);
  return path;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function which(binary: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  return paths.some((p) => p !== '' && existsSync(join(p, binary)));
}

export const HAS_PUEUE = which('pueue') && which('pueued');

/**
 * Set `PWC_REQUIRE_PUEUE=1` to turn a missing pueue into a **failure** instead
 * of a silent skip.
 *
 * CI sets it. Without it, a runner that failed to install pueue would produce a
 * green run in which the entire real-daemon suite quietly did nothing — the
 * worst kind of passing build.
 */
export const REQUIRE_PUEUE = (process.env.PWC_REQUIRE_PUEUE ?? '') !== '';

/** An isolated pueue daemon: its own directory, socket, state and config. */
export class TestDaemon {
  readonly dir: string;
  readonly configPath: string;

  private constructor(dir: string) {
    this.dir = dir;
    this.configPath = join(dir, 'pueue.yml');
  }

  static async start(): Promise<TestDaemon> {
    const dir = makeTempDir('pwc-daemon-');
    const daemon = new TestDaemon(dir);
    writeFileSync(
      daemon.configPath,
      [
        'shared:',
        `  pueue_directory: ${dir}`,
        '  use_unix_socket: true',
        'client: {}',
        'daemon: {}',
        '',
      ].join('\n'),
      'utf8',
    );

    await daemon.exec('pueued', ['-c', daemon.configPath, '-d']);
    await daemon.waitUntilReachable();
    // One worker is not enough to observe queueing behaviour.
    await daemon.pueue(['parallel', '4']);
    return daemon;
  }

  private exec(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(binary, args, { encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(new Error(`${binary} ${args.join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      });
    });
  }

  private async waitUntilReachable(): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await this.pueue(['status', '--json']);
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  /** Run a pueue subcommand against this daemon. */
  pueue(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec('pueue', ['-c', this.configPath, ...args]);
  }

  /** Enqueue a shell command and return its task id. */
  async add(command: string, extra: string[] = []): Promise<number> {
    const { stdout } = await this.pueue(['add', ...extra, '--', command]);
    const match = /\(id (\d+)\)/.exec(stdout);
    if (match?.[1] === undefined) throw new Error(`could not read a task id from: ${stdout}`);
    return Number(match[1]);
  }

  async addGroup(name: string): Promise<void> {
    await this.pueue(['group', 'add', name]);
  }

  /** Args that point pueue-wait-cond at this daemon. */
  cliArgs(): string[] {
    return ['--config', this.configPath];
  }

  async stop(): Promise<void> {
    try {
      await this.pueue(['shutdown']);
    } catch {
      // The daemon may already be gone; the directory removal below is enough.
    }
    await new Promise((r) => setTimeout(r, 300));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export { rmSync };
