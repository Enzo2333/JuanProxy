import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeFixedPort,
  releasePortOccupants
} from '../src/proxy/port-process-manager.js';

test('releasePortOccupants kills external owners and leaves the current process alone', async () => {
  const killed = [];
  let lookupCount = 0;

  const result = await releasePortOccupants(8787, {
    currentPid: 10,
    listPortOwners: async () => {
      lookupCount += 1;
      return lookupCount === 1 ? [10, 20, 20, 30] : [];
    },
    killProcess(pid, signal) {
      killed.push({ pid, signal });
    }
  });

  assert.deepEqual(killed, [
    { pid: 20, signal: 'SIGKILL' },
    { pid: 30, signal: 'SIGKILL' }
  ]);
  assert.deepEqual(result, [
    { pid: 20, killed: true },
    { pid: 30, killed: true }
  ]);
});

test('releasePortOccupants reports when owners remain after kill attempts', async () => {
  await assert.rejects(
    () =>
      releasePortOccupants(8787, {
        currentPid: 10,
        timeoutMs: 1,
        listPortOwners: async () => [20],
        killProcess() {}
      }),
    /Port 8787 is still occupied by process 20/
  );
});

test('normalizeFixedPort rejects automatic or invalid ports', () => {
  assert.equal(normalizeFixedPort(8787), 8787);
  assert.throws(() => normalizeFixedPort(0), /between 1 and 65535/);
  assert.throws(() => normalizeFixedPort(65536), /between 1 and 65535/);
});
