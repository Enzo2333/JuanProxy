import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import { SiteSyncScheduler, syncDueSites } from '../src/proxy/site-sync-scheduler.js';

test('syncDueSites syncs only due configured remote sync sites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-run-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
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

    const calls = [];
    const result = await syncDueSites({
      configService: service,
      now: new Date('2026-06-09T08:30:00.000Z'),
      syncSite: async ({ siteId }) => {
        calls.push(siteId);
        return {
          ok: true,
          multiplier: 0.003
        };
      }
    });

    assert.deepEqual(calls, [due.id]);
    assert.deepEqual(result.checkedSites.map((site) => site.id), [due.id]);
    assert.deepEqual(result.syncedSites.map((site) => site.id), [due.id]);
    assert.equal(result.failedSites.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncDueSites preheats likely request candidates before their full interval expires', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-preheat-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateSiteSyncSettings({
      intervalValue: 30,
      intervalUnit: 'minute',
      intelligentScheduling: true
    });
    const likely = await service.addSite({
      name: 'likely',
      baseUrl: 'https://likely.example/v1',
      apiKey: 'sk-likely',
      priority: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'likely@example.com',
        password: 'secret',
        intervalMode: 'global',
        lastSyncAt: '2026-06-09T08:05:00.000Z'
      }
    });
    await service.addSite({
      name: 'later',
      baseUrl: 'https://later.example/v1',
      apiKey: 'sk-later',
      priority: 2,
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync-one.example.com/profile',
        username: 'later@example.com',
        password: 'secret',
        intervalMode: 'global',
        lastSyncAt: '2026-06-09T08:05:00.000Z'
      }
    });

    const calls = [];
    const result = await syncDueSites({
      configService: service,
      now: new Date('2026-06-09T08:31:00.000Z'),
      preheatCandidateLimit: 1,
      syncSite: async ({ siteId }) => {
        calls.push(siteId);
        return { ok: true };
      }
    });

    assert.deepEqual(calls, [likely.id]);
    assert.deepEqual(result.checkedSites.map((site) => site.id), [likely.id]);
    assert.deepEqual(result.syncedSites.map((site) => site.id), [likely.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncDueSites uses the active priority mode when preheating likely candidates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-preheat-mode-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateProxySettings({ priorityMode: 'multiplier' });
    await service.updateSiteSyncSettings({
      intervalValue: 30,
      intervalUnit: 'minute',
      intelligentScheduling: true
    });
    await service.addSite({
      name: 'priority-winner',
      baseUrl: 'https://priority-winner.example/v1',
      apiKey: 'sk-priority-winner',
      priority: 1,
      multiplier: 1,
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'priority@example.com',
        password: 'secret',
        intervalMode: 'global',
        lastSyncAt: '2026-06-09T08:05:00.000Z'
      }
    });
    const multiplierWinner = await service.addSite({
      name: 'multiplier-winner',
      baseUrl: 'https://multiplier-winner.example/v1',
      apiKey: 'sk-multiplier-winner',
      priority: 5,
      multiplier: 0.001,
      sync: {
        enabled: true,
        dashboardUrl: 'https://sync.example.com/keys',
        username: 'multiplier@example.com',
        password: 'secret',
        intervalMode: 'global',
        lastSyncAt: '2026-06-09T08:05:00.000Z'
      }
    });

    const calls = [];
    await syncDueSites({
      configService: service,
      now: new Date('2026-06-09T08:31:00.000Z'),
      preheatCandidateLimit: 1,
      syncSite: async ({ siteId }) => {
        calls.push(siteId);
        return { ok: true };
      }
    });

    assert.deepEqual(calls, [multiplierWinner.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('syncDueSites uses the group refresh interval instead of per-site intervals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-group-sync-interval-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    await service.updateGroupSyncSettings({
      intervalValue: 2,
      intervalUnit: 'hour'
    });
    await service.addSite({
      name: 'group-controlled',
      baseUrl: 'https://group-controlled.example/v1',
      apiKey: 'sk-group-controlled',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        intervalMode: 'custom',
        intervalValue: 30,
        intervalUnit: 'minute',
        lastSyncAt: '2026-06-09T08:00:00.000Z'
      }
    });

    const calls = [];
    const earlyResult = await syncDueSites({
      configService: service,
      now: new Date('2026-06-09T08:30:00.000Z'),
      syncWebsite: async ({ websiteKey }) => {
        calls.push(websiteKey);
        return { ok: true };
      }
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(earlyResult.checkedWebsites, []);

    const dueResult = await syncDueSites({
      configService: service,
      now: new Date('2026-06-09T10:00:00.000Z'),
      syncWebsite: async ({ websiteKey }) => {
        calls.push(websiteKey);
        return { ok: true };
      }
    });

    assert.deepEqual(calls, ['https://relay.example.com']);
    assert.deepEqual(dueResult.checkedWebsites.map((website) => website.key), [
      'https://relay.example.com'
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('site sync scheduler emits synced events and skips overlapping ticks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-scheduler-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await service.load();
    const site = await service.addSite({
      name: 'due',
      baseUrl: 'https://due.example/v1',
      apiKey: 'sk-due',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'sync-user',
        password: 'secret',
        intervalValue: 30,
        intervalUnit: 'minute'
      }
    });

    let releaseSync;
    const calls = [];
    const scheduler = new SiteSyncScheduler({
      configService: service,
      syncSite: async ({ siteId }) => {
        calls.push(siteId);
        await new Promise((resolve) => {
          releaseSync = resolve;
        });
        return { ok: true };
      }
    });
    const events = [];
    scheduler.on('synced', (event) => events.push(event));

    const firstTick = scheduler.tick(new Date('2026-06-09T08:00:00.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(await scheduler.tick(new Date('2026-06-09T08:00:00.000Z')), null);
    releaseSync();
    const firstResult = await firstTick;

    assert.deepEqual(calls, [site.id]);
    assert.deepEqual(firstResult.syncedSites.map((candidate) => candidate.id), [site.id]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].syncedSites.map((candidate) => candidate.id), [site.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
