import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import {
  createConfiguredSiteKey,
  logoutConfiguredSiteAccount,
  provisionMissingLowMultiplierGroup,
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

test('syncConfiguredSite keeps locked site multiplier while updating remote metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-locked-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'locked-sync',
      baseUrl: 'https://locked.example/v1',
      apiKey: 'sk-locked',
      multiplier: 0,
      multiplierLocked: true,
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
      fetchRemoteSync: async () => ({
        ok: true,
        multiplier: 0.003,
        syncPatch: {
          lastSyncAt: '2026-06-09T08:00:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null,
          remote: {
            keyName: 'qa',
            keyGroup: 'default',
            groupMultiplier: 0.003
          }
        }
      })
    });

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(updated.multiplier, 0);
    assert.equal(updated.multiplierLocked, true);
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

test('syncAllConfiguredSites tries another site from the same website when the representative fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-website-fallback-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  const syncCalls = [];

  try {
    await service.load();
    const failing = await service.addSite({
      name: 'failing-representative',
      baseUrl: 'https://failing.example/v1',
      apiKey: 'sk-failing',
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'failing-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          keyGroup: 'default',
          groupId: 'default',
          groupMultiplier: 1
        }
      }
    });
    const fallback = await service.addSite({
      name: 'fallback-representative',
      baseUrl: 'https://fallback.example/v1',
      apiKey: 'sk-fallback',
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/profile',
        username: 'fallback-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          keyGroup: 'plus',
          groupId: 'plus',
          groupMultiplier: 1
        }
      }
    });

    const result = await syncAllConfiguredSites({
      configService: service,
      fetchRemoteSync: async ({ sync }) => {
        syncCalls.push(sync.username);
        if (sync.username === 'failing-user') {
          return {
            ok: false,
            syncPatch: {
              lastSyncAt: '2026-06-09T08:00:00.000Z',
              lastSyncStatus: 'failure',
              lastSyncError: 'login failed'
            },
            error: new Error('login failed')
          };
        }
        return {
          ok: true,
          multiplier: 0.045,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:01:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            remote: {
              keyGroup: 'plus',
              groupId: 'plus',
              groupMultiplier: 0.045,
              groups: [
                {
                  id: 'default',
                  name: 'default',
                  multiplier: 0.003,
                  selected: false
                },
                {
                  id: 'plus',
                  name: 'plus',
                  multiplier: 0.045,
                  selected: true
                }
              ]
            }
          }
        };
      }
    });

    const state = service.getState();
    const updatedFailing = state.sites.find((site) => site.id === failing.id);
    const updatedFallback = state.sites.find((site) => site.id === fallback.id);

    assert.deepEqual(syncCalls, ['failing-user', 'fallback-user']);
    assert.deepEqual(result.failedSites, []);
    assert.deepEqual(result.syncedSites.map((site) => site.id).sort(), [failing.id, fallback.id].sort());
    assert.equal(updatedFailing.multiplier, 0.003);
    assert.equal(updatedFallback.multiplier, 0.045);
    assert.equal(updatedFallback.sync.lastSyncStatus, 'success');
    assert.equal(updatedFallback.sync.lastSyncAt, '2026-06-09T08:01:00.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncAllConfiguredSites does not apply groups to sites with account sync disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-disabled-account-sync-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const enabled = await service.addSite({
      name: 'enabled-sync',
      baseUrl: 'https://enabled.example/v1',
      apiKey: 'sk-enabled',
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
    const disabled = await service.addSite({
      name: 'disabled-sync',
      baseUrl: 'https://disabled.example/v1',
      apiKey: 'sk-disabled',
      multiplier: 0.5,
      sync: {
        enabled: false,
        dashboardUrl: 'https://relay.example.com/console/profile',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          keyGroup: 'local-only',
          groupId: 'local-only',
          groupMultiplier: 0.5,
          groups: [
            {
              id: 'local-only',
              name: 'local-only',
              multiplier: 0.5,
              selected: true
            }
          ]
        }
      }
    });

    const result = await syncAllConfiguredSites({
      configService: service,
      fetchRemoteSync: async () => ({
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
      })
    });

    const state = service.getState();
    const updatedEnabled = state.sites.find((site) => site.id === enabled.id);
    const updatedDisabled = state.sites.find((site) => site.id === disabled.id);

    assert.deepEqual(result.syncedSites.map((site) => site.id), [enabled.id]);
    assert.equal(updatedEnabled.multiplier, 0.003);
    assert.equal(updatedDisabled.multiplier, 0.5);
    assert.equal(updatedDisabled.sync.lastSyncAt, null);
    assert.equal(updatedDisabled.sync.lastSyncStatus, null);
    assert.equal(updatedDisabled.sync.remote.groupMultiplier, 0.5);
    assert.deepEqual(updatedDisabled.sync.remote.groups.map((group) => group.name), ['local-only']);
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

test('switchConfiguredSiteGroup can select a synced group by id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-group-switch-id-'));
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
          keyGroup: 'Default Group',
          groupId: 'default',
          groupMultiplier: 0.003,
          groups: [
            {
              id: 'default',
              name: 'Default Group',
              multiplier: 0.003,
              selected: true
            },
            {
              id: '18',
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
      groupId: '18',
      switchRemoteGroup: async ({ group }) => {
        remoteSwitches.push(group);
        return {
          ok: true,
          multiplier: group.multiplier,
          syncPatch: {
            lastSyncAt: '2026-06-09T08:10:00.000Z',
            lastSyncStatus: 'success',
            lastSyncError: null,
            remote: {
              keyGroup: group.name,
              groupId: group.id,
              groupMultiplier: group.multiplier,
              groups: [
                {
                  id: 'default',
                  name: 'Default Group',
                  multiplier: 0.003,
                  selected: false
                },
                {
                  id: '18',
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
    assert.equal(remoteSwitches[0].id, '18');
    assert.equal(remoteSwitches[0].name, 'GPT Plus 0.045x');
    assert.equal(updated.sync.remote.groupId, '18');
    assert.equal(updated.sync.remote.keyGroup, 'GPT Plus 0.045x');
    assert.equal(updated.multiplier, 0.045);
    assert.deepEqual(
      updated.sync.remote.groups.map((group) => [group.id, group.selected]),
      [
        ['default', false],
        ['18', true]
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

test('syncConfiguredSite serializes shared-account operations and persists the reusable session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-shared-session-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const receivedSessions = [];

  try {
    await service.load();
    const first = await service.addSite({
      name: 'first',
      baseUrl: 'https://first.example/v1',
      apiKey: 'sk-first',
      sync: {
        enabled: true,
        dashboardUrl: 'https://panel.example.com/keys',
        username: 'shared@example.com',
        password: 'secret',
        providerType: 'modern-v1'
      }
    });
    const second = await service.addSite({
      name: 'second',
      baseUrl: 'https://second.example/v1',
      apiKey: 'sk-second',
      sync: {
        enabled: true,
        dashboardUrl: 'https://panel.example.com/profile',
        username: 'shared@example.com',
        password: 'secret',
        providerType: 'modern-v1'
      }
    });
    const fetchRemoteSync = async ({ authSession }) => {
      receivedSessions.push(authSession);
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls -= 1;
      return {
        ok: true,
        multiplier: null,
        authSession: authSession ?? {
          providerType: 'modern-v1',
          origin: 'https://panel.example.com',
          apiBaseUrl: 'https://panel.example.com/api/v1',
          token: 'shared-session-token',
          createdAt: '2026-07-29T08:00:00.000Z'
        },
        syncPatch: {
          lastSyncAt: '2026-07-29T08:00:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null,
          remote: {}
        }
      };
    };

    await Promise.all([
      syncConfiguredSite({ configService: service, siteId: first.id, fetchRemoteSync }),
      syncConfiguredSite({ configService: service, siteId: second.id, fetchRemoteSync })
    ]);

    assert.equal(maximumActiveCalls, 1);
    assert.equal(receivedSessions[0], null);
    assert.equal(receivedSessions[1].token, 'shared-session-token');
    assert.equal(service.getRemoteAccountSession(first.id).token, 'shared-session-token');
    assert.equal(service.getRemoteAccountSession(second.id).token, 'shared-session-token');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncConfiguredSite clears a failed shared-session refresh before the next site reacquires it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-refresh-session-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  const receivedTokens = [];

  try {
    await service.load();
    const first = await service.addSite({
      name: 'first',
      baseUrl: 'https://first.example/v1',
      apiKey: 'sk-first',
      sync: {
        enabled: true,
        dashboardUrl: 'https://panel.example.com/keys',
        username: 'shared@example.com',
        password: 'secret',
        providerType: 'modern-v1'
      }
    });
    const second = await service.addSite({
      name: 'second',
      baseUrl: 'https://second.example/v1',
      apiKey: 'sk-second',
      sync: {
        enabled: true,
        dashboardUrl: 'https://panel.example.com/profile',
        username: 'shared@example.com',
        password: 'secret',
        providerType: 'modern-v1'
      }
    });
    const expiredSession = {
      providerType: 'modern-v1',
      origin: 'https://panel.example.com',
      apiBaseUrl: 'https://panel.example.com/api/v1',
      token: 'expired-token',
      createdAt: '2026-07-29T07:00:00.000Z'
    };
    await service.updateRemoteAccountSession(first.id, expiredSession);

    const fetchRemoteSync = async ({ authSession }) => {
      receivedTokens.push(authSession?.token ?? null);
      if (authSession) {
        return {
          ok: false,
          multiplier: null,
          authSession,
          authSessionInvalidated: true,
          syncPatch: {
            lastSyncAt: '2026-07-29T08:00:00.000Z',
            lastSyncStatus: 'failure',
            lastSyncError: 'session expired'
          }
        };
      }
      return {
        ok: true,
        multiplier: null,
        authSession: {
          ...expiredSession,
          token: 'fresh-token',
          createdAt: '2026-07-29T08:01:00.000Z'
        },
        syncPatch: {
          lastSyncAt: '2026-07-29T08:01:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null
        }
      };
    };

    const firstResult = await syncConfiguredSite({
      configService: service,
      siteId: first.id,
      fetchRemoteSync
    });
    assert.equal(firstResult.ok, false);
    assert.equal(service.getRemoteAccountSession(first.id), null);

    const secondResult = await syncConfiguredSite({
      configService: service,
      siteId: second.id,
      fetchRemoteSync
    });
    assert.equal(secondResult.ok, true);
    assert.deepEqual(receivedTokens, ['expired-token', null]);
    assert.equal(service.getRemoteAccountSession(first.id).token, 'fresh-token');
    assert.equal(service.getRemoteAccountSession(second.id).token, 'fresh-token');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('logoutConfiguredSiteAccount clears a successful shared session and keeps it on network failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-logout-account-action-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'site',
      baseUrl: 'https://api.example/v1',
      apiKey: 'sk-site',
      sync: {
        enabled: true,
        dashboardUrl: 'https://panel.example.com/keys',
        username: 'user@example.com',
        password: 'secret',
        providerType: 'modern-v1'
      }
    });
    const session = {
      providerType: 'modern-v1',
      origin: 'https://panel.example.com',
      apiBaseUrl: 'https://panel.example.com/api/v1',
      token: 'saved-token',
      createdAt: '2026-07-29T08:00:00.000Z'
    };
    await service.updateRemoteAccountSession(site.id, session);

    const failed = await logoutConfiguredSiteAccount({
      configService: service,
      siteId: site.id,
      logoutRemoteAccount: async ({ authSession }) => {
        assert.equal(authSession.token, 'saved-token');
        return { ok: false, remoteAttempted: true, remoteSucceeded: false };
      }
    });
    assert.equal(failed.ok, false);
    assert.equal(service.getRemoteAccountSession(site.id).token, 'saved-token');

    const succeeded = await logoutConfiguredSiteAccount({
      configService: service,
      siteId: site.id,
      logoutRemoteAccount: async ({ authSession }) => {
        assert.equal(authSession.token, 'saved-token');
        return { ok: true, remoteAttempted: true, remoteSucceeded: true };
      }
    });
    assert.equal(succeeded.ok, true);
    assert.equal(service.getRemoteAccountSession(site.id), null);
    assert.ok(service.getRemoteAccountForSite(site.id).lastLogoutAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createConfiguredSiteKey imports the generated key as a new site and copies site characteristics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-create-key-action-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-old',
      priority: 7,
      multiplier: 2,
      customMultiplier: 0.5,
      multiplierLocked: false,
      modelMapping: {
        enabled: true,
        mappings: [{ from: 'client-model', to: 'remote-model' }]
      },
      rateLimit: {
        enabled: true,
        limit: 20,
        windowValue: 1,
        windowUnit: 'hour'
      },
      autoRecovery: {
        enabled: true,
        intervalValue: 10,
        intervalUnit: 'minute'
      },
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/keys',
        username: 'sync-user',
        password: 'secret',
        providerType: 'modern-v1',
        remote: {
          keyGroup: 'Example Team',
          groupId: '18'
        }
      }
    });

    const result = await createConfiguredSiteKey({
      configService: service,
      siteId: site.id,
      createRemoteKey: async ({ sync, name }) => ({
        ok: true,
        apiKey: 'sk-created',
        multiplier: 0.001,
        keyName: name,
        syncPatch: {
          lastSyncAt: '2026-06-09T08:00:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null,
          remote: {
            providerType: sync.providerType,
            keyName: name,
            remoteKeyId: '37',
            keyGroup: 'Example Team',
            groupId: '18',
            groupMultiplier: 0.001
          }
        }
      })
    });

    const state = service.getState();
    const source = state.sites.find((candidate) => candidate.id === site.id);
    const imported = state.sites.find((candidate) => candidate.id === result.createdSiteId);
    assert.equal(result.ok, true);
    assert.equal(state.sites.length, 2);
    assert.equal(source.apiKey, 'sk-old');
    assert.equal(source.multiplier, 2);
    assert.equal(imported.apiKey, 'sk-created');
    assert.equal(imported.priority, 7);
    assert.equal(imported.multiplier, 0.001);
    assert.equal(imported.customMultiplier, 0.5);
    assert.equal(imported.sync.accountId, source.sync.accountId);
    assert.equal(imported.sync.lastSyncStatus, 'success');
    assert.equal(imported.sync.remote.keyName, 'sync');
    assert.equal(imported.sync.remote.remoteKeyId, '37');
    assert.deepEqual(imported.modelMapping, source.modelMapping);
    assert.deepEqual(imported.rateLimit, source.rateLimit);
    assert.deepEqual(imported.autoRecovery, source.autoRecovery);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createConfiguredSiteKey keeps the existing api key when remote creation fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-create-key-action-failure-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-existing',
      multiplier: 0.5,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/keys',
        username: 'sync-user',
        password: 'secret',
        providerType: 'modern-v1'
      }
    });

    const result = await createConfiguredSiteKey({
      configService: service,
      siteId: site.id,
      createRemoteKey: async () => ({
        ok: false,
        apiKey: '',
        multiplier: null,
        syncPatch: {
          lastSyncAt: '2026-06-09T08:00:00.000Z',
          lastSyncStatus: 'failure',
          lastSyncError: 'create failed'
        },
        error: new Error('create failed')
      })
    });

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(result.ok, false);
    assert.equal(updated.apiKey, 'sk-existing');
    assert.equal(updated.multiplier, 0.5);
    assert.equal(updated.sync.lastSyncStatus, 'failure');
    assert.equal(updated.sync.lastSyncError, 'create failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncConfiguredSite persists a newly established session even when metadata sync fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-sync-action-failed-session-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'failed-metadata-sync',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-current',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com',
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
        authSession: {
          providerType: 'new-api',
          origin: 'https://relay.example.com',
          token: 'new-session-token',
          cookie: '',
          userId: '23',
          createdAt: '2026-07-31T08:00:00.000Z'
        },
        syncPatch: {
          lastSyncAt: '2026-07-31T08:00:00.000Z',
          lastSyncStatus: 'failure',
          lastSyncError: 'Configured API key was not found in the remote account'
        }
      })
    });

    assert.equal(result.ok, false);
    assert.equal(service.getRemoteAccountSession(site.id).token, 'new-session-token');
    assert.equal(service.findSite(site.id).sync.lastSyncStatus, 'failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provisionMissingLowMultiplierGroup creates, tests and imports one missing group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-provision-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  try {
    await service.load();
    await service.updateProxySettings({
      testModel: 'global-test-model',
      autoSwitchMultiplierLimit: { enabled: true, maxMultiplier: 0.01 }
    });
    const source = await service.addSite({
      name: 'source',
      baseUrl: 'https://source.example/v1',
      apiKey: 'sk-source',
      sync: {
        enabled: true,
        dashboardUrl: 'https://panel.example.com/console',
        username: 'shared-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          keyGroup: 'default',
          groupId: 'default',
          groups: [{ id: 'default', name: 'default', multiplier: 1, selected: true }]
        }
      }
    });
    const createdCalls = [];
    const testedCalls = [];
    const activityEvents = [];
    const result = await provisionMissingLowMultiplierGroup({
      configService: service,
      siteId: source.id,
      syncResult: {
        ok: true,
        syncPatch: {
          remote: {
            groups: [
              { id: 'default', name: 'default', multiplier: 1 },
              { id: 'low', name: 'Low', multiplier: 0.003 }
            ]
          }
        }
      },
      createRemoteKey: async ({ sync, name }) => {
        createdCalls.push({ groupId: sync.remote.groupId, name });
        return {
          ok: true,
          apiKey: 'sk-low',
          keyName: name,
          multiplier: 0.003,
          authSession: { providerType: 'new-api', origin: 'https://panel.example.com', token: 'session' },
          syncPatch: {
            remote: {
              remoteKeyId: '42',
              keyGroup: 'Low',
              groupId: 'low',
              groupMultiplier: 0.003
            }
          }
        };
      },
      testSite: async (site, options) => {
        testedCalls.push({ apiKey: site.apiKey, testModel: options.testModel });
        return { ok: true, statusCode: 200 };
      },
      onActivity: async (event) => {
        activityEvents.push(event);
        throw new Error('activity log unavailable');
      },
      now: new Date('2026-08-04T00:00:00.000Z')
    });

    assert.equal(result.ok, true);
    assert.equal(result.createdSite.apiKey, 'sk-low');
    assert.deepEqual(createdCalls.map((call) => call.groupId), ['low']);
    assert.deepEqual(testedCalls, [{ apiKey: 'sk-low', testModel: 'global-test-model' }]);
    assert.deepEqual(activityEvents.map((event) => event.type), [
      'candidate-found',
      'key-created',
      'test-passed',
      'imported'
    ]);
    assert.equal(activityEvents[0].candidateMultiplier, 0.003);
    assert.equal(activityEvents[0].currentLowestMultiplier, 1);
    assert.equal(activityEvents.at(-1).createdSiteId, result.createdSite.id);
    assert.equal(service.getState().sites.length, 2);
    assert.equal(service.getState().autoProvisionAttempts[0].status, 'success');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provisionMissingLowMultiplierGroup skips groups that do not beat the lowest usable multiplier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-provision-threshold-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  try {
    await service.load();
    await service.updateProxySettings({
      autoSwitchMultiplierLimit: { enabled: true, maxMultiplier: 0.01 }
    });
    const source = await service.addSite({
      name: 'source',
      baseUrl: 'https://source.example/v1',
      apiKey: 'sk-source',
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://panel.example.com/console',
        username: 'shared-user',
        password: 'secret',
        providerType: 'new-api',
        remote: {
          keyGroup: 'default',
          groupId: 'default',
          groupMultiplier: 1,
          groups: [{ id: 'default', name: 'default', multiplier: 1, selected: true }]
        }
      }
    });
    await service.addSite({
      name: 'current-lowest',
      baseUrl: 'https://lowest.example/v1',
      apiKey: 'sk-lowest',
      multiplier: 0.002
    });
    await service.addSite({
      name: 'disabled-lower',
      baseUrl: 'https://disabled.example/v1',
      apiKey: 'sk-disabled',
      multiplier: 0.001,
      manualEnabled: false
    });
    let createCalls = 0;
    let testCalls = 0;
    const activityEvents = [];

    const result = await provisionMissingLowMultiplierGroup({
      configService: service,
      siteId: source.id,
      syncResult: {
        ok: true,
        syncPatch: {
          remote: {
            groups: [
              { id: 'default', name: 'default', multiplier: 1 },
              { id: 'same-lowest', name: 'Same lowest', multiplier: 0.002 }
            ]
          }
        }
      },
      createRemoteKey: async () => {
        createCalls += 1;
        return { ok: true, apiKey: 'sk-created' };
      },
      testSite: async () => {
        testCalls += 1;
        return { ok: true, statusCode: 200 };
      },
      onActivity: async (event) => activityEvents.push(event)
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(createCalls, 0);
    assert.equal(testCalls, 0);
    assert.deepEqual(activityEvents.map((event) => event.type), ['not-beneficial']);
    assert.equal(activityEvents[0].currentLowestMultiplier, 0.002);
    assert.equal(service.getState().sites.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provisionMissingLowMultiplierGroup reports only cooldown before attempting key creation', async () => {
  const fixture = await createAutoProvisionFixture();
  const activityEvents = [];
  let createCalls = 0;

  try {
    await fixture.service.recordAutoProvisionAttempt({
      accountId: fixture.source.sync.accountId,
      groupId: 'low',
      groupName: 'Low',
      status: 'failure',
      error: 'previous availability test failed',
      now: new Date('2026-08-04T00:00:00.000Z')
    });

    const result = await provisionMissingLowMultiplierGroup({
      configService: fixture.service,
      siteId: fixture.source.id,
      syncResult: fixture.syncResult,
      createRemoteKey: async () => {
        createCalls += 1;
        return createProvisionKeyResult();
      },
      testSite: async () => ({ ok: true }),
      onActivity: async (event) => activityEvents.push(event),
      now: new Date('2026-08-04T01:00:00.000Z')
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'cooldown');
    assert.equal(createCalls, 0);
    assert.deepEqual(activityEvents.map((event) => event.type), ['cooldown']);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('provisionMissingLowMultiplierGroup reports a failed remote-key rollback', async () => {
  const fixture = await createAutoProvisionFixture();
  const activityEvents = [];

  try {
    const result = await provisionMissingLowMultiplierGroup({
      configService: fixture.service,
      siteId: fixture.source.id,
      syncResult: fixture.syncResult,
      createRemoteKey: async () => createProvisionKeyResult(),
      deleteRemoteKey: async () => ({
        ok: false,
        error: new Error('delete failed')
      }),
      testSite: async () => ({
        ok: false,
        statusCode: 503,
        message: 'Availability test failed HTTP 503'
      }),
      onActivity: async (event) => activityEvents.push(event),
      now: new Date('2026-08-04T01:00:00.000Z')
    });

    assert.equal(result.ok, false);
    assert.deepEqual(activityEvents.map((event) => event.type), [
      'candidate-found',
      'key-created',
      'test-failed'
    ]);
    assert.equal(activityEvents.at(-1).rolledBack, false);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('provisionMissingLowMultiplierGroup reports creation, test and import exceptions', async (t) => {
  const scenarios = [
    {
      name: 'creation exception',
      expectedTypes: ['candidate-found', 'create-failed'],
      createRemoteKey: async () => {
        throw new Error('create failed');
      },
      testSite: async () => ({ ok: true })
    },
    {
      name: 'test exception',
      expectedTypes: ['candidate-found', 'key-created', 'test-failed'],
      createRemoteKey: async () => createProvisionKeyResult(),
      testSite: async () => {
        throw new Error('test failed');
      }
    },
    {
      name: 'import exception',
      expectedTypes: ['candidate-found', 'key-created', 'test-passed', 'import-failed'],
      createRemoteKey: async () => createProvisionKeyResult(),
      testSite: async () => ({ ok: true }),
      failImport: true
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await createAutoProvisionFixture();
      const activityEvents = [];
      let deleteCalls = 0;
      try {
        if (scenario.failImport) {
          fixture.service.addSite = async () => {
            throw new Error('import failed');
          };
        }
        const operation = provisionMissingLowMultiplierGroup({
          configService: fixture.service,
          siteId: fixture.source.id,
          syncResult: fixture.syncResult,
          createRemoteKey: scenario.createRemoteKey,
          deleteRemoteKey: async () => {
            deleteCalls += 1;
            return { ok: true };
          },
          testSite: scenario.testSite,
          onActivity: async (event) => activityEvents.push(event)
        });

        if (scenario.failImport) {
          await assert.rejects(operation, /import failed/);
        } else {
          const result = await operation;
          assert.equal(result.ok, false);
        }
        assert.deepEqual(activityEvents.map((event) => event.type), scenario.expectedTypes);
        assert.equal(activityEvents.at(-1).status, 'failure');
        assert.equal(deleteCalls, scenario.name === 'creation exception' ? 0 : 1);
      } finally {
        await rm(fixture.dir, { recursive: true, force: true });
      }
    });
  }
});

async function createAutoProvisionFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-provision-error-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  await service.load();
  await service.updateProxySettings({
    testModel: 'global-test-model',
    autoSwitchMultiplierLimit: { enabled: true, maxMultiplier: 0.01 }
  });
  const source = await service.addSite({
    name: 'source',
    baseUrl: 'https://source.example/v1',
    apiKey: 'sk-source',
    sync: {
      enabled: true,
      dashboardUrl: 'https://panel.example.com/console',
      username: 'shared-user',
      password: 'secret',
      providerType: 'new-api',
      remote: {
        keyGroup: 'default',
        groupId: 'default',
        groups: [{ id: 'default', name: 'default', multiplier: 1, selected: true }]
      }
    }
  });
  return {
    dir,
    service,
    source,
    syncResult: {
      ok: true,
      syncPatch: {
        remote: {
          groups: [
            { id: 'default', name: 'default', multiplier: 1 },
            { id: 'low', name: 'Low', multiplier: 0.003 }
          ]
        }
      }
    }
  };
}

function createProvisionKeyResult() {
  return {
    ok: true,
    apiKey: 'sk-low',
    keyName: 'Low',
    multiplier: 0.003,
    syncPatch: {
      remote: {
        remoteKeyId: '42',
        keyGroup: 'Low',
        groupId: 'low',
        groupMultiplier: 0.003
      }
    }
  };
}
