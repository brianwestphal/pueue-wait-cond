import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Read the package version at runtime.
 *
 * The relative depth from this module to `package.json` differs between running
 * the TypeScript sources directly (`src/`) and running the build output
 * (`dist/src/`), so we walk up until we find our own manifest instead of
 * hard-coding a `../..`.
 */
export function readPackageVersion(startDir: string = import.meta.dirname): string {
  let dir = startDir;
  for (;;) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (pkg.name === 'pueue-wait-cond' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Keep walking; a missing or unreadable manifest here is not fatal.
    }
    const parent = dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}
