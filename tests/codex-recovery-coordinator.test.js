import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { CodexRecoveryCoordinator } from '../src/codex/codex-recovery-coordinator.js';

class FakeConfig extends EventEmitter {
  constructor({ enabled = true, siteAvailable = false } = {}) {
    super();
    this.state = {
      proxy: { codexRecoveryEnabled: enabled },
      sites: [{
        id: 'site-1',
        manualEnabled: true,
        enabled: siteAvailable,
        rateLimit: { enabled: false }
      }]
    };
  }

  getState() {
    return structuredClone(this.state);
  }

  setEnabled(enabled) {
    this.state.proxy.codexRecoveryEnabled = enabled;
    this.emit('changed');
  }

  setSiteAvailable(available) {
    this.state.sites[0].enabled = available;
    this.emit('changed');
  }
}

function failure(overrides = {}) {
  return {
    threadId: 'thread-1',
    failedTurnId: 'turn-1',
    rolloutPath: 'rollout.jsonl',
    cwd: 'E:\\repo',
    failedAt: '2026-07-31T02:40:00.000Z',
    ...overrides
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('queues an exact failure and resumes it after a site becomes available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-coordinator-'));
  const configService = new FakeConfig();
  const resumed = [];
  const detectedFailure = failure();
  const coordinator = new CodexRecoveryCoordinator({
    configService,
    sessionsDir: join(dir, 'sessions'),
    queueFilePath: join(dir, 'queue.json'),
    scanDelaysMs: [],
    findFailures: async () => [detectedFailure],
    inspectRollout: async () => detectedFailure,
    resumeThread: async (entry) => {
      resumed.push(entry);
      return { started: true, goalStatus: 'active', turnStatus: 'completed' };
    }
  });

  try {
    await coordinator.start();
    await coordinator.scanNow({ sinceMs: 0 });
    assert.equal(coordinator.getStatus().pendingTasks, 1);

    configService.setSiteAvailable(true);
    await settle();

    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].threadId, 'thread-1');
    assert.equal(coordinator.getStatus().pendingTasks, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8')).pending, []);
  } finally {
    await coordinator.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('deduplicates failures by thread and persists only recovery metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-dedupe-'));
  const configService = new FakeConfig();
  const coordinator = new CodexRecoveryCoordinator({
    configService,
    sessionsDir: join(dir, 'sessions'),
    queueFilePath: join(dir, 'queue.json'),
    scanDelaysMs: [],
    findFailures: async () => [
      failure(),
      failure({ failedTurnId: 'turn-2', failedAt: '2026-07-31T02:41:00.000Z' })
    ],
    inspectRollout: async () => null,
    resumeThread: async () => ({ started: true })
  });

  try {
    await coordinator.start();
    await coordinator.scanNow({ sinceMs: 0 });

    const payload = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8'));
    assert.equal(payload.pending.length, 1);
    assert.equal(payload.pending[0].failedTurnId, 'turn-2');
    assert.deepEqual(Object.keys(payload.pending[0]).sort(), [
      'attempts',
      'cwd',
      'detectedAt',
      'failedAt',
      'failedTurnId',
      'lastError',
      'rolloutPath',
      'threadId'
    ]);
  } finally {
    await coordinator.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('serializes concurrent queue updates without losing recovery metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-concurrent-'));
  const configService = new FakeConfig();
  let scanNumber = 0;
  const coordinator = new CodexRecoveryCoordinator({
    configService,
    sessionsDir: join(dir, 'sessions'),
    queueFilePath: join(dir, 'queue.json'),
    scanDelaysMs: [],
    findFailures: async () => {
      scanNumber += 1;
      return [failure({
        threadId: `thread-${scanNumber}`,
        failedTurnId: `turn-${scanNumber}`
      })];
    },
    inspectRollout: async () => null,
    resumeThread: async () => ({ started: true })
  });

  try {
    await coordinator.start();
    await Promise.all(Array.from({ length: 8 }, () => coordinator.scanNow({ sinceMs: 0 })));

    const payload = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8'));
    assert.equal(payload.pending.length, 8);
    assert.deepEqual(
      payload.pending.map((entry) => entry.threadId).sort(),
      Array.from({ length: 8 }, (_, index) => `thread-${index + 1}`).sort()
    );
  } finally {
    await coordinator.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('drops stale queued work when the thread has a newer lifecycle event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-stale-'));
  const configService = new FakeConfig({ siteAvailable: true });
  let resumeCalls = 0;
  const coordinator = new CodexRecoveryCoordinator({
    configService,
    sessionsDir: join(dir, 'sessions'),
    queueFilePath: join(dir, 'queue.json'),
    scanDelaysMs: [],
    findFailures: async () => [failure()],
    inspectRollout: async () => null,
    resumeThread: async () => {
      resumeCalls += 1;
    }
  });

  try {
    await coordinator.start();
    await coordinator.scanNow({ sinceMs: 0 });
    await settle();

    assert.equal(resumeCalls, 0);
    assert.equal(coordinator.getStatus().pendingTasks, 0);
  } finally {
    await coordinator.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabling the switch clears queued recoveries and prevents new scans', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-disabled-'));
  const configService = new FakeConfig();
  let scans = 0;
  const coordinator = new CodexRecoveryCoordinator({
    configService,
    sessionsDir: join(dir, 'sessions'),
    queueFilePath: join(dir, 'queue.json'),
    scanDelaysMs: [],
    findFailures: async () => {
      scans += 1;
      return [failure()];
    },
    inspectRollout: async () => failure(),
    resumeThread: async () => ({ started: true })
  });

  try {
    await coordinator.start();
    await coordinator.scanNow({ sinceMs: 0 });
    assert.equal(coordinator.getStatus().pendingTasks, 1);

    configService.setEnabled(false);
    await settle();
    await coordinator.scanNow({ sinceMs: 0 });

    assert.equal(coordinator.getStatus().enabled, false);
    assert.equal(coordinator.getStatus().pendingTasks, 0);
    assert.equal(scans, 1);
  } finally {
    await coordinator.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabling the switch cancels an active continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-cancel-'));
  const configService = new FakeConfig({ siteAvailable: true });
  let continuationStarted;
  const started = new Promise((resolve) => {
    continuationStarted = resolve;
  });
  const coordinator = new CodexRecoveryCoordinator({
    configService,
    sessionsDir: join(dir, 'sessions'),
    queueFilePath: join(dir, 'queue.json'),
    scanDelaysMs: [],
    findFailures: async () => [failure()],
    inspectRollout: async () => failure(),
    resumeThread: async ({ signal }) => {
      continuationStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    }
  });

  try {
    await coordinator.start();
    const scanPromise = coordinator.scanNow({ sinceMs: 0 });
    await started;
    configService.setEnabled(false);
    await scanPromise;
    await settle();

    assert.equal(coordinator.getStatus().enabled, false);
    assert.equal(coordinator.getStatus().pendingTasks, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8')).pending, []);
  } finally {
    await coordinator.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
