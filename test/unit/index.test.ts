import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as api from '../../src/index.js';

/**
 * The barrel is the package's public surface, so a rename that drops an export
 * should fail here rather than silently at a consumer's `import`.
 */
describe('public API', () => {
  const expected = [
    'EXIT',
    'PueueError',
    'PueueParseError',
    'Reporter',
    'TARGET_STATUSES',
    'UsageError',
    'ConditionSpawnError',
    'conditionEnv',
    'createPueueClient',
    'describeStatus',
    'exitCodeName',
    'hasReached',
    'helpText',
    'isFailure',
    'isFinished',
    'isSuccess',
    'isTargetStatus',
    'isUnreachable',
    'main',
    'outcomeToExitCode',
    'parseCliArgs',
    'parseDuration',
    'parseSnapshot',
    'readPackageVersion',
    'resolveCommand',
    'run',
    'runCondition',
    'selectTasks',
    'shouldUseColor',
    'snapshotForConditions',
    'waitForConditions',
  ];

  for (const name of expected) {
    it(`exports ${name}`, () => {
      assert.ok(name in api, `missing export: ${name}`);
      assert.notEqual((api as Record<string, unknown>)[name], undefined);
    });
  }

  it('exports nothing unexpected', () => {
    assert.deepEqual([...Object.keys(api)].sort(), [...expected].sort());
  });

  it('is usable end to end through the barrel alone', () => {
    const snapshot = api.parseSnapshot({
      tasks: { 1: { id: 1, status: { Done: { result: 'Success' } } } },
      groups: {},
    });
    const task = snapshot.tasks.get(1);
    assert.ok(task);
    assert.equal(api.hasReached(task, 'done'), true);
    assert.equal(api.exitCodeName(api.EXIT.TIMEOUT), 'TIMEOUT');
  });
});
