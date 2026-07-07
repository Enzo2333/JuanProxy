import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GROUP_SYNC_SETTINGS,
  DEFAULT_AUTO_SWITCH_MULTIPLIER_LIMIT,
  DEFAULT_SITE_SYNC_SETTINGS,
  chooseBestSite,
  chooseFailoverSite,
  getGroupSyncSettingsIntervalMs,
  getSiteSyncSettingsIntervalMs,
  isUsableSite,
  normalizeSite,
  normalizeSiteCapabilities,
  normalizeGroupSyncSettings,
  normalizeAutoSwitchMultiplierLimit,
  normalizeSiteSyncSettings,
  recordFailure,
  recordRequestFailure,
  recordRequestStats,
  recordSuccess,
  shouldSwitchAfterFailure
} from '../src/proxy/switching-policy.js';

function site(overrides = {}) {
  return {
    id: overrides.id ?? 'site-1',
    name: overrides.name ?? 'Site',
    baseUrl: overrides.baseUrl ?? 'https://example.com/v1',
    apiKey: overrides.apiKey ?? 'sk-test',
    priority: overrides.priority ?? 100,
    multiplier: overrides.multiplier,
    enabled: overrides.enabled ?? true,
    manualEnabled: overrides.manualEnabled,
    failureDisabled: overrides.failureDisabled,
    status: overrides.status ?? 'idle',
    consecutiveErrors: overrides.consecutiveErrors ?? 0,
    requestCount: overrides.requestCount ?? 0,
    successCount: overrides.successCount ?? 0,
    errorCount: overrides.errorCount ?? 0,
    errorLog: overrides.errorLog ?? [],
    lastRequestAt: overrides.lastRequestAt ?? null,
    lastSuccessAt: overrides.lastSuccessAt ?? null,
    lastErrorAt: overrides.lastErrorAt ?? null,
    requestStats: overrides.requestStats,
    autoRecovery: overrides.autoRecovery,
    autoRecoveryState: overrides.autoRecoveryState,
    sync: overrides.sync
  };
}

test('records failure details and resets consecutive errors on success', () => {
  const failed = recordFailure(
    site(),
    { statusCode: 500, message: 'upstream failed' },
    new Date('2026-06-03T08:00:00.000Z')
  );

  assert.equal(failed.status, 'error');
  assert.equal(failed.consecutiveErrors, 1);
  assert.equal(failed.requestCount, 1);
  assert.equal(failed.errorCount, 1);
  assert.equal(failed.lastRequestAt, '2026-06-03T08:00:00.000Z');
  assert.equal(failed.lastError.message, 'upstream failed');
  assert.equal(failed.errorLog.length, 1);

  const recovered = recordSuccess(
    failed,
    { statusCode: 200 },
    new Date('2026-06-03T08:01:00.000Z')
  );

  assert.equal(recovered.status, 'success');
  assert.equal(recovered.consecutiveErrors, 0);
  assert.equal(recovered.requestCount, 2);
  assert.equal(recovered.successCount, 1);
  assert.equal(recovered.lastRequestAt, '2026-06-03T08:01:00.000Z');
  assert.equal(recovered.lastSuccess.statusCode, 200);
});

test('records non-upstream request failures without adding site health penalty', () => {
  const failed = recordRequestFailure(
    site({ id: 'a', name: 'a', priority: 1 }),
    { message: 'client request failed before upstream selection' },
    new Date('2026-06-03T08:00:00.000Z')
  );

  assert.equal(failed.status, 'error');
  assert.equal(failed.consecutiveErrors, 0);
  assert.equal(failed.requestCount, 1);
  assert.equal(failed.errorCount, 1);
  assert.equal(failed.lastError.affectsSiteHealth, false);

  const chosen = chooseBestSite([
    failed,
    site({ id: 'b', name: 'b', priority: 1 })
  ]);

  assert.equal(chosen.id, 'a');
});

test('records success and failure counts into hour day week and month buckets', () => {
  const first = recordSuccess(
    site(),
    { statusCode: 200 },
    new Date('2026-06-03T08:15:00')
  );
  const second = recordFailure(
    first,
    { statusCode: 500, message: 'upstream failed' },
    new Date('2026-06-03T08:45:00')
  );

  assert.deepEqual(second.requestStats.hour.map(pickBucketCounts), [
    {
      key: '2026-06-03T08',
      requestCount: 2,
      successCount: 1,
      errorCount: 1
    }
  ]);
  assert.deepEqual(second.requestStats.day.map(pickBucketCounts), [
    {
      key: '2026-06-03',
      requestCount: 2,
      successCount: 1,
      errorCount: 1
    }
  ]);
  assert.deepEqual(second.requestStats.week.map(pickBucketCounts), [
    {
      key: '2026-W23',
      requestCount: 2,
      successCount: 1,
      errorCount: 1
    }
  ]);
  assert.deepEqual(second.requestStats.month.map(pickBucketCounts), [
    {
      key: '2026-06',
      requestCount: 2,
      successCount: 1,
      errorCount: 1
    }
  ]);
});

test('normalizes persisted request stat buckets and derives request counts', () => {
  const normalized = normalizeSite(
    site({
      requestStats: {
        day: [
          {
            key: '2026-06-03',
            startedAt: '2026-06-03T00:00:00.000Z',
            successCount: 3,
            errorCount: 2,
            requestCount: 99
          }
        ]
      }
    })
  );

  assert.deepEqual(normalized.requestStats.day.map(pickBucketCounts), [
    {
      key: '2026-06-03',
      requestCount: 5,
      successCount: 3,
      errorCount: 2
    }
  ]);
  assert.deepEqual(normalized.requestStats.hour, []);
  assert.deepEqual(normalized.requestStats.week, []);
  assert.deepEqual(normalized.requestStats.month, []);
});

test('trims request stat buckets to the latest configured window', () => {
  let stats = undefined;
  for (let index = 0; index < 55; index += 1) {
    stats = recordRequestStats(
      stats,
      'success',
      new Date(2026, 5, 3, index, 0, 0)
    );
  }

  assert.equal(stats.hour.length, 48);
  assert.equal(stats.hour[0].key, '2026-06-03T07');
  assert.equal(stats.hour.at(-1).key, '2026-06-05T06');
});

test('normalizes legacy sites by deriving the last request time from success and error timestamps', () => {
  const normalized = normalizeSite(
    site({
      lastSuccessAt: '2026-06-03T08:00:00.000Z',
      lastErrorAt: '2026-06-03T08:02:00.000Z'
    })
  );

  assert.equal(normalized.lastRequestAt, '2026-06-03T08:02:00.000Z');
});

test('normalizes manual and failure disable state separately from effective enabled', () => {
  const automaticStop = normalizeSite(site({
    manualEnabled: true,
    failureDisabled: true
  }));
  const manualStop = normalizeSite(site({
    manualEnabled: false,
    failureDisabled: false
  }));
  const enabled = normalizeSite(site({
    manualEnabled: true,
    failureDisabled: false
  }));

  assert.equal(automaticStop.manualEnabled, true);
  assert.equal(automaticStop.failureDisabled, true);
  assert.equal(automaticStop.enabled, false);
  assert.equal(manualStop.manualEnabled, false);
  assert.equal(manualStop.failureDisabled, false);
  assert.equal(manualStop.enabled, false);
  assert.equal(enabled.enabled, true);
});

test('normalizes disabled-site auto recovery settings and state', () => {
  const defaults = normalizeSite(site());

  assert.deepEqual(defaults.autoRecovery, {
    enabled: false,
    intervalValue: 30,
    intervalUnit: 'minute'
  });
  assert.deepEqual(defaults.autoRecoveryState, {
    lastCheckedAt: null,
    nextCheckAt: null,
    lastResult: null,
    lastMessage: null
  });

  const normalized = normalizeSite(
    site({
      autoRecovery: {
        enabled: true,
        intervalValue: 2,
        intervalUnit: 'hour'
      },
      autoRecoveryState: {
        lastCheckedAt: '2026-06-03T08:00:00.000Z',
        nextCheckAt: '2026-06-03T10:00:00.000Z',
        lastResult: 'failure',
        lastMessage: 'bad key'
      }
    })
  );

  assert.deepEqual(normalized.autoRecovery, {
    enabled: true,
    intervalValue: 2,
    intervalUnit: 'hour'
  });
  assert.deepEqual(normalized.autoRecoveryState, {
    lastCheckedAt: '2026-06-03T08:00:00.000Z',
    nextCheckAt: '2026-06-03T10:00:00.000Z',
    lastResult: 'failure',
    lastMessage: 'bad key'
  });
});

test('normalizes remote site sync settings and collected metadata', () => {
  const defaults = normalizeSite(site());

  assert.deepEqual(defaults.sync, {
    enabled: false,
    dashboardUrl: '',
    username: '',
    password: '',
    providerType: 'auto',
    intervalValue: 30,
    intervalUnit: 'minute',
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    remote: {
      providerType: null,
      authType: null,
      accountName: '',
      balance: '',
      apiEndpoint: '',
      keyName: '',
      remoteKeyId: '',
      keyGroup: '',
      groupId: '',
      groupMultiplier: null,
      groups: []
    },
    intervalMode: 'global'
  });

  const normalized = normalizeSite(
    site({
      sync: {
        enabled: true,
        dashboardUrl: '  https://sync-one.example.com/profile  ',
        username: '  user@example.com  ',
        password: '  secret  ',
        providerType: 'modern-v1',
        intervalValue: 2,
        intervalUnit: 'hour',
        lastSyncAt: '2026-06-09T08:00:00.000Z',
        lastSyncStatus: 'success',
        lastSyncError: 'old error',
        remote: {
          providerType: 'modern-v1',
          authType: 'Bearer auth_token (/api/v1)',
          accountName: 'user@example.com',
          balance: '$1.47',
          apiEndpoint: 'https://api-us.example.com/',
          keyName: 'n',
          remoteKeyId: 18,
          keyGroup: 'Example Team',
          groupId: 18,
          groupMultiplier: '0.001x',
          groups: [
            { id: 18, name: 'Example Team', multiplier: '0.001x', selected: true },
            { id: 22, name: 'GPT Plus', multiplier: '0.045x' },
            { id: 23, name: '', multiplier: 'bad' }
          ]
        }
      }
    })
  );

  assert.equal(normalized.sync.enabled, true);
  assert.equal(normalized.sync.dashboardUrl, 'https://sync-one.example.com/profile');
  assert.equal(normalized.sync.username, 'user@example.com');
  assert.equal(normalized.sync.password, 'secret');
  assert.equal(normalized.sync.providerType, 'modern-v1');
  assert.equal(normalized.sync.intervalMode, 'custom');
  assert.equal(normalized.sync.intervalValue, 2);
  assert.equal(normalized.sync.intervalUnit, 'hour');
  assert.equal(normalized.sync.lastSyncAt, '2026-06-09T08:00:00.000Z');
  assert.equal(normalized.sync.lastSyncStatus, 'success');
  assert.equal(normalized.sync.lastSyncError, 'old error');
  assert.equal(normalized.sync.remote.remoteKeyId, '18');
  assert.equal(normalized.sync.remote.keyGroup, 'Example Team');
  assert.equal(normalized.sync.remote.groupId, '18');
  assert.equal(normalized.sync.remote.groupMultiplier, 0.001);
  assert.deepEqual(normalized.sync.remote.groups, [
    { id: '18', name: 'Example Team', multiplier: 0.001, selected: true },
    { id: '22', name: 'GPT Plus', multiplier: 0.045, selected: false }
  ]);

  const invalidInterval = normalizeSite(
    site({
      sync: {
        intervalValue: 0,
        intervalUnit: 'week'
      }
    })
  );

  assert.equal(invalidInterval.sync.intervalValue, 30);
  assert.equal(invalidInterval.sync.intervalUnit, 'minute');
});

test('normalizes site capability snapshots', () => {
  const normalized = normalizeSite({
    ...site(),
    capabilities: {
      models: [' gpt-5-mini ', 'dall-e-3', 'gpt-5-mini', ''],
      features: {
        textGeneration: true,
        imageGeneration: true,
        embeddings: 1
      },
      featureModels: {
        textGeneration: ['gpt-5-mini', ' gpt-5-mini '],
        imageGeneration: ['dall-e-3']
      },
      checkedAt: '2026-06-10T09:00:00+08:00',
      lastStatus: 'success',
      lastError: '',
      source: '/v1/models'
    }
  });

  assert.deepEqual(normalized.capabilities, normalizeSiteCapabilities({
    models: ['dall-e-3', 'gpt-5-mini'],
    features: {
      textGeneration: true,
      imageGeneration: true,
      embeddings: true
    },
    featureModels: {
      textGeneration: ['gpt-5-mini'],
      imageGeneration: ['dall-e-3']
    },
    checkedAt: '2026-06-10T01:00:00.000Z',
    lastStatus: 'success',
    source: '/v1/models'
  }));
});

test('normalizes global site sync settings and interval inheritance mode', () => {
  assert.deepEqual(DEFAULT_SITE_SYNC_SETTINGS, {
    intervalValue: 30,
    intervalUnit: 'minute',
    intelligentScheduling: true
  });

  assert.deepEqual(normalizeSiteSyncSettings({
    intervalValue: 2,
    intervalUnit: 'hour',
    intelligentScheduling: false
  }), {
    intervalValue: 2,
    intervalUnit: 'hour',
    intelligentScheduling: false
  });
  assert.equal(getSiteSyncSettingsIntervalMs({ intervalValue: 2, intervalUnit: 'hour' }), 7_200_000);

  assert.equal(normalizeSite(site()).sync.intervalMode, 'global');
  assert.equal(normalizeSite(site({ sync: { intervalMode: 'custom' } })).sync.intervalMode, 'custom');
  assert.equal(normalizeSite(site({ sync: { intervalValue: 15, intervalUnit: 'minute' } })).sync.intervalMode, 'custom');
  assert.equal(normalizeSite(site({ sync: { intervalMode: 'global', intervalValue: 15 } })).sync.intervalMode, 'global');
});

test('normalizes group sync settings and website refresh interval', () => {
  assert.deepEqual(DEFAULT_GROUP_SYNC_SETTINGS, {
    intervalValue: 30,
    intervalUnit: 'minute',
    websites: []
  });

  assert.deepEqual(normalizeGroupSyncSettings({
    intervalValue: 2,
    intervalUnit: 'hour',
    websites: [
      {
        key: 'HTTPS://Relay.Example.COM',
        dashboardUrl: ' https://relay.example.com/console/token ',
        providerType: 'new-api',
        username: 'sync-user',
        lastRefreshAt: '2026-06-09T08:00:00+08:00',
        lastRefreshStatus: 'success',
        groups: [
          { id: 'default', name: ' default ', multiplier: '0.003x', selected: true },
          { id: 'duplicate', name: 'default', multiplier: 0.003 }
        ]
      },
      {
        key: 'https://relay.example.com',
        dashboardUrl: 'https://relay.example.com/profile'
      }
    ]
  }), {
    intervalValue: 2,
    intervalUnit: 'hour',
    websites: [
      {
        key: 'https://relay.example.com',
        dashboardUrl: 'https://relay.example.com/console/token',
        providerType: 'new-api',
        username: 'sync-user',
        lastRefreshAt: '2026-06-09T00:00:00.000Z',
        lastRefreshStatus: 'success',
        lastRefreshError: null,
        groups: [
          {
            id: 'default',
            name: 'default',
            multiplier: 0.003,
            selected: true
          }
        ]
      }
    ]
  });
  assert.equal(getGroupSyncSettingsIntervalMs({ intervalValue: 2, intervalUnit: 'hour' }), 7_200_000);
});

test('switch threshold triggers when consecutive errors reach the configured limit', () => {
  assert.equal(shouldSwitchAfterFailure(site({ consecutiveErrors: 2 }), 3), false);
  assert.equal(shouldSwitchAfterFailure(site({ consecutiveErrors: 3 }), 3), true);
  assert.equal(shouldSwitchAfterFailure(site({ consecutiveErrors: 1 }), 0), true);
});

test('chooseBestSite prefers enabled healthy configs and ignores disabled configs', () => {
  const chosen = chooseBestSite([
    site({ id: 'bad', status: 'error', consecutiveErrors: 5, errorCount: 5 }),
    site({ id: 'disabled', enabled: false, status: 'success', consecutiveErrors: 0 }),
    site({ id: 'good', status: 'success', consecutiveErrors: 0, successCount: 2 })
  ]);

  assert.equal(chosen.id, 'good');
});

test('usable site requires manual enable and no failure disable', () => {
  assert.equal(isUsableSite(site({ manualEnabled: true, failureDisabled: false })), true);
  assert.equal(isUsableSite(site({ manualEnabled: false, failureDisabled: false })), false);
  assert.equal(isUsableSite(site({ manualEnabled: true, failureDisabled: true })), false);
});

test('chooseBestSite prefers lower numeric priority before health score', () => {
  const chosen = chooseBestSite([
    site({ id: 'high-score', status: 'success', successCount: 100, requestCount: 100, priority: 20 }),
    site({ id: 'high-priority', status: 'idle', priority: 1 })
  ]);

  assert.equal(chosen.id, 'high-priority');
});

test('chooseBestSite uses lower multiplier as the priority-mode tie breaker', () => {
  const chosen = chooseBestSite([
    site({ id: 'lower-priority-number', priority: 2, multiplier: 0.1 }),
    site({ id: 'priority-tie-high-multiplier', priority: 1, multiplier: 2 }),
    site({ id: 'priority-tie-low-multiplier', priority: 1, multiplier: 0.5 })
  ], { priorityMode: 'priority' });

  assert.equal(chosen.id, 'priority-tie-low-multiplier');
});

test('chooseBestSite uses lower priority as the multiplier-mode tie breaker', () => {
  const chosen = chooseBestSite([
    site({ id: 'lower-priority-number', priority: 0, multiplier: 0.9 }),
    site({ id: 'multiplier-tie-high-priority', priority: 5, multiplier: 0.5 }),
    site({ id: 'multiplier-tie-low-priority', priority: 1, multiplier: 0.5 })
  ], { priorityMode: 'multiplier' });

  assert.equal(chosen.id, 'multiplier-tie-low-priority');
});

test('chooseBestSite can skip sites above the automatic switch multiplier limit', () => {
  assert.deepEqual(DEFAULT_AUTO_SWITCH_MULTIPLIER_LIMIT, {
    enabled: false,
    maxMultiplier: 1
  });
  assert.deepEqual(normalizeAutoSwitchMultiplierLimit({
    enabled: true,
    maxMultiplier: '0.5'
  }), {
    enabled: true,
    maxMultiplier: 0.5
  });

  const chosen = chooseBestSite([
    site({ id: 'too-expensive', priority: 1, multiplier: 2 }),
    site({ id: 'allowed', priority: 2, multiplier: 0.5 })
  ], {
    autoSwitchMultiplierLimit: {
      enabled: true,
      maxMultiplier: 1
    }
  });

  assert.equal(chosen.id, 'allowed');
  assert.equal(
    chooseBestSite([site({ id: 'blocked', multiplier: 2 })], {
      autoSwitchMultiplierLimit: {
        enabled: true,
        maxMultiplier: 1
      }
    }),
    null
  );
});

test('chooseBestSite round-robins sites with the same priority', () => {
  const sites = [
    site({ id: 'a', name: 'a', priority: 1 }),
    site({ id: 'b', name: 'b', priority: 1 }),
    site({ id: 'c', name: 'c', priority: 2 })
  ];

  assert.equal(
    chooseBestSite(sites, { samePriorityStrategy: 'round-robin', lastSelectedSiteId: 'a' }).id,
    'b'
  );
  assert.equal(
    chooseBestSite(sites, { samePriorityStrategy: 'round-robin', lastSelectedSiteId: 'b' }).id,
    'a'
  );
});

test('chooseBestSite can randomly select among sites with the same priority', () => {
  const chosen = chooseBestSite(
    [site({ id: 'a', priority: 1 }), site({ id: 'b', priority: 1 })],
    { samePriorityStrategy: 'random', random: () => 0.75 }
  );

  assert.equal(chosen.id, 'b');
});

test('chooseFailoverSite does not return the failed active site', () => {
  const chosen = chooseFailoverSite([
    site({ id: 'active', status: 'error', consecutiveErrors: 4 }),
    site({ id: 'next', status: 'idle', consecutiveErrors: 0 })
  ], 'active');

  assert.equal(chosen.id, 'next');
});

function pickBucketCounts(bucket) {
  return {
    key: bucket.key,
    requestCount: bucket.requestCount,
    successCount: bucket.successCount,
    errorCount: bucket.errorCount
  };
}
