import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import {
  createConfiguredSiteKey,
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

test('createConfiguredSiteKey writes the generated key and remote metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-create-key-action-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-old',
      multiplier: 1,
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

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(result.ok, true);
    assert.equal(updated.apiKey, 'sk-created');
    assert.equal(updated.multiplier, 0.001);
    assert.equal(updated.sync.lastSyncStatus, 'success');
    assert.equal(updated.sync.remote.keyName, 'sync');
    assert.equal(updated.sync.remote.remoteKeyId, '37');
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
