import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createPueueClient, PueueError } from '../../src/pueue.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwc-pueue-test-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the pueue binary, so the tests never touch a real daemon. */
function fakePueue(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

describe('createPueueClient', () => {
  it('describes the command it will run', () => {
    const client = createPueueClient({ binary: 'pueue' });
    assert.equal(client.describe(), 'pueue status --json');
  });

  it('includes --config and --profile in the command', () => {
    const client = createPueueClient({ binary: 'pueue', config: '/c.toml', profile: 'ci' });
    assert.equal(client.describe(), 'pueue --config /c.toml --profile ci status --json');
  });

  it('parses a snapshot from the binary output', async () => {
    const binary = fakePueue('ok', `echo '{"tasks":{"1":{"id":1,"status":"Queued"}},"groups":{}}'`);
    const snapshot = await createPueueClient({ binary }).fetchSnapshot();
    assert.equal(snapshot.tasks.get(1)?.kind, 'Queued');
  });

  it('forwards --config and --profile to the binary', async () => {
    const binary = fakePueue(
      'args',
      `echo "{\\"tasks\\":{},\\"groups\\":{}}"; echo "$@" > "${join(dir, 'args.txt')}"`,
    );
    await createPueueClient({ binary, config: '/c.toml', profile: 'ci' }).fetchSnapshot();
    const { readFileSync } = await import('node:fs');
    assert.equal(
      readFileSync(join(dir, 'args.txt'), 'utf8').trim(),
      '--config /c.toml --profile ci status --json',
    );
  });

  it('reports a missing binary with an actionable message', async () => {
    const client = createPueueClient({ binary: join(dir, 'does-not-exist') });
    await assert.rejects(client.fetchSnapshot(), (error: unknown) => {
      assert.ok(error instanceof PueueError);
      assert.match(error.message, /Could not find the pueue binary/);
      assert.match(error.message, /--pueue-binary/);
      return true;
    });
  });

  it('surfaces the daemon error text when pueue exits non-zero', async () => {
    const binary = fakePueue('down', 'echo "Failed to connect to daemon" >&2; exit 1');
    await assert.rejects(createPueueClient({ binary }).fetchSnapshot(), (error: unknown) => {
      assert.ok(error instanceof PueueError);
      assert.match(error.message, /Failed to connect to daemon/);
      return true;
    });
  });

  it('rejects output that is not JSON', async () => {
    const binary = fakePueue('garbage', 'echo "not json at all"');
    await assert.rejects(createPueueClient({ binary }).fetchSnapshot(), (error: unknown) => {
      assert.ok(error instanceof PueueError);
      assert.match(error.message, /Could not parse the JSON/);
      return true;
    });
  });

  it('rejects JSON that is not a pueue status payload', async () => {
    const binary = fakePueue('wrong-shape', `echo '{"nope":true}'`);
    await assert.rejects(createPueueClient({ binary }).fetchSnapshot(), (error: unknown) => {
      assert.ok(error instanceof PueueError);
      assert.match(error.message, /no "tasks" object/);
      return true;
    });
  });

  it('gives up on a binary that hangs', async () => {
    const binary = fakePueue('hang', 'sleep 30');
    await assert.rejects(createPueueClient({ binary, timeoutMs: 150 }).fetchSnapshot(), PueueError);
  });

  it('handles the large payloads a busy daemon produces', async () => {
    // pueue embeds each task's whole environment, so the buffer has to be big.
    const binary = fakePueue(
      'big',
      `node -e '
        const tasks = {};
        for (let i = 0; i < 400; i++) {
          tasks[i] = { id: i, status: "Queued", envs: { BLOB: "x".repeat(20000) } };
        }
        process.stdout.write(JSON.stringify({ tasks, groups: {} }));
      '`,
    );
    const snapshot = await createPueueClient({ binary }).fetchSnapshot();
    assert.equal(snapshot.tasks.size, 400);
  });
});
