import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

interface PackageManifest {
  scripts?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as PackageManifest;

describe('package test scripts', () => {
  it('leave test globs unquoted for the npm shell to expand on Node 20', () => {
    assert.equal(manifest.scripts?.['test:unit'], 'node --import tsx --test test/unit/*.test.ts');
    assert.equal(
      manifest.scripts?.['test:e2e'],
      'node --import tsx --test --test-concurrency=1 test/e2e/*.test.ts',
    );
  });
});
