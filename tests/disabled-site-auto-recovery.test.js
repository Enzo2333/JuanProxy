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
    testModel: 'gpt-5-mini',
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
      testSite: async (site) => {
        checked.push(site.id);
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
