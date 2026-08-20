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
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
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

test('manual test uses the globally configured test model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-global-test-model-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    await config.updateProxySettings({ testModel: 'global-test-model' });
    const site = await config.addSite({
      name: 'target',
      baseUrl: 'https://target.example/v1',
      apiKey: 'sk-target',
      testModel: 'legacy-site-model'
    });
    let receivedOptions = null;

    await testConfiguredSite({
      configService: config,
      siteId: site.id,
      testSite: async (_site, options) => {
        receivedOptions = options;
        return { ok: true, statusCode: 200, message: 'ok' };
      }
    });

    assert.deepEqual(receivedOptions, { testModel: 'global-test-model' });
    assert.equal(config.getState().sites[0].testModel, undefined);
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

test('manual test records request-scoped HTTP failures without disabling an enabled site', async () => {
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
          detail: 'Input must be a list'
        })
      })
    });

    const updated = config.getState().sites.find((candidate) => candidate.id === site.id);

    assert.equal(result.ok, false);
    assert.equal(updated.manualEnabled, true);
    assert.equal(updated.failureDisabled, false);
    assert.equal(updated.enabled, true);
    assert.equal(updated.consecutiveErrors, 0);
    assert.equal(updated.errorCount, 0);
    assert.equal(updated.lastError.statusCode, 400);
    assert.equal(updated.lastError.affectsSiteHealth, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual and automatic availability checks for one site are serialized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-availability-lock-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });

  try {
    await config.load();
    const site = await config.addSite({
      name: 'target',
      baseUrl: 'https://target.example/v1',
      apiKey: 'sk-target'
    });
    await config.recordSiteFailure(site.id, { statusCode: 500, message: 'failed' });

    let releaseFirst;
    const firstStarted = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const calls = [];
    const first = testConfiguredSite({
      configService: config,
      siteId: site.id,
      testSite: async () => {
        calls.push('first');
        await firstStarted;
        return { ok: true, statusCode: 200, message: 'first passed' };
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = testConfiguredSite({
      configService: config,
      siteId: site.id,
      testSite: async () => {
        calls.push('second');
        return { ok: true, statusCode: 200, message: 'second passed' };
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, ['first']);
    releaseFirst();
    await Promise.all([first, second]);

    const updated = config.getState().sites.find((candidate) => candidate.id === site.id);
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(updated.enabled, true);
    assert.equal(updated.failureDisabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
