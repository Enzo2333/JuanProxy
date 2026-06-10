import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { PortOccupancyGuard } from '../src/proxy/port-occupancy-guard.js';

test('PortOccupancyGuard disables runtime polling by default', () => {
  const guard = new PortOccupancyGuard({
    configService: {
      getState() {
        return { proxy: { port: 8787 } };
      }
    },
    proxyServer: new FakeProxyServer(),
    logger: { warn() {}, error() {} }
  });

  assert.equal(guard.runtimePolling, false);
  assert.equal(guard.intervalMs >= 60_000, true);
});

test('PortOccupancyGuard releases configured port during runtime', async () => {
  const calls = [];
  const guard = new PortOccupancyGuard({
    configService: {
      getState() {
        return { proxy: { port: 8787 } };
      }
    },
    proxyServer: new FakeProxyServer(),
    releasePort: async (port) => {
      calls.push(port);
      return [{ pid: 20, killed: true }];
    },
    logger: { warn() {}, error() {} }
  });
  const released = onceEvent(guard, 'released');

  const result = await guard.checkNow();

  assert.deepEqual(calls, [8787]);
  assert.deepEqual(result, [{ pid: 20, killed: true }]);
  assert.deepEqual(await released, { port: 8787, processes: [{ pid: 20, killed: true }] });
});

test('PortOccupancyGuard records startup error when runtime release fails', async () => {
  const proxyServer = new FakeProxyServer();
  const error = new Error('access denied');
  const guard = new PortOccupancyGuard({
    configService: {
      getState() {
        return { proxy: { port: 8787 } };
      }
    },
    proxyServer,
    releasePort: async () => {
      throw error;
    },
    logger: { warn() {}, error() {} }
  });
  const guardError = onceEvent(guard, 'guard-error');

  await assert.rejects(() => guard.checkNow(), /access denied/);

  assert.equal(proxyServer.startupError, error);
  assert.equal(await guardError, error);
});

test('PortOccupancyGuard skips overlapping checks', async () => {
  let releaseCount = 0;
  let resume;
  const firstRelease = new Promise((resolve) => {
    resume = resolve;
  });
  const guard = new PortOccupancyGuard({
    configService: {
      getState() {
        return { proxy: { port: 8787 } };
      }
    },
    proxyServer: new FakeProxyServer(),
    releasePort: async () => {
      releaseCount += 1;
      await firstRelease;
      return [];
    },
    logger: { warn() {}, error() {} }
  });

  const first = guard.checkNow();
  const second = await guard.checkNow();
  resume();
  await first;

  assert.equal(second, null);
  assert.equal(releaseCount, 1);
});

class FakeProxyServer extends EventEmitter {
  setStartupError(error) {
    this.startupError = error;
  }
}

function onceEvent(emitter, eventName) {
  return new Promise((resolve) => {
    emitter.once(eventName, resolve);
  });
}
