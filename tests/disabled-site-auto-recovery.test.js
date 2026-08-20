import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { recoverDueDisabledSites } from '../src/proxy/disabled-site-auto-recovery.js';
import { ConfigService } from '../src/proxy/config-service.js';

function rawSite(overrides = {}) {
  const manualEnabled = overrides.manualEnabled ?? true;
  const failureDisabled = overrides.failureDisabled ?? !overrides.enabled;
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    baseUrl: `https://${overrides.id}.example/v1`,
    apiKey: `sk-${overrides.id}`,
    priority: 100,
    manualEnabled,
    failureDisabled,
    enabled: manualEnabled && !failureDisabled,
    status: 'idle',
    consecutiveErrors: 0,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    errorLog: [],
    autoRecovery: overrides.autoRecovery ?? {
      enabled: true,
      intervalValue: 1,
      intervalUnit: 'minute'
    },
    autoRecoveryState: overrides.autoRecoveryState ?? {
      lastCheckedAt: null,
      nextCheckAt: '2026-06-03T08:00:00.000Z',
      lastResult: null,
      lastMessage: null
    },
    createdAt: '2026-06-03T07:00:00.000Z',
    updatedAt: '2026-06-03T07:00:00.000Z'
  };
}

test('recovers passing due disabled sites and reschedules failing sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-recovery-run-'));
  const filePath = join(dir, 'config.json');

  try {
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          version: 1,
          activeSiteId: null,
          proxy: {
            port: 8787,
            testModel: 'global-recovery-model',
            failureThreshold: 3,
            smartSwitching: true,
            samePriorityStrategy: 'round-robin',
            lastSelectedSiteId: null
          },
          sites: [
            rawSite({ id: 'passing' }),
            rawSite({ id: 'failing' }),
            rawSite({
              id: 'later',
              autoRecoveryState: {
                lastCheckedAt: null,
                nextCheckAt: '2026-06-03T08:10:00.000Z',
                lastResult: null,
                lastMessage: null
              }
            }),
            rawSite({
              id: 'enabled',
              enabled: true,
              failureDisabled: false
            }),
            rawSite({
              id: 'manual',
              manualEnabled: false,
              failureDisabled: false
            }),
            rawSite({
              id: 'off',
              autoRecovery: {
                enabled: false,
                intervalValue: 1,
                intervalUnit: 'minute'
              }
            })
          ]
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const config = new ConfigService({ filePath });
    await config.load();

    const checked = [];
    const result = await recoverDueDisabledSites({
      configService: config,
      now: new Date('2026-06-03T08:00:01.000Z'),
      testSite: async (site, options) => {
        checked.push(site.id);
        assert.deepEqual(options, { testModel: 'global-recovery-model' });
        return {
          ok: site.id === 'passing',
          statusCode: site.id === 'passing' ? 200 : 401,
          message: site.id === 'passing' ? 'ok' : 'bad key',
          detail: site.id === 'passing' ? null : 'invalid'
        };
      }
    });

    const state = config.getState();
    const passing = state.sites.find((site) => site.id === 'passing');
    const failing = state.sites.find((site) => site.id === 'failing');
    const later = state.sites.find((site) => site.id === 'later');

    assert.deepEqual(checked, ['passing', 'failing']);
    assert.deepEqual(result.recoveredSites.map((site) => site.id), ['passing']);
    assert.deepEqual(result.failedSites.map((site) => site.id), ['failing']);
    assert.equal(passing.enabled, true);
    assert.equal(passing.status, 'success');
    assert.equal(passing.autoRecoveryState.lastResult, 'success');
    assert.equal(passing.autoRecoveryState.nextCheckAt, null);
    assert.equal(failing.enabled, false);
    assert.equal(failing.status, 'error');
    assert.equal(failing.autoRecoveryState.lastResult, 'failure');
    assert.equal(failing.autoRecoveryState.lastMessage, 'bad key');
    assert.equal(failing.autoRecoveryState.nextCheckAt, '2026-06-03T08:01:01.000Z');
    assert.equal(later.enabled, false);
    assert.equal(state.activeSiteId, 'enabled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tests multiple due sites concurrently so a slow site does not hold the batch', async () => {
  const sites = ['slow', 'fast-one', 'fast-two'].map((id) => rawSite({ id }));
  let releaseSlow;
  const slowReleased = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const calls = [];
  const recorded = [];

  const run = recoverDueDisabledSites({
    configService: {
      getDueDisabledAutoRecoverySites() {
        return structuredClone(sites);
      },
      getState() {
        return { proxy: { testModel: 'global-recovery-model' } };
      },
      async recordSiteAutoRecoverySuccess(id) {
        recorded.push(['success', id]);
        return sites.find((site) => site.id === id);
      },
      async recordSiteAutoRecoveryFailure(id) {
        recorded.push(['failure', id]);
        return sites.find((site) => site.id === id);
      }
    },
    concurrency: 2,
    now: new Date('2026-06-03T08:00:00.000Z'),
    testSite: async (site) => {
      calls.push(site.id);
      if (site.id === 'slow') {
        await slowReleased;
      }
      return { ok: true, statusCode: 200, message: 'ok' };
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(calls.includes('fast-one'));
  assert.ok(calls.includes('fast-two'));

  releaseSlow();
  const result = await run;

  assert.deepEqual(calls, ['slow', 'fast-one', 'fast-two']);
  assert.deepEqual(recorded.map((entry) => entry[1]).sort(), ['fast-one', 'fast-two', 'slow']);
  assert.deepEqual(result.recoveredSites.map((site) => site.id).sort(), [
    'fast-one',
    'fast-two',
    'slow'
  ]);
});

test('continues checking remaining due sites when one test throws', async () => {
  const sites = ['broken', 'healthy'].map((id) => rawSite({ id }));
  const calls = [];
  const failures = [];

  const result = await recoverDueDisabledSites({
    configService: {
      getDueDisabledAutoRecoverySites() {
        return structuredClone(sites);
      },
      getState() {
        return { proxy: { testModel: 'global-recovery-model' } };
      },
      async recordSiteAutoRecoverySuccess(id) {
        return sites.find((site) => site.id === id);
      },
      async recordSiteAutoRecoveryFailure(id, error) {
        failures.push({ id, message: error.message });
        return sites.find((site) => site.id === id);
      }
    },
    concurrency: 2,
    testSite: async (site) => {
      calls.push(site.id);
      if (site.id === 'broken') {
        throw new Error('transport exploded');
      }
      return { ok: true, statusCode: 200, message: 'ok' };
    }
  });

  assert.deepEqual(calls, ['broken', 'healthy']);
  assert.deepEqual(failures, [{ id: 'broken', message: 'transport exploded' }]);
  assert.deepEqual(result.recoveredSites.map((site) => site.id), ['healthy']);
  assert.deepEqual(result.failedSites.map((site) => site.id), ['broken']);
});

test('skips a stale due snapshot when another check already restored the site', async () => {
  const site = rawSite({
    id: 'restored-while-queued',
    autoRecoveryState: {
      lastCheckedAt: null,
      nextCheckAt: '2026-06-03T08:00:00.000Z',
      lastResult: null,
      lastMessage: null
    }
  });
  let testCalled = false;

  const result = await recoverDueDisabledSites({
    configService: {
      getDueDisabledAutoRecoverySites() {
        return [structuredClone(site)];
      },
      getState() {
        return {
          proxy: { testModel: 'global-recovery-model' },
          sites: [{ ...site, failureDisabled: false, enabled: true }]
        };
      },
      runSiteAvailabilityCheck(_id, operation) {
        return operation();
      },
      async recordSiteAutoRecoverySuccess() {
        throw new Error('stale site should not be persisted');
      },
      async recordSiteAutoRecoveryFailure() {
        throw new Error('stale site should not be persisted');
      }
    },
    now: new Date('2026-06-03T08:00:01.000Z'),
    testSite: async () => {
      testCalled = true;
      return { ok: true };
    }
  });

  assert.equal(testCalled, false);
  assert.deepEqual(result.skippedSites.map((candidate) => candidate.id), [site.id]);
  assert.deepEqual(result.recoveredSites, []);
  assert.deepEqual(result.failedSites, []);
});
