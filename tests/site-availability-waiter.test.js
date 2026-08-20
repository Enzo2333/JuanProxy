import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { SiteAvailabilityWaiter } from '../src/proxy/site-availability-waiter.js';

class FakeConfig extends EventEmitter {
  constructor(state) {
    super();
    this.state = state;
  }

  getState() {
    return structuredClone(this.state);
  }
}

function recoverableState(enabled = true) {
  return {
    proxy: { codexRecoveryEnabled: enabled },
    sites: [
      {
        id: 'recoverable',
        manualEnabled: true,
        failureDisabled: true,
        enabled: false,
        autoRecovery: { enabled: true }
      }
    ]
  };
}

test('does not wait when Codex recovery is disabled', async () => {
  const configService = new FakeConfig(recoverableState(false));
  const waiter = new SiteAvailabilityWaiter({ configService });

  const result = await waiter.wait();

  assert.deepEqual(result, { reason: 'disabled' });
  assert.equal(waiter.getStatus().pendingRequests, 0);
});

test('wakes a pending request on a configuration change', async () => {
  const configService = new FakeConfig(recoverableState(true));
  const waiter = new SiteAvailabilityWaiter({
    configService,
    waitTimeoutMs: 500,
    pollIntervalMs: 500
  });

  const pending = waiter.wait();
  assert.equal(waiter.getStatus().pendingRequests, 1);
  configService.emit('changed');

  assert.deepEqual(await pending, { reason: 'retry' });
  assert.equal(waiter.getStatus().pendingRequests, 0);
});

test('enforces capacity and releases a slot when the client disconnects', async () => {
  const configService = new FakeConfig(recoverableState(true));
  const waiter = new SiteAvailabilityWaiter({
    configService,
    maxPendingRequests: 1,
    waitTimeoutMs: 500,
    pollIntervalMs: 500
  });
  const firstClient = new EventEmitter();

  const first = waiter.wait({ abortEmitter: firstClient });
  const second = await waiter.wait();
  assert.deepEqual(second, { reason: 'capacity' });

  firstClient.emit('close');
  assert.deepEqual(await first, { reason: 'aborted' });
  assert.equal(waiter.getStatus().pendingRequests, 0);
});

test('returns unavailable without consuming capacity when no site can recover', async () => {
  const configService = new FakeConfig({
    proxy: { codexRecoveryEnabled: true },
    sites: [{ id: 'manual-off', manualEnabled: false, enabled: false }]
  });
  const waiter = new SiteAvailabilityWaiter({ configService });

  assert.deepEqual(await waiter.wait(), { reason: 'unavailable' });
  assert.equal(waiter.getStatus().pendingRequests, 0);
});
