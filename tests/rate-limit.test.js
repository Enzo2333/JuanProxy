import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';

test('persists per-site rate limit settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-rate-persist-'));
  const filePath = join(dir, 'config.json');

  try {
    const service = new ConfigService({ filePath });
    await service.load();
    const site = await service.addSite({
      name: 'limited',
      baseUrl: 'https://limited.example/v1',
      apiKey: 'sk-limited',
      rateLimit: {
        enabled: true,
        limit: 12,
        windowValue: 2,
        windowUnit: 'hour'
      }
    });

    const reloaded = new ConfigService({ filePath });
    await reloaded.load();
    const saved = reloaded.getState().sites.find((candidate) => candidate.id === site.id);

    assert.equal(saved.rateLimit.enabled, true);
    assert.equal(saved.rateLimit.limit, 12);
    assert.equal(saved.rateLimit.windowValue, 2);
    assert.equal(saved.rateLimit.windowUnit, 'hour');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pauses a site after its call limit and restores it in the next window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-rate-window-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  const at = (seconds) => new Date(Date.UTC(2026, 5, 3, 10, 0, seconds));

  try {
    await service.load();
    const limited = await service.addSite({
      name: 'limited',
      baseUrl: 'https://limited.example/v1',
      apiKey: 'sk-limited',
      priority: 1,
      rateLimit: {
        enabled: true,
        limit: 2,
        windowValue: 1,
        windowUnit: 'minute'
      }
    });
    const fallback = await service.addSite({
      name: 'fallback',
      baseUrl: 'https://fallback.example/v1',
      apiKey: 'sk-fallback',
      priority: 2
    });

    assert.equal((await service.selectSiteForRequest(at(0))).id, limited.id);
    assert.equal((await service.selectSiteForRequest(at(10))).id, limited.id);

    let state = service.getState();
    let limitedState = state.sites.find((site) => site.id === limited.id);
    assert.equal(limitedState.rateLimitState.used, 2);
    assert.equal(limitedState.rateLimitState.pausedUntil, '2026-06-03T10:01:00.000Z');

    assert.equal((await service.selectSiteForRequest(at(20))).id, fallback.id);

    assert.equal((await service.selectSiteForRequest(at(61))).id, limited.id);
    state = service.getState();
    limitedState = state.sites.find((site) => site.id === limited.id);
    assert.equal(limitedState.rateLimitState.used, 1);
    assert.equal(limitedState.rateLimitState.pausedUntil, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not select a rate-limited active site while smart switching is off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-rate-active-'));
  const service = new ConfigService({ filePath: join(dir, 'config.json') });
  const at = (seconds) => new Date(Date.UTC(2026, 5, 3, 11, 0, seconds));

  try {
    await service.load();
    await service.updateProxySettings({ smartSwitching: false });
    const limited = await service.addSite({
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
    await service.setActiveSite(limited.id);

    assert.equal((await service.selectSiteForRequest(at(0))).id, limited.id);
    assert.equal(await service.selectSiteForRequest(at(5)), null);
    assert.equal((await service.selectSiteForRequest(at(61))).id, limited.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
