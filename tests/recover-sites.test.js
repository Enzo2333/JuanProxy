import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import { recoverAvailableSites } from '../src/proxy/recover-sites.js';

test('enables every passing non-manual site when every usable site is disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-recover-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const first = await config.addSite({
      name: 'first',
      baseUrl: 'https://first.example/v1',
      apiKey: 'sk-first'
    });
    const second = await config.addSite({
      name: 'second',
      baseUrl: 'https://second.example/v1',
      apiKey: 'sk-second'
    });
    const third = await config.addSite({
      name: 'third',
      baseUrl: 'https://third.example/v1',
      apiKey: 'sk-third'
    });
    const manual = await config.addSite({
      name: 'manual',
      baseUrl: 'https://manual.example/v1',
      apiKey: 'sk-manual',
      enabled: false
    });

    for (const site of [first, second, third]) {
      await config.recordSiteFailure(site.id, { statusCode: 500, message: 'failed' });
    }

    const tested = [];
    const result = await recoverAvailableSites({
      configService: config,
      testSite: async (site) => {
        tested.push(site.id);
        return {
          ok: site.id !== first.id,
          statusCode: site.id !== first.id ? 200 : 401,
          message: site.id !== first.id ? 'ok' : 'bad key'
        };
      }
    });

    const state = config.getState();
    const firstState = state.sites.find((site) => site.id === first.id);
    const secondState = state.sites.find((site) => site.id === second.id);
    const thirdState = state.sites.find((site) => site.id === third.id);
    const manualState = state.sites.find((site) => site.id === manual.id);

    assert.deepEqual(tested, [first.id, second.id, third.id]);
    assert.deepEqual(result.enabledSites.map((site) => site.id), [second.id, third.id]);
    assert.equal(firstState.manualEnabled, true);
    assert.equal(firstState.failureDisabled, true);
    assert.equal(firstState.enabled, false);
    assert.equal(secondState.failureDisabled, false);
    assert.equal(secondState.enabled, true);
    assert.equal(thirdState.failureDisabled, false);
    assert.equal(thirdState.enabled, true);
    assert.equal(manualState.manualEnabled, false);
    assert.equal(manualState.enabled, false);
    assert.equal(secondState.status, 'success');
    assert.equal(thirdState.status, 'success');
    assert.equal(state.activeSiteId, second.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps request-scoped availability test HTTP errors out of health failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-recover-request-error-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const site = await config.addSite({
      name: 'target',
      baseUrl: 'https://target.example/v1',
      apiKey: 'sk-target'
    });
    await config.recordSiteFailure(site.id, { statusCode: 500, message: 'network failed' });

    const before = config.getState().sites.find((candidate) => candidate.id === site.id);
    const result = await recoverAvailableSites({
      configService: config,
      testSite: async () => ({
        ok: false,
        statusCode: 400,
        message: 'Availability test failed HTTP 400',
        detail: JSON.stringify({
          error: {
            code: 'invalid_responses_request',
            message: 'invalid codex request'
          }
        })
      })
    });

    const after = config.getState().sites.find((candidate) => candidate.id === site.id);

    assert.deepEqual(result.enabledSites, []);
    assert.deepEqual(result.failedSites.map((failedSite) => failedSite.id), [site.id]);
    assert.equal(after.failureDisabled, true);
    assert.equal(after.consecutiveErrors, before.consecutiveErrors);
    assert.equal(after.errorCount, before.errorCount);
    assert.equal(after.lastError.statusCode, 400);
    assert.equal(after.lastError.affectsSiteHealth, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
