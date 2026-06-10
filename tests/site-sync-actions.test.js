import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import {
  switchConfiguredSiteGroup,
  syncAllConfiguredSites,
  syncConfiguredSite
} from '../src/proxy/site-sync-actions.js';

test('syncConfiguredSite writes remote metadata and fills site multiplier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-sync',
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api'
      }
    });

    const result = await syncConfiguredSite({
      configService: service,
      siteId: site.id,
      fetchRemoteSync: async ({ sync }) => ({
        ok: true,
        multiplier: 0.003,
        syncPatch: {
          lastSyncAt: '2026-06-09T08:00:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null,
          remote: {
            providerType: 'new-api',
            authType: 'Bearer token (/api)',
            accountName: sync.username,
            balance: '$0.00',
            apiEndpoint: '',
            keyName: 'qa',
            keyGroup: 'AAA.限时白嫖GPT 0.003x',
            groupMultiplier: 0.003
          }
        }
      })
    });

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(result.ok, true);
    assert.equal(updated.multiplier, 0.003);
    assert.equal(updated.sync.username, 'sync-user');
    assert.equal(updated.sync.lastSyncStatus, 'success');
    assert.equal(updated.sync.remote.keyName, 'qa');
    assert.equal(updated.sync.remote.groupMultiplier, 0.003);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncConfiguredSite passes the current configured api key to the remote sync service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-api-key-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  const syncCalls = [];

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-current',
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api'
      }
    });

    await syncConfiguredSite({
      configService: service,
      siteId: site.id,
      fetchRemoteSync: async (input) => {
        syncCalls.push(input);
        return {
          ok: true,
          multiplier: 0.003,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            remote: {
              keyName: 'current',
              keyGroup: 'default',
              groupMultiplier: 0.003
            }
          }
        };
      }
    });

    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].apiKey, 'sk-current');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncAllConfiguredSites refreshes each website once and applies groups to related sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-website-groups-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  const syncCalls = [];

  try {
    await service.load();
    const primary = await service.addSite({
      name: 'primary',
      baseUrl: 'https://primary.example/v1',
      apiKey: 'sk-primary',
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          keyGroup: 'default',
          groupId: 'default',
          groupMultiplier: 1,
          groups: []
        }
      }
    });
    const backup = await service.addSite({
      name: 'backup',
      baseUrl: 'https://backup.example/v1',
      apiKey: 'sk-backup',
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/profile',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          keyGroup: 'GPT Plus',
          groupId: 'plus',
          groupMultiplier: 1,
          groups: []
        }
      }
    });

    const result = await syncAllConfiguredSites({
      configService: service,
      fetchRemoteSync: async ({ sync, apiKey }) => {
        syncCalls.push({ username: sync.username, apiKey });
        return {
          ok: true,
          multiplier: 0.003,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            remote: {
              keyGroup: 'default',
              groupId: 'default',
              groupMultiplier: 0.003,
              groups: [
                {
                  id: 'default',
                  name: 'default',
                  multiplier: 0.003,
                  selected: true
                },
                {
                  id: 'plus',
                  name: 'GPT Plus',
                  multiplier: 0.045,
                  selected: false
                }
              ]
            }
          }
        };
      }
    });

    const state = service.getState();
    const updatedPrimary = state.sites.find((site) => site.id === primary.id);
    const updatedBackup = state.sites.find((site) => site.id === backup.id);

    assert.deepEqual(syncCalls, [{ username: 'sync-user', apiKey: 'sk-primary' }]);
    assert.deepEqual(result.checkedWebsites.map((website) => website.key), ['https://relay.example.com']);
    assert.deepEqual(result.syncedSites.map((site) => site.id).sort(), [backup.id, primary.id].sort());
    assert.equal(updatedPrimary.multiplier, 0.003);
    assert.equal(updatedBackup.multiplier, 0.045);
    assert.equal(updatedBackup.sync.remote.groupMultiplier, 0.045);
    assert.deepEqual(
      updatedBackup.sync.remote.groups.map((group) => [group.name, group.selected]),
      [
        ['default', false],
        ['GPT Plus', true]
      ]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('switchConfiguredSiteGroup selects a synced group and updates multiplier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-group-switch-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  const remoteSwitches = [];

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-sync',
      multiplier: 0.003,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          remoteKeyId: '101',
          keyGroup: 'AAA.限时白嫖GPT 0.003x',
          groupMultiplier: 0.003,
          groups: [
            {
              id: 'default',
              name: 'AAA.限时白嫖GPT 0.003x',
              multiplier: 0.003,
              selected: true
            },
            {
              id: 'plus',
              name: 'GPT Plus 0.045x',
              multiplier: 0.045,
              selected: false
            }
          ]
        }
      }
    });

    const switched = await switchConfiguredSiteGroup({
      configService: service,
      siteId: site.id,
      groupName: 'GPT Plus 0.045x',
      switchRemoteGroup: async ({ sync, apiKey, group }) => {
        remoteSwitches.push({ sync, apiKey, group });
        return {
          ok: true,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:10:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            remote: {
              keyGroup: group.name,
              groupMultiplier: group.multiplier,
              groups: [
                {
                  id: 'default',
                  name: 'AAA.限时白嫖GPT 0.003x',
                  multiplier: 0.003,
                  selected: false
                },
                {
                  id: 'plus',
                  name: 'GPT Plus 0.045x',
                  multiplier: 0.045,
                  selected: true
                }
              ]
            }
          }
        };
      }
    });

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(remoteSwitches.length, 1);
    assert.equal(remoteSwitches[0].sync.dashboardUrl, 'https://relay.example.com/console/token');
    assert.equal(remoteSwitches[0].apiKey, 'sk-sync');
    assert.equal(remoteSwitches[0].group.id, 'plus');
    assert.equal(switched.sync.remote.keyGroup, 'GPT Plus 0.045x');
    assert.equal(updated.multiplier, 0.045);
    assert.equal(updated.sync.lastSyncStatus, 'success');
    assert.equal(updated.sync.lastSyncAt, '2026-06-09T08:10:00.000Z');
    assert.equal(updated.sync.remote.groupMultiplier, 0.045);
    assert.deepEqual(
      updated.sync.remote.groups.map((group) => [group.name, group.selected]),
      [
        ['AAA.限时白嫖GPT 0.003x', false],
        ['GPT Plus 0.045x', true]
      ]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('switchConfiguredSiteGroup does not add selected local-only groups to remote group list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-group-switch-local-only-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-sync',
      multiplier: 0.003,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          remoteKeyId: '101',
          keyGroup: 'AAA.限时白嫖GPT 0.003x',
          groupMultiplier: 0.003,
          groups: [
            {
              id: 'default',
              name: 'AAA.限时白嫖GPT 0.003x',
              multiplier: 0.003,
              selected: true
            },
            {
              id: 'plus',
              name: 'GPT Plus 0.045x',
              multiplier: 0.045,
              selected: false
            }
          ]
        }
      }
    });

    await switchConfiguredSiteGroup({
      configService: service,
      siteId: site.id,
      groupName: 'GPT Plus 0.045x',
      switchRemoteGroup: async ({ group }) => ({
        ok: true,
        multiplier: group.multiplier,
        syncPatch: {
          lastSyncAt: '2026-06-09T08:10:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null,
          remote: {
            keyGroup: group.name,
            groupMultiplier: group.multiplier,
            groups: [
              {
                id: 'default',
                name: 'AAA.限时白嫖GPT 0.003x',
                multiplier: 0.003,
                selected: false
              }
            ]
          }
        }
      })
    });

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(updated.sync.remote.keyGroup, 'GPT Plus 0.045x');
    assert.equal(updated.sync.remote.groupMultiplier, 0.045);
    assert.deepEqual(updated.sync.remote.groups.map((group) => group.name), [
      'AAA.限时白嫖GPT 0.003x'
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('switchConfiguredSiteGroup records remote switch failure without changing selected group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-group-switch-failure-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-sync',
      multiplier: 0.003,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          remoteKeyId: '101',
          keyGroup: 'AAA.限时白嫖GPT 0.003x',
          groupMultiplier: 0.003,
          groups: [
            {
              id: 'default',
              name: 'AAA.限时白嫖GPT 0.003x',
              multiplier: 0.003,
              selected: true
            },
            {
              id: 'plus',
              name: 'GPT Plus 0.045x',
              multiplier: 0.045,
              selected: false
            }
          ]
        }
      }
    });

    await assert.rejects(
      switchConfiguredSiteGroup({
        configService: service,
        siteId: site.id,
        groupName: 'GPT Plus 0.045x',
        switchRemoteGroup: async () => ({
          ok: false,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:10:00.000Z',
            lastSyncStatus: 'failure',
            lastSyncError: 'Remote key id is missing'
          },
          error: new Error('Remote key id is missing')
        })
      }),
      /Remote key id is missing/
    );

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(updated.multiplier, 0.003);
    assert.equal(updated.sync.lastSyncStatus, 'failure');
    assert.equal(updated.sync.lastSyncError, 'Remote key id is missing');
    assert.equal(updated.sync.remote.keyGroup, 'AAA.限时白嫖GPT 0.003x');
    assert.deepEqual(
      updated.sync.remote.groups.map((group) => [group.name, group.selected]),
      [
        ['AAA.限时白嫖GPT 0.003x', true],
        ['GPT Plus 0.045x', false]
      ]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncAllConfiguredSites refreshes configured sync websites and records failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-refresh-all-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const okSite = await service.addSite({
      name: 'ok-sync',
      baseUrl: 'https://ok.example/v1',
      apiKey: 'sk-ok',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync.example.com/keys',
        username: 'ok@example.com',
        password: 'secret'
      }
    });
    const failedSite = await service.addSite({
      name: 'failed-sync',
      baseUrl: 'https://failed.example/v1',
      apiKey: 'sk-failed',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'failed@example.com',
        password: 'secret'
      }
    });
    await service.addSite({
      name: 'missing-password',
      baseUrl: 'https://missing.example/v1',
      apiKey: 'sk-missing',
      sync: {
        enabled: true,
        dashboardUrl: 'https://missing.example/keys',
        username: 'missing@example.com',
        password: ''
      }
    });

    const result = await syncAllConfiguredSites({
      configService: service,
      fetchRemoteSync: async ({ sync }) => {
        if (sync.username.startsWith('failed')) {
          return {
            ok: false,
            multiplier: null,
            syncPatch: {
              lastSyncAt: '2026-06-09T08:00:00.000Z',
              lastSyncStatus: 'failure',
              lastSyncError: 'login failed'
            }
          };
        }
        return {
          ok: true,
          multiplier: 0.001,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            remote: {
              keyGroup: 'Example Team',
              groupMultiplier: 0.001,
              groups: [
                {
                  id: 'example-team',
                  name: 'Example Team',
                  multiplier: 0.001,
                  selected: true
                }
              ]
            }
          }
        };
      }
    });

    const state = service.getState();
    assert.deepEqual(result.checkedSites.map((site) => site.id), [okSite.id, failedSite.id]);
    assert.deepEqual(result.syncedSites.map((site) => site.id), [okSite.id]);
    assert.deepEqual(result.failedSites.map((site) => site.id), [failedSite.id]);
    assert.equal(state.sites.find((site) => site.id === okSite.id).multiplier, 0.001);
    assert.equal(state.sites.find((site) => site.id === failedSite.id).sync.lastSyncStatus, 'failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncAllConfiguredSites continues when one configured sync account throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-refresh-throws-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const failedSite = await service.addSite({
      name: 'failed-sync',
      baseUrl: 'https://failed.example/v1',
      apiKey: 'sk-failed',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'failed@example.com',
        password: 'secret'
      }
    });
    const okSite = await service.addSite({
      name: 'ok-sync',
      baseUrl: 'https://ok.example/v1',
      apiKey: 'sk-ok',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync.example.com/keys',
        username: 'ok@example.com',
        password: 'secret'
      }
    });

    const result = await syncAllConfiguredSites({
      configService: service,
      fetchRemoteSync: async ({ sync }) => {
        if (sync.username.startsWith('failed')) {
          throw new Error('network timeout');
        }
        return {
          ok: true,
          multiplier: 0.001,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:00:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            remote: {
              keyGroup: 'Example Team',
              groupMultiplier: 0.001,
              groups: [
                {
                  id: 'example-team',
                  name: 'Example Team',
                  multiplier: 0.001,
                  selected: true
                }
              ]
            }
          }
        };
      }
    });

    const state = service.getState();
    assert.deepEqual(result.checkedSites.map((site) => site.id), [failedSite.id, okSite.id]);
    assert.deepEqual(result.failedSites.map((site) => site.id), [failedSite.id]);
    assert.deepEqual(result.syncedSites.map((site) => site.id), [okSite.id]);
    assert.equal(state.sites.find((site) => site.id === failedSite.id).sync.lastSyncStatus, 'failure');
    assert.equal(state.sites.find((site) => site.id === failedSite.id).sync.lastSyncError, 'network timeout');
    assert.equal(state.sites.find((site) => site.id === okSite.id).multiplier, 0.001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncConfiguredSite persists failure status without changing multiplier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-failure-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-sync',
      multiplier: 0.5,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api'
      }
    });

    const result = await syncConfiguredSite({
      configService: service,
      siteId: site.id,
      fetchRemoteSync: async () => ({
        ok: false,
        multiplier: null,
        syncPatch: {
          lastSyncAt: '2026-06-09T08:00:00.000Z',
          lastSyncStatus: 'failure',
          lastSyncError: 'login failed'
        }
      })
    });

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(result.ok, false);
    assert.equal(updated.multiplier, 0.5);
    assert.equal(updated.sync.lastSyncStatus, 'failure');
    assert.equal(updated.sync.lastSyncError, 'login failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
