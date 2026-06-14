import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import { testConfiguredSite } from '../src/proxy/site-actions.js';

test('manual test recovers and activates a passing automatically disabled site', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-manual-test-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
    const site = await config.addSite({
      name: 'target',
      baseUrl: 'https://target.example/v1',
      apiKey: 'sk-target'
    });
    await config.recordSiteFailure(site.id, { statusCode: 500, message: 'failed' });

    const result = await testConfiguredSite({
      configService: config,
      siteId: site.id,
      testSite: async () => ({ ok: true, statusCode: 200, message: 'ok' })
    });

    const state = config.getState();
    const updated = state.sites.find((candidate) => candidate.id === site.id);

    assert.equal(result.ok, true);
    assert.equal(updated.manualEnabled, true);
    assert.equal(updated.failureDisabled, false);
    assert.equal(updated.enabled, true);
    assert.equal(updated.status, 'success');
    assert.equal(state.activeSiteId, site.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual test success does not enable a manually disabled site', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-manual-test-disabled-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    const site = await config.addSite({
      name: 'target',
      baseUrl: 'https://target.example/v1',
      apiKey: 'sk-target',
      enabled: false
    });

    const result = await testConfiguredSite({
      configService: config,
      siteId: site.id,
      testSite: async () => ({ ok: true, statusCode: 200, message: 'ok' })
    });

    const state = config.getState();
    const updated = state.sites.find((candidate) => candidate.id === site.id);

    assert.equal(result.ok, true);
    assert.equal(updated.manualEnabled, false);
    assert.equal(updated.enabled, false);
    assert.equal(updated.status, 'success');
    assert.equal(state.activeSiteId, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual test records a failing site without enabling it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-manual-fail-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    const site = await config.addSite({
      name: 'target',
      baseUrl: 'https://target.example/v1',
      apiKey: 'sk-target',
      enabled: false
    });

    const result = await testConfiguredSite({
      configService: config,
      siteId: site.id,
      testSite: async () => ({ ok: false, statusCode: 401, message: 'bad key', detail: 'nope' })
    });

    const updated = config.getState().sites.find((candidate) => candidate.id === site.id);

    assert.equal(result.ok, false);
    assert.equal(updated.enabled, false);
    assert.equal(updated.status, 'error');
    assert.equal(updated.errorLog[0].message, 'bad key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual test disables an enabled site for HTTP failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-manual-test-http-failure-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
    const site = await config.addSite({
      name: 'target',
      baseUrl: 'https://target.example/v1',
      apiKey: 'sk-target'
    });

    const result = await testConfiguredSite({
      configService: config,
      siteId: site.id,
      testSite: async () => ({
        ok: false,
        statusCode: 400,
        message: 'Availability test failed HTTP 400',
        detail: JSON.stringify({
          error: {
            message: 'Instructions are required',
            type: 'invalid_request_error'
          }
        })
      })
    });

    const updated = config.getState().sites.find((candidate) => candidate.id === site.id);

    assert.equal(result.ok, false);
    assert.equal(updated.manualEnabled, true);
    assert.equal(updated.failureDisabled, true);
    assert.equal(updated.enabled, false);
    assert.equal(updated.consecutiveErrors, 1);
    assert.equal(updated.errorCount, 1);
    assert.equal(updated.lastError.statusCode, 400);
    assert.equal(updated.lastError.affectsSiteHealth, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
