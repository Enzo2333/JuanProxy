import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';

test('persists add, update, clone and delete operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-config-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    assert.equal(service.getState().proxy.port, 8787);
    assert.equal(service.getState().proxy.timeoutMs, 120000);
    assert.equal(service.getState().sites.length, 0);

    const created = await service.addSite({
      name: 'Example Upstream',
      baseUrl: 'https://upstream.example.com/v1',
      apiKey: 'sk-test'
    });

    await service.updateSite(created.id, {
      name: 'Example Upstream Primary',
      enabled: true
    });

    const cloned = await service.cloneSite(created.id);
    await service.deleteSite(created.id);

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const state = reloaded.getState();

    assert.equal(state.sites.length, 1);
    assert.equal(state.sites[0].id, cloned.id);
    assert.equal(state.sites[0].name, 'Example Upstream Primary Copy');
    assert.equal(state.sites[0].baseUrl, 'https://upstream.example.com/v1');
    assert.equal(state.sites[0].apiKey, 'sk-test');
    assert.equal(state.activeSiteId, cloned.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists site remark across add, update, clone and reload operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-remark-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    const created = await service.addSite({
      name: 'Primary',
      baseUrl: 'https://primary.example/v1',
      apiKey: 'sk-primary',
      remark: 'production fallback'
    });
    assert.equal(created.remark, 'production fallback');

    const updated = await service.updateSite(created.id, {
      remark: 'priority paid account'
    });
    assert.equal(updated.remark, 'priority paid account');

    const cloned = await service.cloneSite(created.id);
    assert.equal(cloned.remark, 'priority paid account');

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const state = reloaded.getState();

    assert.equal(state.sites.find((site) => site.id === created.id).remark, 'priority paid account');
    assert.equal(state.sites.find((site) => site.id === cloned.id).remark, 'priority paid account');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exports selected sites with optional global settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-export-selected-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    await service.updateProxySettings({ port: 9988, timeoutMs: 90000 });
    await service.updateModelMapping({
      enabled: true,
      mappings: [{ from: 'request-model', to: 'upstream-model' }]
    });
    await service.updateGroupSyncSettings({
      intervalValue: 15,
      intervalUnit: 'minute',
      websites: [
        {
          key: 'https://runtime-cache.example.com',
          dashboardUrl: 'https://runtime-cache.example.com/console/token',
          username: 'sync-user',
          groups: [
            { id: 'cached', name: 'cached', multiplier: 0.003 }
          ]
        }
      ]
    });

    const first = await service.addSite({
      name: 'First',
      baseUrl: 'https://first.example/v1',
      apiKey: 'example-key-1'
    });
    const second = await service.addSite({
      name: 'Second',
      baseUrl: 'https://second.example/v1',
      apiKey: 'example-key-2',
      priority: 7
    });
    await service.recordSiteRequestFailure(second.id, { statusCode: 502, message: 'bad gateway' });
    await service.flush();

    const exported = service.exportConfig({
      siteIds: [second.id],
      includeGlobalSettings: true
    }, new Date('2026-06-10T08:00:00.000Z'));

    assert.equal(exported.kind, 'juanproxy.config-export');
    assert.equal(exported.exportedAt, '2026-06-10T08:00:00.000Z');
    assert.equal(exported.sites.length, 1);
    assert.equal(exported.sites[0].sourceId, second.id);
    assert.equal(exported.sites[0].name, 'Second');
    assert.equal(exported.sites[0].priority, 7);
    assert.equal(exported.sites[0].requestCount, undefined);
    assert.equal(exported.sites[0].errorLog, undefined);
    assert.equal(exported.settings.proxy.port, 9988);
    assert.deepEqual(exported.settings.modelMapping.mappings, [
      { from: 'request-model', to: 'upstream-model' }
    ]);
    assert.deepEqual(exported.settings.groupSync, {
      intervalValue: 15,
      intervalUnit: 'minute'
    });

    const withoutGlobalSettings = service.exportConfig({
      siteIds: [first.id],
      includeGlobalSettings: false
    });
    assert.equal(withoutGlobalSettings.settings, null);
    assert.equal(withoutGlobalSettings.sites[0].sourceId, first.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('imports selected exported sites by merging and optionally applying global settings', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'openapi-proxy-import-source-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'openapi-proxy-import-target-'));
  const sourcePath = join(sourceDir, 'config.json');
  const targetPath = join(targetDir, 'config.json');

  try {
    const source = new ConfigService({ filePath: sourcePath });
    await source.load();
    await source.updateProxySettings({ port: 9977, timeoutMs: 60000 });
    await source.updateSiteSyncSettings({
      intervalValue: 2,
      intervalUnit: 'hour',
      intelligentScheduling: false
    });
    await source.updateGroupSyncSettings({
      intervalValue: 45,
      intervalUnit: 'minute'
    });
    const first = await source.addSite({
      name: 'Imported A',
      baseUrl: 'https://import-a.example/v1',
      apiKey: 'example-import-a'
    });
    const second = await source.addSite({
      name: 'Imported B',
      baseUrl: 'https://import-b.example/v1',
      apiKey: 'example-import-b',
      multiplier: 0.5
    });
    const exported = source.exportConfig({ includeGlobalSettings: true });

    const target = new ConfigService({ filePath: targetPath });
    await target.load();
    const existing = await target.addSite({
      name: 'Existing',
      baseUrl: 'https://existing.example/v1',
      apiKey: 'example-existing'
    });

    const result = await target.importConfig(exported, {
      siteIds: [second.id],
      includeGlobalSettings: true
    }, new Date('2026-06-10T09:00:00.000Z'));
    const state = target.getState();

    assert.equal(result.importedSiteCount, 1);
    assert.equal(result.importedGlobalSettings, true);
    assert.equal(state.proxy.port, 9977);
    assert.equal(state.siteSync.intervalValue, 2);
    assert.equal(state.groupSync.intervalValue, 45);
    assert.equal(state.groupSync.intervalUnit, 'minute');
    assert.equal(state.sites.length, 2);
    assert.equal(state.sites.some((site) => site.id === existing.id), true);

    const imported = state.sites.find((site) => site.name === 'Imported B');
    assert.ok(imported);
    assert.notEqual(imported.id, second.id);
    assert.equal(imported.sourceId, undefined);
    assert.equal(imported.baseUrl, 'https://import-b.example/v1');
    assert.equal(imported.apiKey, 'example-import-b');
    assert.equal(imported.multiplier, 0.5);
    assert.equal(imported.requestCount, 0);
    assert.equal(imported.errorLog.length, 0);
    assert.equal(state.sites.some((site) => site.name === 'Imported A'), false);
    assert.equal(first.name, 'Imported A');
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('imports selected sites from a raw config file payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-import-raw-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    const rawPayload = {
      version: 1,
      proxy: {
        port: 8788,
        timeoutMs: 30000,
        failureThreshold: 2
      },
      sites: [
        {
          id: 'raw-a',
          name: 'Raw A',
          baseUrl: 'https://raw-a.example/v1',
          apiKey: 'example-raw-a'
        },
        {
          id: 'raw-b',
          name: 'Raw B',
          baseUrl: 'https://raw-b.example/v1',
          apiKey: 'example-raw-b'
        }
      ]
    };

    const preview = service.previewImportConfig(JSON.stringify(rawPayload));
    assert.equal(preview.hasGlobalSettings, true);
    assert.deepEqual(preview.sites.map((site) => site.sourceId), ['raw-a', 'raw-b']);

    await service.importConfig(JSON.stringify(rawPayload), {
      siteIds: ['raw-a'],
      includeGlobalSettings: false
    });
    const state = service.getState();

    assert.equal(state.proxy.port, 8787);
    assert.equal(state.sites.length, 1);
    assert.equal(state.sites[0].name, 'Raw A');
    assert.notEqual(state.sites[0].id, 'raw-a');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validates imported sites against imported proxy settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-import-proxy-validation-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    const payload = {
      kind: 'juanproxy.config-export',
      version: 1,
      settings: {
        proxy: {
          port: 9988,
          timeoutMs: 30000,
          failureThreshold: 2,
          smartSwitching: true,
          priorityMode: 'priority',
          samePriorityStrategy: 'round-robin'
        },
        modelMapping: {
          enabled: false,
          mappings: []
        },
        siteSync: {
          intervalValue: 30,
          intervalUnit: 'minute',
          intelligentScheduling: true
        }
      },
      sites: [
        {
          sourceId: 'local-old-port',
          name: 'Old Port Local URL',
          baseUrl: 'http://127.0.0.1:8787/v1',
          apiKey: 'example-local-old-port'
        }
      ]
    };

    await service.importConfig(payload, {
      includeGlobalSettings: true
    });
    const state = service.getState();

    assert.equal(state.proxy.port, 9988);
    assert.equal(state.sites.length, 1);
    assert.equal(state.sites[0].name, 'Old Port Local URL');
    assert.equal(state.sites[0].failureDisabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects invalid site configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-invalid-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    await assert.rejects(
      () => service.addSite({ name: '', baseUrl: 'not-a-url', apiKey: '' }),
      /name is required/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects automatic proxy port assignment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-fixed-port-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    await assert.rejects(
      () => service.updateProxySettings({ port: 0 }),
      /proxy port must be an integer between 1 and 65535/i
    );
    assert.equal(service.getState().proxy.port, 8787);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a site base URL that points back to the local proxy port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-self-site-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    await service.updateProxySettings({ port: 9758 });

    await assert.rejects(
      () => service.addSite({ name: 'self', baseUrl: 'http://127.0.0.1:9758/v1', apiKey: 'sk-test' }),
      /site baseUrl must not point to the local proxy/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('disables a persisted site that points back to the local proxy port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-persisted-self-site-'));
  const filePath = join(dir, 'config.json');

  try {
    await writeFile(filePath, JSON.stringify({
      version: 1,
      proxy: {
        port: 9758,
        failureThreshold: 3,
        smartSwitching: true,
        samePriorityStrategy: 'round-robin',
        lastSelectedSiteId: null
      },
      activeSiteId: 'self-site',
      sites: [{
        id: 'self-site',
        name: 'self',
        baseUrl: 'http://127.0.0.1:9758/v1',
        apiKey: 'sk-test',
        manualEnabled: true,
        failureDisabled: false
      }]
    }), 'utf8');

    const service = new ConfigService({ filePath });
    await service.load();

    const state = service.getState();
    assert.equal(state.activeSiteId, null);
    assert.equal(state.sites[0].manualEnabled, true);
    assert.equal(state.sites[0].failureDisabled, true);
    assert.equal(state.sites[0].enabled, false);
    assert.match(state.sites[0].lastError.message, /local proxy/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not duplicate local-proxy failure records on repeated loads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-persisted-self-site-repeat-'));
  const filePath = join(dir, 'config.json');

  try {
    await writeFile(filePath, JSON.stringify({
      version: 1,
      proxy: {
        port: 9758,
        failureThreshold: 3,
        smartSwitching: true,
        samePriorityStrategy: 'round-robin',
        lastSelectedSiteId: null
      },
      activeSiteId: 'self-site',
      sites: [{
        id: 'self-site',
        name: 'self',
        baseUrl: 'http://127.0.0.1:9758/v1',
        apiKey: 'sk-test',
        manualEnabled: true,
        failureDisabled: false
      }]
    }), 'utf8');

    const first = new ConfigService({ filePath });
    await first.load();
    const second = new ConfigService({ filePath });
    await second.load();

    const site = second.getState().sites[0];
    assert.equal(site.consecutiveErrors, 1);
    assert.equal(site.errorCount, 1);
    assert.equal(site.errorLog.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not make a disabled site active when adding or cloning it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-disabled-active-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    const disabled = await service.addSite({
      name: 'disabled',
      baseUrl: 'https://disabled.example/v1',
      apiKey: 'sk-disabled',
      enabled: false
    });
    await service.cloneSite(disabled.id);

    const state = service.getState();
    assert.equal(state.activeSiteId, null);
    assert.equal(state.sites.length, 2);
    assert.equal(state.sites.every((site) => !site.enabled), true);
    assert.equal(state.sites.every((site) => site.manualEnabled === false), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('disables a failing active site after the failure threshold and switches to another enabled site', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-disable-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    const bad = await service.addSite({
      name: 'bad',
      baseUrl: 'https://bad.example/v1',
      apiKey: 'sk-bad'
    });
    const good = await service.addSite({
      name: 'good',
      baseUrl: 'https://good.example/v1',
      apiKey: 'sk-good'
    });
    await service.setActiveSite(bad.id);

    for (let index = 0; index < 3; index += 1) {
      await service.recordSiteFailure(bad.id, { statusCode: 500, message: 'failed' });
    }

    const state = service.getState();
    const badState = state.sites.find((site) => site.id === bad.id);

    assert.equal(badState.manualEnabled, true);
    assert.equal(badState.failureDisabled, true);
    assert.equal(badState.enabled, false);
    assert.equal(badState.status, 'error');
    assert.equal(state.activeSiteId, good.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual enable clears automatic disable and rate limit pause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-manual-enable-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateProxySettings({ failureThreshold: 0 });
    const site = await service.addSite({
      name: 'limited',
      baseUrl: 'https://limited.example/v1',
      apiKey: 'sk-limited',
      rateLimit: {
        enabled: true,
        limit: 1,
        windowValue: 1,
        windowUnit: 'minute'
      }
    });

    await service.selectSiteForRequest(new Date('2026-06-03T08:00:00.000Z'));
    await service.recordSiteFailure(site.id, { statusCode: 500, message: 'failed' });
    await service.setSiteEnabled(site.id, true);

    const updated = service.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(updated.manualEnabled, true);
    assert.equal(updated.failureDisabled, false);
    assert.equal(updated.enabled, true);
    assert.equal(updated.rateLimitState.pausedUntil, null);
    assert.equal(service.getState().activeSiteId, site.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists priority mode, priority, multiplier and same-priority selection strategy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-priority-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    await service.updateProxySettings({ priorityMode: 'multiplier', samePriorityStrategy: 'random' });
    const created = await service.addSite({
      name: 'priority',
      baseUrl: 'https://priority.example/v1',
      apiKey: 'sk-priority',
      priority: 3,
      multiplier: 0.25
    });

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const state = reloaded.getState();

    assert.equal(state.proxy.priorityMode, 'multiplier');
    assert.equal(state.proxy.samePriorityStrategy, 'random');
    assert.equal(state.sites.find((site) => site.id === created.id).priority, 3);
    assert.equal(state.sites.find((site) => site.id === created.id).multiplier, 0.25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists remote site sync settings across add, update, clone and reload operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    const created = await service.addSite({
      name: 'sync',
      baseUrl: 'https://sync.example/v1',
      apiKey: 'sk-sync',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync.example.com/keys',
        username: 'user@example.com',
        password: 'secret',
        providerType: 'modern-v1',
        intervalValue: 15,
        intervalUnit: 'minute'
      }
    });
    assert.equal(created.sync.enabled, true);
    assert.equal(created.sync.dashboardUrl, 'https://sync.example.com/keys');
    assert.equal(created.sync.intervalMode, 'custom');
    assert.equal(created.sync.intervalValue, 15);
    assert.equal(created.sync.intervalUnit, 'minute');

    const updated = await service.updateSite(created.id, {
      sync: {
        ...created.sync,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'sync-secret',
        providerType: 'new-api',
        intervalValue: 2,
        intervalUnit: 'hour',
        lastSyncAt: '2026-06-09T08:00:00.000Z',
        lastSyncStatus: 'success',
        remote: {
          providerType: 'new-api',
          authType: 'Bearer token (/api)',
          accountName: 'sync-user',
          balance: '$0.00',
          apiEndpoint: '',
          keyName: 'qa',
          keyGroup: 'AAA.限时白嫖GPT 0.003x',
          groupMultiplier: 0.003
        }
      }
    });
    assert.equal(updated.sync.providerType, 'new-api');
    assert.equal(updated.sync.intervalMode, 'custom');
    assert.equal(updated.sync.intervalValue, 2);
    assert.equal(updated.sync.intervalUnit, 'hour');
    assert.equal(updated.sync.remote.keyGroup, 'AAA.限时白嫖GPT 0.003x');
    assert.equal(updated.sync.remote.groupMultiplier, 0.003);

    const cloned = await service.cloneSite(created.id);

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const state = reloaded.getState();
    const original = state.sites.find((site) => site.id === created.id);
    const copy = state.sites.find((site) => site.id === cloned.id);

    assert.equal(original.sync.dashboardUrl, 'https://relay.example.com/console/token');
    assert.equal(original.sync.password, 'sync-secret');
    assert.equal(original.sync.intervalValue, 2);
    assert.equal(original.sync.intervalUnit, 'hour');
    assert.equal(original.sync.remote.keyName, 'qa');
    assert.equal(copy.sync.dashboardUrl, 'https://relay.example.com/console/token');
    assert.equal(copy.sync.username, 'sync-user');
    assert.equal(copy.sync.intervalMode, 'custom');
    assert.equal(copy.sync.intervalValue, 2);
    assert.equal(copy.sync.intervalUnit, 'hour');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists global remote site sync settings across reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-global-site-sync-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    assert.deepEqual(service.getSiteSyncSettings(), {
      intervalValue: 30,
      intervalUnit: 'minute',
      intelligentScheduling: true
    });

    await service.updateSiteSyncSettings({
      intervalValue: 2,
      intervalUnit: 'hour',
      intelligentScheduling: false
    });

    assert.deepEqual(service.getState().siteSync, {
      intervalValue: 2,
      intervalUnit: 'hour',
      intelligentScheduling: false
    });

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();

    assert.deepEqual(reloaded.getSiteSyncSettings(), {
      intervalValue: 2,
      intervalUnit: 'hour',
      intelligentScheduling: false
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists group sync refresh settings across reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-global-group-sync-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    assert.deepEqual(service.getGroupSyncSettings(), {
      intervalValue: 30,
      intervalUnit: 'minute',
      websites: []
    });

    await service.updateGroupSyncSettings({
      intervalValue: 2,
      intervalUnit: 'hour'
    });

    assert.deepEqual(service.getState().groupSync, {
      intervalValue: 2,
      intervalUnit: 'hour',
      websites: []
    });

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();

    assert.deepEqual(reloaded.getGroupSyncSettings(), {
      intervalValue: 2,
      intervalUnit: 'hour',
      websites: []
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maintains a deduplicated group sync website list from configured sync sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-group-sync-list-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    assert.deepEqual(service.getGroupSyncSettings(), {
      intervalValue: 30,
      intervalUnit: 'minute',
      websites: []
    });

    const first = await service.addSite({
      name: 'primary',
      baseUrl: 'https://primary.example/v1',
      apiKey: 'sk-primary',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api'
      }
    });
    await service.addSite({
      name: 'backup',
      baseUrl: 'https://backup.example/v1',
      apiKey: 'sk-backup',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/profile',
        username: 'sync-user',
        password: 'secret',
        providerType: 'new-api'
      }
    });
    const other = await service.addSite({
      name: 'other',
      baseUrl: 'https://other.example/v1',
      apiKey: 'sk-other',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync.example.com/keys',
        username: 'other-user',
        password: 'secret',
        providerType: 'modern-v1'
      }
    });
    await service.addSite({
      name: 'draft',
      baseUrl: 'https://draft.example/v1',
      apiKey: 'sk-draft',
      sync: {
        enabled: true,
        dashboardUrl: 'https://draft.example.com/keys',
        username: 'draft-user',
        password: ''
      }
    });

    assert.deepEqual(service.getGroupSyncSettings().websites.map((website) => website.key), [
      'https://relay.example.com',
      'https://sync.example.com'
    ]);

    await service.recordGroupSyncSuccess(
      'https://relay.example.com',
      {
        ok: true,
        multiplier: 0.003,
        syncPatch: {
          lastSyncAt: '2026-06-09T08:00:00.000Z',
          lastSyncStatus: 'success',
          lastSyncError: null,
          remote: {
            groups: [
              { id: 'default', name: 'default', multiplier: 0.003, selected: true }
            ]
          }
        }
      },
      { representativeSiteId: first.id }
    );

    await service.deleteSite(other.id);
    const afterDelete = service.getGroupSyncSettings();
    assert.deepEqual(afterDelete.websites.map((website) => website.key), [
      'https://relay.example.com'
    ]);
    assert.equal(afterDelete.websites[0].lastRefreshStatus, 'success');
    assert.deepEqual(afterDelete.websites[0].groups.map((group) => group.name), ['default']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists global and per-site model mappings across reloads and clones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-model-mapping-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    await service.updateModelMapping({
      enabled: true,
      mappings: [
        { from: ' gpt-5 ', to: 'gpt-5-mini' },
        { from: 'empty-target', to: '' },
        { from: '', to: 'empty-source' }
      ]
    });

    const created = await service.addSite({
      name: 'mapped',
      baseUrl: 'https://mapped.example/v1',
      apiKey: 'sk-mapped',
      modelMapping: {
        enabled: true,
        mappings: [
          { from: 'gpt-5', to: 'claude-sonnet-4-5' },
          { from: 'gpt-4o', to: 'gpt-4.1' }
        ]
      }
    });
    const cloned = await service.cloneSite(created.id);

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const state = reloaded.getState();
    const original = state.sites.find((site) => site.id === created.id);
    const copy = state.sites.find((site) => site.id === cloned.id);

    assert.deepEqual(state.modelMapping, {
      enabled: true,
      mappings: [{ from: 'gpt-5', to: 'gpt-5-mini' }]
    });
    assert.deepEqual(original.modelMapping, {
      enabled: true,
      mappings: [
        { from: 'gpt-5', to: 'claude-sonnet-4-5' },
        { from: 'gpt-4o', to: 'gpt-4.1' }
      ]
    });
    assert.deepEqual(copy.modelMapping, original.modelMapping);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists site capability snapshots and clears them when credentials change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-capabilities-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    const created = await service.addSite({
      name: 'capable',
      baseUrl: 'https://capable.example/v1',
      apiKey: 'sk-capable'
    });
    await service.updateSiteCapabilities(created.id, {
      models: ['gpt-5-mini', 'dall-e-3'],
      features: {
        textGeneration: true,
        imageGeneration: true
      },
      featureModels: {
        textGeneration: ['gpt-5-mini'],
        imageGeneration: ['dall-e-3']
      },
      checkedAt: '2026-06-10T08:00:00.000Z',
      lastStatus: 'success',
      source: '/v1/models'
    });
    const cloned = await service.cloneSite(created.id);

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const original = reloaded.getSiteSnapshot(created.id);
    const copy = reloaded.getSiteSnapshot(cloned.id);

    assert.deepEqual(original.capabilities.models, ['dall-e-3', 'gpt-5-mini']);
    assert.equal(original.capabilities.features.textGeneration, true);
    assert.equal(original.capabilities.features.imageGeneration, true);
    assert.deepEqual(copy.capabilities, original.capabilities);

    const updated = await reloaded.updateSite(created.id, {
      apiKey: 'sk-capable-new'
    });
    assert.deepEqual(updated.capabilities.models, []);
    assert.equal(updated.capabilities.lastStatus, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns due remote sync sites using global or custom interval modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-effective-due-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateSiteSyncSettings({
      intervalValue: 2,
      intervalUnit: 'hour',
      intelligentScheduling: false
    });
    const inheritedLater = await service.addSite({
      name: 'inherited-later',
      baseUrl: 'https://inherited-later.example/v1',
      apiKey: 'sk-inherited-later',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        intervalMode: 'global',
        lastSyncAt: '2026-06-09T08:00:00.000Z'
      }
    });
    const inheritedDue = await service.addSite({
      name: 'inherited-due',
      baseUrl: 'https://inherited-due.example/v1',
      apiKey: 'sk-inherited-due',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync.example.com/keys',
        username: 'user@example.com',
        password: 'secret',
        intervalMode: 'global',
        lastSyncAt: '2026-06-09T06:00:00.000Z'
      }
    });
    const customDue = await service.addSite({
      name: 'custom-due',
      baseUrl: 'https://custom-due.example/v1',
      apiKey: 'sk-custom-due',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync-one.example.com/profile',
        username: 'sync-one-user',
        password: 'secret',
        intervalMode: 'custom',
        intervalValue: 15,
        intervalUnit: 'minute',
        lastSyncAt: '2026-06-09T08:30:00.000Z'
      }
    });

    assert.deepEqual(
      service.getDueSiteSyncSites(new Date('2026-06-09T08:45:00.000Z')).map((site) => site.id),
      [inheritedDue.id, customDue.id]
    );

    await service.updateSiteSyncSettings({
      intervalValue: 30,
      intervalUnit: 'minute',
      intelligentScheduling: false
    });

    assert.deepEqual(
      service.getDueSiteSyncSites(new Date('2026-06-09T08:45:00.000Z')).map((site) => site.id),
      [inheritedLater.id, inheritedDue.id, customDue.id]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('intelligent site sync scheduling slows inactive or failing sites and skips auth failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-smart-due-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateSiteSyncSettings({
      intervalValue: 30,
      intervalUnit: 'minute',
      intelligentScheduling: true
    });

    const activeDue = await addConfiguredSyncSite(service, 'active-due', {
      lastSyncAt: '2026-06-09T08:00:00.000Z'
    });
    setSiteLastRequestAt(service, activeDue.id, '2026-06-09T08:20:00.000Z');

    const inactive = await addConfiguredSyncSite(service, 'inactive', {
      lastSyncAt: '2026-06-09T08:00:00.000Z'
    });
    setSiteLastRequestAt(service, inactive.id, '2026-06-08T07:00:00.000Z');

    const failing = await addConfiguredSyncSite(service, 'failing', {
      lastSyncAt: '2026-06-09T08:00:00.000Z',
      lastSyncStatus: 'failure',
      lastSyncError: 'Remote request failed HTTP 500'
    });
    setSiteLastRequestAt(service, failing.id, '2026-06-09T08:10:00.000Z');

    const authFailure = await addConfiguredSyncSite(service, 'auth-failure', {
      lastSyncAt: '2026-06-09T06:00:00.000Z',
      lastSyncStatus: 'failure',
      lastSyncError: 'password invalid'
    });
    setSiteLastRequestAt(service, authFailure.id, '2026-06-09T08:10:00.000Z');

    assert.deepEqual(
      service.getDueSiteSyncSites(new Date('2026-06-09T08:30:00.000Z')).map((site) => site.id),
      [activeDue.id]
    );

    await service.updateSiteSyncSettings({
      intervalValue: 30,
      intervalUnit: 'minute',
      intelligentScheduling: false
    });

    assert.deepEqual(
      service.getDueSiteSyncSites(new Date('2026-06-09T08:30:00.000Z')).map((site) => site.id),
      [activeDue.id, inactive.id, failing.id, authFailure.id]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns due configured remote sync sites by custom interval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-due-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const neverSynced = await service.addSite({
      name: 'never-synced',
      baseUrl: 'https://never.example/v1',
      apiKey: 'sk-never',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync.example.com/keys',
        username: 'user@example.com',
        password: 'secret',
        intervalValue: 30,
        intervalUnit: 'minute'
      }
    });
    const due = await service.addSite({
      name: 'due',
      baseUrl: 'https://due.example/v1',
      apiKey: 'sk-due',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        lastSyncAt: '2026-06-09T08:00:00.000Z',
        intervalValue: 30,
        intervalUnit: 'minute'
      }
    });
    await service.addSite({
      name: 'later',
      baseUrl: 'https://later.example/v1',
      apiKey: 'sk-later',
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync-one.example.com/profile',
        username: 'sync-one-user',
        password: 'secret',
        lastSyncAt: '2026-06-09T08:20:00.000Z',
        intervalValue: 30,
        intervalUnit: 'minute'
      }
    });
    await service.addSite({
      name: 'missing-password',
      baseUrl: 'https://missing.example/v1',
      apiKey: 'sk-missing',
      sync: {
        enabled: true,
        dashboardUrl: 'https://missing.example/keys',
        username: 'missing',
        password: '',
        intervalValue: 1,
        intervalUnit: 'minute'
      }
    });
    await service.addSite({
      name: 'disabled-sync',
      baseUrl: 'https://disabled-sync.example/v1',
      apiKey: 'sk-disabled-sync',
      sync: {
        enabled: false,
        dashboardUrl: 'https://disabled.example/keys',
        username: 'disabled',
        password: 'secret',
        intervalValue: 1,
        intervalUnit: 'minute'
      }
    });

    const dueSites = service.getDueSiteSyncSites(new Date('2026-06-09T08:30:00.000Z'));

    assert.deepEqual(dueSites.map((site) => site.id), [neverSynced.id, due.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function addConfiguredSyncSite(service, name, syncPatch = {}) {
  return service.addSite({
    name,
    baseUrl: `https://${name}.example/v1`,
    apiKey: `sk-${name}`,
    sync: {
      enabled: true,
      dashboardUrl: 'https://relay.example.com/console/token',
      username: `${name}@example.com`,
      password: 'secret',
      intervalMode: 'global',
      ...syncPatch
    }
  });
}

function setSiteLastRequestAt(service, siteId, value) {
  const site = service.state.sites.find((candidate) => candidate.id === siteId);
  site.lastRequestAt = value;
  site.lastSuccessAt = value;
}

test('persists and validates the unified upstream timeout setting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-timeout-setting-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();

    await service.updateProxySettings({ timeoutMs: 300000 });
    assert.equal(service.getState().proxy.timeoutMs, 300000);

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    assert.equal(reloaded.getState().proxy.timeoutMs, 300000);

    await assert.rejects(
      () => service.updateProxySettings({ timeoutMs: 999 }),
      /upstream timeout must be an integer greater than or equal to 1000ms/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('selects request sites by priority and round-robins same-priority sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-select-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateProxySettings({ samePriorityStrategy: 'round-robin' });
    await service.addSite({
      name: 'later',
      baseUrl: 'https://later.example/v1',
      apiKey: 'sk-later',
      priority: 5
    });
    const first = await service.addSite({
      name: 'first',
      baseUrl: 'https://first.example/v1',
      apiKey: 'sk-first',
      priority: 1
    });
    const second = await service.addSite({
      name: 'second',
      baseUrl: 'https://second.example/v1',
      apiKey: 'sk-second',
      priority: 1
    });

    assert.equal((await service.selectSiteForRequest()).id, first.id);
    assert.equal((await service.selectSiteForRequest()).id, second.id);
    assert.equal((await service.selectSiteForRequest()).id, first.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('selects request sites by multiplier and uses lower priority when multipliers match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-select-multiplier-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateProxySettings({ priorityMode: 'multiplier' });
    await service.addSite({
      name: 'priority-only',
      baseUrl: 'https://priority-only.example/v1',
      apiKey: 'sk-priority-only',
      priority: 1,
      multiplier: 2
    });
    await service.addSite({
      name: 'multiplier-tie-high-priority',
      baseUrl: 'https://multiplier-high.example/v1',
      apiKey: 'sk-multiplier-high',
      priority: 5,
      multiplier: 0.5
    });
    const preferred = await service.addSite({
      name: 'multiplier-tie-low-priority',
      baseUrl: 'https://multiplier-low.example/v1',
      apiKey: 'sk-multiplier-low',
      priority: 2,
      multiplier: 0.5
    });

    assert.equal((await service.selectSiteForRequest()).id, preferred.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists auto recovery settings without scheduling manually disabled sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-recovery-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    const created = await service.addSite({
      name: 'recoverable',
      baseUrl: 'https://recoverable.example/v1',
      apiKey: 'sk-recoverable',
      autoRecovery: {
        enabled: true,
        intervalValue: 2,
        intervalUnit: 'hour'
      }
    });

    await service.setSiteEnabled(created.id, false, new Date('2026-06-03T08:00:00.000Z'));

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const site = reloaded.getState().sites.find((candidate) => candidate.id === created.id);

    assert.deepEqual(site.autoRecovery, {
      enabled: true,
      intervalValue: 2,
      intervalUnit: 'hour'
    });
    assert.equal(site.manualEnabled, false);
    assert.equal(site.enabled, false);
    assert.equal(site.autoRecoveryState.nextCheckAt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('schedules disabled-site auto recovery after failure threshold disables a site', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-recovery-threshold-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const bad = await service.addSite({
      name: 'bad',
      baseUrl: 'https://bad.example/v1',
      apiKey: 'sk-bad',
      autoRecovery: {
        enabled: true,
        intervalValue: 5,
        intervalUnit: 'minute'
      }
    });

    for (let index = 0; index < 3; index += 1) {
      await service.recordSiteFailure(
        bad.id,
        { statusCode: 500, message: 'failed' },
        new Date('2026-06-03T08:00:00.000Z')
      );
    }

    const site = service.getState().sites.find((candidate) => candidate.id === bad.id);

    assert.equal(site.enabled, false);
    assert.equal(site.manualEnabled, true);
    assert.equal(site.failureDisabled, true);
    assert.equal(site.autoRecoveryState.nextCheckAt, '2026-06-03T08:05:00.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns only due disabled sites with auto recovery enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-recovery-due-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const due = await service.addSite({
      name: 'due',
      baseUrl: 'https://due.example/v1',
      apiKey: 'sk-due',
      autoRecovery: {
        enabled: true,
        intervalValue: 1,
        intervalUnit: 'minute'
      }
    });
    const later = await service.addSite({
      name: 'later',
      baseUrl: 'https://later.example/v1',
      apiKey: 'sk-later',
      autoRecovery: {
        enabled: true,
        intervalValue: 10,
        intervalUnit: 'minute'
      }
    });
    await service.addSite({
      name: 'disabled-off',
      baseUrl: 'https://disabled-off.example/v1',
      apiKey: 'sk-disabled-off',
      enabled: false
    });

    await service.setSiteEnabled(due.id, false, new Date('2026-06-03T08:00:00.000Z'));
    await service.setSiteEnabled(later.id, false, new Date('2026-06-03T08:00:00.000Z'));

    const dueSites = service.getDueDisabledAutoRecoverySites(
      new Date('2026-06-03T08:01:00.000Z')
    );

    assert.deepEqual(dueSites.map((site) => site.id), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns due failure-disabled sites but skips manually disabled sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-auto-recovery-failure-only-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateProxySettings({ failureThreshold: 0 });
    const autoDisabled = await service.addSite({
      name: 'auto-disabled',
      baseUrl: 'https://auto-disabled.example/v1',
      apiKey: 'sk-auto-disabled',
      autoRecovery: {
        enabled: true,
        intervalValue: 1,
        intervalUnit: 'minute'
      }
    });
    const manualDisabled = await service.addSite({
      name: 'manual-disabled',
      baseUrl: 'https://manual-disabled.example/v1',
      apiKey: 'sk-manual-disabled',
      autoRecovery: {
        enabled: true,
        intervalValue: 1,
        intervalUnit: 'minute'
      }
    });

    await service.recordSiteFailure(
      autoDisabled.id,
      { statusCode: 500, message: 'failed' },
      new Date('2026-06-03T08:00:00.000Z')
    );
    await service.setSiteEnabled(
      manualDisabled.id,
      false,
      new Date('2026-06-03T08:00:00.000Z')
    );

    const dueSites = service.getDueDisabledAutoRecoverySites(
      new Date('2026-06-03T08:01:00.000Z')
    );

    assert.deepEqual(dueSites.map((site) => site.id), [autoDisabled.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loads with default state and quarantines an invalid config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-invalid-json-'));
  const filePath = join(dir, 'config.json');

  try {
    await writeFile(filePath, '{ invalid json', 'utf8');

    const service = new ConfigService({ filePath });
    await service.load();

    const files = await readdir(dir);
    assert.equal(service.getState().sites.length, 0);
    assert.equal(service.getState().proxy.port, 8787);
    assert.equal(files.some((file) => file.startsWith('config.json.invalid-')), true);

    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(persisted.sites, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defers hot request persistence until flush while keeping in-memory state current', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-deferred-save-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath, saveDelayMs: 60_000 });
    await service.load();
    const site = await service.addSite({
      name: 'primary',
      baseUrl: 'https://primary.example/v1',
      apiKey: 'sk-primary'
    });
    const before = JSON.parse(await readFile(filePath, 'utf8'));

    await service.selectSiteForRequest(new Date('2026-06-03T08:00:00.000Z'));
    await service.recordSiteSuccess(site.id, { statusCode: 200 }, new Date('2026-06-03T08:00:01.000Z'));

    const inMemory = service.getState().sites.find((candidate) => candidate.id === site.id);
    const onDiskBeforeFlush = JSON.parse(await readFile(filePath, 'utf8'))
      .sites.find((candidate) => candidate.id === site.id);

    assert.equal(inMemory.requestCount, 1);
    assert.equal(inMemory.successCount, 1);
    assert.equal(onDiskBeforeFlush.requestCount, before.sites[0].requestCount);

    await service.flush();

    const onDiskAfterFlush = JSON.parse(await readFile(filePath, 'utf8'))
      .sites.find((candidate) => candidate.id === site.id);
    assert.equal(onDiskAfterFlush.requestCount, 1);
    assert.equal(onDiskAfterFlush.successCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('truncates persisted error log details to keep state payload bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-trim-error-log-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath, saveDelayMs: 60_000 });
    await service.load();
    const site = await service.addSite({
      name: 'bad',
      baseUrl: 'https://bad.example/v1',
      apiKey: 'sk-bad'
    });

    for (let index = 0; index < 25; index += 1) {
      await service.recordSiteFailure(site.id, {
        statusCode: 500,
        message: `failed ${index}`,
        detail: 'x'.repeat(5000)
      });
    }

    await service.flush();

    const saved = JSON.parse(await readFile(filePath, 'utf8'))
      .sites.find((candidate) => candidate.id === site.id);
    assert.equal(saved.errorLog.length <= 20, true);
    assert.equal(saved.errorLog.every((entry) => entry.detail.length <= 1000), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
