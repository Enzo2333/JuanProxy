import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import {
  composeTargetUrl,
  formatUpstreamTimeoutMessage,
  getRequestTimeoutMs,
  OpenApiProxyServer
} from '../src/proxy/proxy-server.js';

const TEST_LOCAL_API_KEY = 'jp-test-client-key-0123456789abcdef';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function loadConfig(config) {
  await config.load();
  await config.generateLocalApiKey(TEST_LOCAL_API_KEY);
}

async function createUpstream(handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function postJson(url, payload, apiKey = TEST_LOCAL_API_KEY, extraHeaders = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  return { response, text };
}

async function postChunkedJson(url, payload) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_LOCAL_API_KEY}`,
        'Transfer-Encoding': 'chunked'
      }
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('end', () => {
        resolve({ response, text });
      });
    });
    req.on('error', reject);

    const body = JSON.stringify(payload);
    const splitAt = Math.max(1, Math.floor(body.length / 2));
    req.write(body.slice(0, splitAt));
    req.end(body.slice(splitAt));
  });
}

async function withTimeout(promise, label, timeoutMs = 500) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(getValue, label, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = getValue();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('requires the local API key and replaces it with the upstream site key', async () => {
  const upstreamRequests = [];
  const upstream = await createUpstream((req, res) => {
    upstreamRequests.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-local-auth-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.addSite({
      name: 'primary',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-real-upstream-key'
    });
    const localApiKey = TEST_LOCAL_API_KEY;
    const port = await proxy.start(0);
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;

    const health = await fetch(`http://127.0.0.1:${port}/__proxy/health`);
    const missing = await postJson(url, {}, null);
    const wrong = await postJson(url, {}, 'wrong-local-key');
    const accepted = await postJson(`${url}?api_key=query-secret&stream=true`, {}, localApiKey, {
      'X-Api-Key': 'header-secret',
      'Api-Key': 'alternate-header-secret',
      Cookie: 'session=client-secret'
    });

    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(missing.response.status, 401);
    assert.equal(wrong.response.status, 401);
    assert.equal(accepted.response.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].url, '/v1/chat/completions?stream=true');
    assert.equal(upstreamRequests[0].headers.authorization, 'Bearer sk-real-upstream-key');
    assert.equal(upstreamRequests[0].headers['x-api-key'], undefined);
    assert.equal(upstreamRequests[0].headers['api-key'], undefined);
    assert.equal(upstreamRequests[0].headers.cookie, undefined);
    assert.equal(config.verifyLocalApiKey(localApiKey), true);
    assert.equal(config.verifyLocalApiKey('wrong-local-key'), false);
    assert.doesNotMatch(JSON.stringify(config.getState()), new RegExp(localApiKey));
    assert.deepEqual(config.getRendererState().proxy.localApiKey, { configured: true });
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('accepts deduplicated remote Codex completion events with the local API key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-remote-codex-events-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });
  try {
    await loadConfig(config);
    await config.updateMonitoringSettings({
      enabled: true,
      notifications: { remoteCompletion: true }
    });
    const port = await proxy.start(0);
    const url = `http://127.0.0.1:${port}/v1/__proxy/remote-codex-events`;
    const payload = {
      source: { id: 'remote-pc', name: 'REMOTE-PC' },
      events: [{
        threadId: 'thread-1',
        turnId: 'turn-1',
        cwd: 'E:\\work',
        completedAt: '2026-08-20T10:00:00.000Z'
      }]
    };

    const unauthorizedProbe = await fetch(url);
    assert.equal(unauthorizedProbe.status, 401);
    const probe = await fetch(url, {
      headers: { Authorization: `Bearer ${TEST_LOCAL_API_KEY}` }
    });
    assert.equal(probe.status, 200);
    assert.deepEqual(await probe.json(), { ok: true, enabled: true });

    const first = await postJson(url, payload);
    const duplicate = await postJson(url, payload);
    assert.equal(first.response.status, 202);
    assert.deepEqual(JSON.parse(first.text), { accepted: 1, duplicates: 0, rejected: 0 });
    assert.deepEqual(JSON.parse(duplicate.text), { accepted: 0, duplicates: 1, rejected: 0 });
    const names = await readdir(join(dir, 'remote-codex-events'));
    assert.equal(names.length, 1);
    const stored = JSON.parse(await readFile(join(dir, 'remote-codex-events', names[0]), 'utf8'));
    assert.equal(stored.key, 'remote:remote-pc:thread-1:turn-1');
    await config.updateMonitoringSettings({ notifications: { remoteCompletion: false } });
    const disabledProbe = await fetch(url, {
      headers: { Authorization: `Bearer ${TEST_LOCAL_API_KEY}` }
    });
    assert.deepEqual(await disabledProbe.json(), { ok: true, enabled: false });
    payload.events[0].turnId = 'turn-2';
    const disabled = await postJson(url, payload);
    assert.deepEqual(JSON.parse(disabled.text), { accepted: 0, ignored: 1 });
    assert.equal((await readdir(join(dir, 'remote-codex-events'))).length, 1);
  } finally {
    await proxy.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('forwards requests to the configured base URL and injects the configured key', async () => {
  let observed = null;
  const upstream = await createUpstream((req, res) => {
    observed = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-server-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    const localApiKey = TEST_LOCAL_API_KEY;
    await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-proxy' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      { messages: [{ role: 'user', content: 'hello' }] },
      localApiKey
    );

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true });
    assert.equal(observed.method, 'POST');
    assert.equal(observed.url, '/v1/chat/completions');
    assert.equal(observed.authorization, 'Bearer sk-proxy');
    assert.equal(config.getState().sites[0].status, 'success');
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('binds to all IPv4 interfaces only when LAN access is enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-lan-bind-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await proxy.start(0);
    assert.equal(proxy.getStatus().host, '127.0.0.1');

    await proxy.stop();
    await config.updateProxySettings({ allowLanAccess: true });
    await proxy.start(0);
    assert.equal(proxy.getStatus().host, '0.0.0.0');
  } finally {
    await proxy.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewrites request model using global model mapping before forwarding', async () => {
  let observedBody = null;
  const upstream = await createUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      observedBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-global-model-mapping-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateModelMapping({
      enabled: true,
      mappings: [{ from: 'gpt-5', to: 'gpt-5-mini' }]
    });
    await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-proxy' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true });
    assert.equal(observedBody.model, 'gpt-5-mini');
    assert.deepEqual(observedBody.messages, [{ role: 'user', content: 'hello' }]);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('prefers per-site model mapping over global model mapping', async () => {
  let observedBody = null;
  const upstream = await createUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      observedBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-model-mapping-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateModelMapping({
      enabled: true,
      mappings: [{ from: 'gpt-5', to: 'global-target' }]
    });
    await config.addSite({
      name: 'primary',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-proxy',
      modelMapping: {
        enabled: true,
        mappings: [{ from: 'gpt-5', to: 'site-target' }]
      }
    });
    const port = await proxy.start(0);

    const { response } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5',
      input: 'hello'
    });

    assert.equal(response.status, 200);
    assert.equal(observedBody.model, 'site-target');
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewrites chunked JSON request models before streaming upstream responses', async () => {
  let observedBody = null;
  let observedHeaders = null;
  const upstream = await createUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      observedHeaders = req.headers;
      observedBody = JSON.parse(raw);
      if (observedBody.model !== 'gpt-5-mini') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'model_not_found' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"chunk-1"}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-chunked-model-mapping-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateModelMapping({
      enabled: true,
      mappings: [{ from: 'gpt-5', to: 'gpt-5-mini' }]
    });
    await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-proxy' });
    const port = await proxy.start(0);

    const payload = {
      model: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }]
    };
    const { response, text } = await postChunkedJson(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      payload
    );

    assert.equal(response.statusCode, 200);
    assert.match(text, /chunk-1/);
    assert.match(text, /\[DONE\]/);
    assert.equal(observedBody.model, 'gpt-5-mini');
    assert.equal(
      observedHeaders['content-length'],
      String(Buffer.byteLength(JSON.stringify({ ...payload, model: 'gpt-5-mini' })))
    );
    assert.equal(observedHeaders['transfer-encoding'], undefined);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('records incomplete responses streams as site health failures', async () => {
  const upstream = await createUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-incomplete-responses-stream-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });
  const retryEvents = [];
  proxy.on('codex-retry-needed', (event) => retryEvents.push(event));

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const site = await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-proxy' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5',
      input: 'hello',
      stream: true
    });

    assert.equal(response.status, 200);
    assert.match(text, /response\.output_text\.delta/);

    const updated = config.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(updated.failureDisabled, true);
    assert.equal(updated.enabled, false);
    assert.equal(updated.consecutiveErrors, 1);
    assert.equal(updated.errorCount, 1);
    assert.equal(updated.lastError.statusCode, null);
    assert.equal(updated.lastError.affectsSiteHealth, true);
    assert.equal(
      updated.lastError.message,
      'stream disconnected before completion: stream closed before response.completed'
    );
    assert.deepEqual(retryEvents, [{
      occurredAt: retryEvents[0].occurredAt,
      method: 'POST',
      path: '/v1/responses',
      replayable: true,
      siteId: site.id,
      reason: 'incomplete-responses-stream'
    }]);
    assert.equal(Number.isNaN(Date.parse(retryEvents[0].occurredAt)), false);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('requests Codex task retry when the final upstream reports selected-model capacity', async () => {
  const upstream = await createUpstream((_req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: 'model_capacity_exceeded',
        message: 'Selected model is at capacity. Please try a different model.'
      }
    }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-model-capacity-retry-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });
  const retryEvents = [];
  proxy.on('codex-retry-needed', (event) => retryEvents.push(event));

  try {
    await loadConfig(config);
    const site = await config.addSite({
      name: 'capacity-limited',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-proxy'
    });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5.6-sol',
      input: 'hello'
    });

    assert.equal(response.status, 429);
    assert.match(text, /Selected model is at capacity/);
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].method, 'POST');
    assert.equal(retryEvents[0].path, '/v1/responses');
    assert.equal(retryEvents[0].replayable, true);
    assert.equal(retryEvents[0].siteId, site.id);
    assert.equal(retryEvents[0].reason, 'model-capacity');
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps completed responses streams as successful site requests', async () => {
  const upstream = await createUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    res.end('data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n');
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-completed-responses-stream-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    const site = await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-proxy' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5',
      input: 'hello',
      stream: true
    });

    assert.equal(response.status, 200);
    assert.match(text, /response\.completed/);

    const updated = config.getState().sites.find((candidate) => candidate.id === site.id);
    assert.equal(updated.status, 'success');
    assert.equal(updated.failureDisabled, false);
    assert.equal(updated.consecutiveErrors, 0);
    assert.equal(updated.successCount, 1);
    assert.equal(updated.errorCount, 0);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('strips trailing v1 from upstream base URL for Codex backend API paths', () => {
  const target = composeTargetUrl(
    'https://upstream.example/v1',
    '/backend-api/codex/responses?stream=true'
  );

  assert.equal(target.href, 'https://upstream.example/backend-api/codex/responses?stream=true');
});

test('replaces the local v1 prefix with the complete upstream base URL path', () => {
  const target = composeTargetUrl(
    'https://upstream.example/codex',
    '/v1/responses?stream=true'
  );

  assert.equal(target.href, 'https://upstream.example/codex/responses?stream=true');
});

test('uses the unified configured timeout for compact requests', () => {
  const timeoutMs = getRequestTimeoutMs(25);

  assert.equal(timeoutMs, 25);
  assert.equal(formatUpstreamTimeoutMessage(timeoutMs), 'Upstream timed out after 50ms');
});

test('times out compact requests using the unified proxy timeout setting', async () => {
  const upstream = await createUpstream((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, 1500);
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-unified-timeout-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ timeoutMs: 1000 });
    await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-proxy' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses/compact`, {
      input: []
    });

    assert.equal(response.status, 502);
    assert.match(text, /Upstream timed out after 1000ms/);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('switches to another enabled site within each request when upstream errors reach the threshold', async () => {
  const bad = await createUpstream((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad upstream' }));
  });
  const good = await createUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'good' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-switch-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ smartSwitching: true });
    const badSite = await config.addSite({
      name: 'bad',
      baseUrl: bad.baseUrl,
      apiKey: 'sk-bad',
      priority: 1
    });
    const goodSite = await config.addSite({
      name: 'good',
      baseUrl: good.baseUrl,
      apiKey: 'sk-good',
      priority: 2
    });
    await config.setActiveSite(badSite.id);
    const port = await proxy.start(0);

    for (let index = 0; index < 3; index += 1) {
      const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'good' });
    }

    const state = config.getState();
    assert.equal(state.activeSiteId, goodSite.id);
    assert.equal(state.sites.find((site) => site.id === badSite.id).failureDisabled, true);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'good' });
  } finally {
    await proxy.stop();
    await bad.close();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns the final upstream error when every usable site fails within a request', async () => {
  const first = await createUpstream((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'first failed' }));
  });
  const second = await createUpstream((_req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'second failed' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-request-failover-all-fail-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 2
    });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});

    assert.equal(response.status, 429);
    assert.deepEqual(JSON.parse(text), { error: 'second failed' });
    assert.equal(config.getState().sites.every((site) => site.failureDisabled), true);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retries rate-limited upstream responses with large replayable request bodies', async () => {
  let firstRequests = 0;
  let secondRequests = 0;
  const first = await createUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      firstRequests += 1;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limited' }));
    });
  });
  const second = await createUpstream((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      secondRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        upstream: 'second',
        bodyLength: body.length
      }));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-rate-limit-large-body-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ smartSwitching: true });
    await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 2
    });
    const port = await proxy.start(0);
    const payload = {
      model: 'gpt-large',
      input: 'x'.repeat(1024 * 1024 + 1)
    };
    const expectedBodyLength = JSON.stringify(payload).length;

    const { response, text } = await postJson(
      `http://127.0.0.1:${port}/v1/responses`,
      payload
    );

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), {
      ok: true,
      upstream: 'second',
      bodyLength: expectedBodyLength
    });
    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 1);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buffers large 429 response bodies long enough to try another site', async () => {
  let secondRequests = 0;
  const firstError = JSON.stringify({ error: 'x'.repeat(512) });
  const first = await createUpstream((_req, res) => {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(firstError)
    });
    res.end(firstError);
  });
  const second = await createUpstream((_req, res) => {
    secondRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'second' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-rate-limit-large-error-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({
    configService: config,
    maxBufferedErrorBodyBytes: 64
  });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ smartSwitching: true });
    await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 2
    });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-test',
      input: 'hello'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'second' });
    assert.equal(secondRequests, 1);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('drains oversized 429 response bodies before trying another site', async () => {
  let secondRequests = 0;
  const firstError = JSON.stringify({ error: 'x'.repeat(512) });
  const first = await createUpstream((_req, res) => {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(firstError)
    });
    res.end(firstError);
  });
  const second = await createUpstream((_req, res) => {
    secondRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'second' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-rate-limit-oversized-error-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({
    configService: config,
    maxBufferedErrorBodyBytes: 64,
    maxBufferedRetryableErrorBodyBytes: 64
  });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ smartSwitching: true });
    await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 2
    });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-test',
      input: 'hello'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'second' });
    assert.equal(secondRequests, 1);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retries a failed upstream response on another site within the same client request', async () => {
  const bad = await createUpstream((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad upstream' }));
  });
  const goodRequests = [];
  const good = await createUpstream((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      goodRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body)
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstream: 'good' }));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-request-failover-http-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const badSite = await config.addSite({
      name: 'bad',
      baseUrl: bad.baseUrl,
      apiKey: 'sk-bad',
      priority: 1
    });
    const goodSite = await config.addSite({
      name: 'good',
      baseUrl: good.baseUrl,
      apiKey: 'sk-good',
      priority: 2
    });
    await config.setActiveSite(badSite.id);
    const port = await proxy.start(0);

    const payload = {
      messages: [{ role: 'user', content: 'hello' }]
    };
    const { response, text } = await postJson(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      payload
    );

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'good' });
    assert.deepEqual(goodRequests, [
      {
        url: '/v1/chat/completions',
        authorization: 'Bearer sk-good',
        body: payload
      }
    ]);

    const state = config.getState();
    assert.equal(state.activeSiteId, goodSite.id);
    assert.equal(state.sites.find((site) => site.id === badSite.id).failureDisabled, true);
    assert.equal(state.sites.find((site) => site.id === goodSite.id).status, 'success');
  } finally {
    await proxy.stop();
    await bad.close();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual selection returns the selected upstream error without switching sites', async () => {
  const bad = await createUpstream((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'manual site failed' }));
  });
  let goodRequests = 0;
  const good = await createUpstream((_req, res) => {
    goodRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'good' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-manual-no-switch-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: false });
    const badSite = await config.addSite({
      name: 'bad',
      baseUrl: bad.baseUrl,
      apiKey: 'sk-bad',
      priority: 1
    });
    await config.addSite({
      name: 'good',
      baseUrl: good.baseUrl,
      apiKey: 'sk-good',
      priority: 2
    });
    await config.setActiveSite(badSite.id);
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(text), { error: 'manual site failed' });
    assert.equal(goodRequests, 0);

    const state = config.getState();
    const updatedBad = state.sites.find((site) => site.id === badSite.id);
    assert.equal(state.activeSiteId, badSite.id);
    assert.equal(updatedBad.failureDisabled, false);
    assert.equal(updatedBad.enabled, true);
    assert.equal(updatedBad.consecutiveErrors, 1);
    assert.equal(updatedBad.errorCount, 1);
  } finally {
    await proxy.stop();
    await bad.close();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retries unavailable-model errors and disables the failing site', async () => {
  let firstRequests = 0;
  let secondRequests = 0;
  const modelError = {
    error: {
      code: 'model_not_found',
      message: 'No available channel for model gpt-5.3-codex under group codex',
      type: 'new_api_error'
    }
  };
  const first = await createUpstream((_req, res) => {
    firstRequests += 1;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(modelError));
  });
  const second = await createUpstream((_req, res) => {
    secondRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'second' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-request-error-no-failover-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const firstSite = await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    const secondSite = await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 2
    });
    await config.setActiveSite(firstSite.id);
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5.3-codex',
      input: 'hello'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'second' });
    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 1);

    const state = config.getState();
    const updatedFirst = state.sites.find((site) => site.id === firstSite.id);
    const updatedSecond = state.sites.find((site) => site.id === secondSite.id);
    assert.equal(updatedFirst.failureDisabled, true);
    assert.equal(updatedFirst.enabled, false);
    assert.equal(updatedFirst.consecutiveErrors, 1);
    assert.equal(updatedFirst.errorCount, 1);
    assert.equal(updatedFirst.lastError.statusCode, 503);
    assert.equal(updatedFirst.lastError.affectsSiteHealth, true);
    assert.equal(updatedSecond.status, 'success');
    assert.equal(state.activeSiteId, secondSite.id);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retries feature permission errors without disabling the site', async () => {
  let firstRequests = 0;
  let secondRequests = 0;
  const imagePermissionError = {
    error: {
      message: 'Image generation is not enabled for this group',
      type: 'permission_error'
    }
  };
  const first = await createUpstream((_req, res) => {
    firstRequests += 1;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(imagePermissionError));
  });
  const second = await createUpstream((_req, res) => {
    secondRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'second' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-feature-permission-no-failover-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const firstSite = await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    const secondSite = await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 2
    });
    await config.setActiveSite(firstSite.id);
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/images/generations`, {
      model: 'gpt-image-2',
      prompt: 'test image'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'second' });
    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 1);

    const state = config.getState();
    const updatedFirst = state.sites.find((site) => site.id === firstSite.id);
    const updatedSecond = state.sites.find((site) => site.id === secondSite.id);
    assert.equal(updatedFirst.failureDisabled, false);
    assert.equal(updatedFirst.enabled, true);
    assert.equal(updatedFirst.consecutiveErrors, 0);
    assert.equal(updatedFirst.errorCount, 1);
    assert.equal(updatedFirst.lastError.statusCode, 403);
    assert.equal(updatedFirst.lastError.affectsSiteHealth, false);
    assert.equal(updatedSecond.status, 'success');
    assert.equal(state.activeSiteId, secondSite.id);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retries sensitive-words errors within one request without changing active site', async () => {
  let firstRequests = 0;
  let secondRequests = 0;
  const sensitiveWordsError = {
    error: {
      code: 'sensitive_words_detected',
      message: 'sensitive_words_detected',
      type: 'new_api_error'
    }
  };
  const first = await createUpstream((_req, res) => {
    firstRequests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sensitiveWordsError));
  });
  const second = await createUpstream((_req, res) => {
    secondRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'second' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-content-error-no-disable-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const firstSite = await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    const secondSite = await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 2
    });
    await config.setActiveSite(firstSite.id);
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5.5',
      input: 'blocked content'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'second' });
    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 1);

    const state = config.getState();
    const updatedFirst = state.sites.find((site) => site.id === firstSite.id);
    const updatedSecond = state.sites.find((site) => site.id === secondSite.id);
    assert.equal(updatedFirst.failureDisabled, false);
    assert.equal(updatedFirst.enabled, true);
    assert.equal(updatedFirst.consecutiveErrors, 0);
    assert.equal(updatedFirst.errorCount, 1);
    assert.equal(updatedFirst.lastError.statusCode, 500);
    assert.equal(updatedFirst.lastError.affectsSiteHealth, false);
    assert.equal(updatedSecond.status, 'success');
    assert.equal(state.activeSiteId, firstSite.id);
    assert.equal(state.proxy.lastSelectedSiteId, firstSite.id);

    const secondTry = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5.5',
      input: 'blocked content again'
    });

    assert.equal(secondTry.response.status, 200);
    assert.equal(firstRequests, 2);
    assert.equal(secondRequests, 2);
    assert.equal(config.getState().activeSiteId, firstSite.id);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('emits a route trace for request-local sensitive-words failover without leaking request data', async () => {
  let firstRequests = 0;
  let secondRequests = 0;
  const sensitiveWordsError = {
    error: {
      code: 'sensitive_words_detected',
      message: 'sensitive_words_detected',
      type: 'new_api_error'
    }
  };
  const first = await createUpstream((_req, res) => {
    firstRequests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sensitiveWordsError));
  });
  const second = await createUpstream((_req, res) => {
    secondRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'second' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-route-trace-sensitive-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });
  const routeTraces = [];
  proxy.on('route-trace', (trace) => routeTraces.push(trace));

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const firstSite = await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first-secret',
      priority: 1
    });
    const secondSite = await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second-secret',
      priority: 2
    });
    await config.setActiveSite(firstSite.id);
    const port = await proxy.start(0);

    const { response, text } = await postJson(
      `http://127.0.0.1:${port}/v1/responses?api_key=client-secret&debug=true`,
      {
        model: 'gpt-5.5',
        input: 'blocked content with body-secret',
        apiKey: 'body-secret'
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'second' });
    assert.equal(firstRequests, 1);
    assert.equal(secondRequests, 1);
    assert.equal(config.getState().activeSiteId, firstSite.id);

    assert.equal(routeTraces.length, 1);
    const [trace] = routeTraces;
    assert.match(trace.id, /^[0-9a-f-]{36}$/);
    assert.equal(trace.method, 'POST');
    assert.equal(trace.path, '/v1/responses');
    assert.deepEqual(trace.queryKeys, ['api_key', 'debug']);
    assert.equal(trace.contentType, 'application/json');
    assert.equal(trace.replayable, true);
    assert.equal(trace.originalModel, 'gpt-5.5');
    assert.equal(trace.forwardedModel, 'gpt-5.5');
    assert.equal(trace.modelMapped, false);
    assert.equal(trace.initialActiveSiteId, firstSite.id);
    assert.equal(trace.finalActiveSiteId, firstSite.id);
    assert.equal(trace.finalSiteId, secondSite.id);
    assert.equal(trace.finalStatusCode, 200);
    assert.equal(trace.outcome, 'success');
    assert.equal(trace.requestLocalFailover, true);
    assert.equal(trace.globalSelectionPreserved, true);
    assert.equal(typeof trace.durationMs, 'number');
    assert.equal(trace.attempts.length, 2);
    assert.deepEqual(
      trace.attempts.map((attempt) => attempt.siteId),
      [firstSite.id, secondSite.id]
    );
    assert.deepEqual(trace.attempts[0], {
      siteId: firstSite.id,
      siteName: 'first',
      ok: false,
      kind: 'upstream-response',
      statusCode: 500,
      classification: {
        retryable: true,
        requestLocalRetry: true,
        affectsSiteHealth: false,
        reason: 'request content was rejected by upstream sensitive-word policy'
      }
    });
    assert.deepEqual(trace.attempts[1], {
      siteId: secondSite.id,
      siteName: 'second',
      ok: true,
      kind: 'upstream-response',
      statusCode: 200,
      classification: null
    });

    const serialized = JSON.stringify(trace);
    assert.doesNotMatch(serialized, /client-secret/);
    assert.doesNotMatch(serialized, /body-secret/);
    assert.doesNotMatch(serialized, /blocked content/);
    assert.doesNotMatch(serialized, /sk-first-secret/);
    assert.doesNotMatch(serialized, /sk-second-secret/);
    assert.doesNotMatch(serialized, /sensitive_words_detected/);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('emits sanitized request diagnostics for upstream errors', async () => {
  const errorPayload = {
    error: {
      message: 'Image generation is not enabled for this group',
      type: 'permission_error'
    }
  };
  const upstream = await createUpstream((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorPayload));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-error-diagnostics-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });
  const completedEvents = [];
  proxy.on('request-complete', (event) => completedEvents.push(event));

  try {
    await loadConfig(config);
    await config.updateModelMapping({
      enabled: true,
      mappings: [{ from: 'client-image-model', to: 'gpt-image-2' }]
    });
    const site = await config.addSite({
      name: 'first',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    await config.setActiveSite(site.id);
    const port = await proxy.start(0);

    const { response } = await postJson(`http://127.0.0.1:${port}/v1/images/generations?api_key=client-secret`, {
      model: 'client-image-model',
      prompt: 'test image',
      apiKey: 'body-secret'
    });

    assert.equal(response.status, 403);
    assert.deepEqual(completedEvents, [
      {
        siteId: site.id,
        statusCode: 403,
        request: {
          id: completedEvents[0].request.id,
          method: 'POST',
          path: '/v1/images/generations',
          queryKeys: ['api_key'],
          contentType: 'application/json',
          replayable: true,
          originalModel: 'client-image-model',
          forwardedModel: 'gpt-image-2',
          modelMapped: true
        }
      }
    ]);
    assert.match(completedEvents[0].request.id, /^[0-9a-f-]{36}$/);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not replay oversized request bodies to another site', async () => {
  let badRequests = 0;
  let goodRequests = 0;
  const bad = await createUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      badRequests += 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'large body failed' }));
    });
  });
  const good = await createUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      goodRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-large-body-no-replay-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({
    configService: config,
    maxReplayableRequestBodyBytes: 8
  });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    await config.addSite({ name: 'bad', baseUrl: bad.baseUrl, apiKey: 'sk-bad', priority: 1 });
    await config.addSite({ name: 'good', baseUrl: good.baseUrl, apiKey: 'sk-good', priority: 2 });
    const port = await proxy.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_LOCAL_API_KEY}`
      },
      body: JSON.stringify({ input: 'x'.repeat(64) })
    });
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(text), { error: 'large body failed' });
    assert.equal(badRequests, 1);
    assert.equal(goodRequests, 0);
  } finally {
    await proxy.stop();
    await bad.close();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('uses configured replayable request body buffer size for each request', async () => {
  let badRequests = 0;
  let goodRequests = 0;
  const bad = await createUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      badRequests += 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'configured buffer too small' }));
    });
  });
  const good = await createUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      goodRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-configured-body-buffer-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({
      failureThreshold: 0,
      smartSwitching: true,
      maxReplayableRequestBodyBytes: 1024 * 1024
    });
    await config.addSite({ name: 'bad', baseUrl: bad.baseUrl, apiKey: 'sk-bad', priority: 1 });
    await config.addSite({ name: 'good', baseUrl: good.baseUrl, apiKey: 'sk-good', priority: 2 });
    const port = await proxy.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_LOCAL_API_KEY}`
      },
      body: JSON.stringify({ input: 'x'.repeat(1024 * 1024 + 1) })
    });
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(text), { error: 'configured buffer too small' });
    assert.equal(badRequests, 1);
    assert.equal(goodRequests, 0);
  } finally {
    await proxy.stop();
    await bad.close();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streams oversized upstream error responses instead of buffering them for failover', async () => {
  let goodRequests = 0;
  const errorBody = JSON.stringify({ error: 'x'.repeat(512) });
  const bad = await createUpstream((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(errorBody);
  });
  const good = await createUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      goodRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-large-error-stream-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({
    configService: config,
    maxBufferedErrorBodyBytes: 64
  });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    await config.addSite({ name: 'bad', baseUrl: bad.baseUrl, apiKey: 'sk-bad', priority: 1 });
    await config.addSite({ name: 'good', baseUrl: good.baseUrl, apiKey: 'sk-good', priority: 2 });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      input: 'small'
    });

    assert.equal(response.status, 500);
    assert.equal(text, errorBody);
    assert.equal(goodRequests, 0);
  } finally {
    await proxy.stop();
    await bad.close();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancels the upstream request when the client disconnects', async () => {
  let upstreamStarted = false;
  let upstreamCompleted = false;
  let releaseStarted;
  let releaseClosed;
  const upstreamStartedPromise = new Promise((resolve) => {
    releaseStarted = resolve;
  });
  const upstreamClosedPromise = new Promise((resolve) => {
    releaseClosed = resolve;
  });
  const upstream = await createUpstream((req, res) => {
    upstreamStarted = true;
    releaseStarted();
    req.resume();
    res.on('close', () => {
      releaseClosed();
    });
    setTimeout(() => {
      if (!res.destroyed) {
        upstreamCompleted = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    }, 1000);
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-client-abort-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-primary' });
    const port = await proxy.start(0);

    const clientReq = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_LOCAL_API_KEY}`
      }
    });
    clientReq.on('error', () => {});
    clientReq.end(JSON.stringify({ input: 'slow' }));

    await withTimeout(upstreamStartedPromise, 'upstream request to start');
    assert.equal(upstreamStarted, true);
    clientReq.destroy();

    await withTimeout(upstreamClosedPromise, 'upstream request to be cancelled', 500);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.equal(upstreamCompleted, false);
    assert.equal(config.getState().sites[0].requestCount, 0);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retries an unreachable upstream on another site within the same client request', async () => {
  const unreachable = http.createServer();
  const unreachablePort = await listen(unreachable);
  await new Promise((resolve) => unreachable.close(resolve));

  const good = await createUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: 'good' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-request-failover-network-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const badSite = await config.addSite({
      name: 'bad',
      baseUrl: `http://127.0.0.1:${unreachablePort}/v1`,
      apiKey: 'sk-bad',
      priority: 1
    });
    const goodSite = await config.addSite({
      name: 'good',
      baseUrl: good.baseUrl,
      apiKey: 'sk-good',
      priority: 2
    });
    await config.setActiveSite(badSite.id);
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, upstream: 'good' });

    const state = config.getState();
    assert.equal(state.activeSiteId, goodSite.id);
    assert.equal(state.sites.find((site) => site.id === badSite.id).failureDisabled, true);
  } finally {
    await proxy.stop();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovers automatically disabled sites by testing configs before proxying a request', async () => {
  const bad = await createUpstream((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad key' }));
  });
  const good = await createUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-recover-request-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({ failureThreshold: 0, smartSwitching: true });
    const badSite = await config.addSite({
      name: 'bad',
      baseUrl: bad.baseUrl,
      apiKey: 'sk-bad'
    });
    const goodSite = await config.addSite({
      name: 'good',
      baseUrl: good.baseUrl,
      apiKey: 'sk-good'
    });
    await config.recordSiteFailure(badSite.id, { statusCode: 500, message: 'failed' });
    await config.recordSiteFailure(goodSite.id, { statusCode: 500, message: 'failed' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, path: '/v1/chat/completions' });

    const state = config.getState();
    assert.equal(state.activeSiteId, goodSite.id);
    assert.equal(state.sites.find((site) => site.id === badSite.id).failureDisabled, true);
    assert.equal(state.sites.find((site) => site.id === badSite.id).enabled, false);
    assert.equal(state.sites.find((site) => site.id === goodSite.id).failureDisabled, false);
    assert.equal(state.sites.find((site) => site.id === goodSite.id).enabled, true);
  } finally {
    await proxy.stop();
    await bad.close();
    await good.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('holds a replayable request until an automatically disabled site recovers', async () => {
  const upstream = await createUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, resumed: true }));
  });
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-wait-recovery-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  let siteAvailable = false;
  const proxy = new OpenApiProxyServer({
    configService: config,
    availabilityWaitTimeoutMs: 500,
    availabilityPollIntervalMs: 500,
    siteTester: async () => siteAvailable
      ? { ok: true, statusCode: 200, message: 'recovered' }
      : { ok: false, statusCode: 503, message: 'still unavailable' }
  });

  try {
    await loadConfig(config);
    await config.updateProxySettings({
      codexRecoveryEnabled: true,
      failureThreshold: 0,
      smartSwitching: true
    });
    const site = await config.addSite({
      name: 'recoverable',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-recoverable',
      autoRecovery: { enabled: true, intervalValue: 1, intervalUnit: 'minute' }
    });
    await config.recordSiteFailure(site.id, { statusCode: 503, message: 'offline' });
    const port = await proxy.start(0);

    let settled = false;
    const pending = postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5',
      input: 'continue'
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
    assert.equal(proxy.getStatus().pendingRecoveryRequests, 1);

    siteAvailable = true;
    await config.recordSiteAutoRecoverySuccess(site.id, {
      statusCode: 200,
      message: 'recovered'
    });

    const { response, text } = await withTimeout(pending, 'held proxy request', 500);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, resumed: true });
    assert.equal(proxy.getStatus().pendingRecoveryRequests, 0);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns a stable no-site error and event when recovery waiting times out', async () => {
  const upstream = await createUpstream((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'offline' }));
  });
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-wait-timeout-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({
    configService: config,
    availabilityWaitTimeoutMs: 40,
    availabilityPollIntervalMs: 100,
    siteTester: async () => ({ ok: false, statusCode: 503, message: 'offline' })
  });
  const exhaustedEvents = [];
  proxy.on('availability-exhausted', (event) => exhaustedEvents.push(event));

  try {
    await loadConfig(config);
    await config.updateProxySettings({
      codexRecoveryEnabled: true,
      failureThreshold: 0,
      smartSwitching: true
    });
    const site = await config.addSite({
      name: 'recoverable',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-recoverable',
      autoRecovery: { enabled: true, intervalValue: 1, intervalUnit: 'minute' }
    });
    await config.recordSiteFailure(site.id, { statusCode: 503, message: 'offline' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/responses`, {
      model: 'gpt-5',
      input: 'continue'
    });

    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(text), {
      error: {
        code: 'juanproxy_no_available_site',
        message: 'No active API site configuration is available'
      }
    });
    assert.equal(exhaustedEvents.length, 1);
    assert.equal(exhaustedEvents[0].path, '/v1/responses');
    assert.equal(exhaustedEvents[0].replayable, true);
    assert.equal(exhaustedEvents[0].reason, 'timeout');
    assert.equal(exhaustedEvents[0].requestBody, undefined);
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('round-robins same-priority sites while proxying requests', async () => {
  const seen = [];
  const first = await createUpstream((_req, res) => {
    seen.push('first');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upstream: 'first' }));
  });
  const second = await createUpstream((_req, res) => {
    seen.push('second');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ upstream: 'second' }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-round-robin-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await loadConfig(config);
    await config.updateProxySettings({
      smartSwitching: true,
      samePriorityStrategy: 'round-robin'
    });
    await config.addSite({
      name: 'first',
      baseUrl: first.baseUrl,
      apiKey: 'sk-first',
      priority: 1
    });
    await config.addSite({
      name: 'second',
      baseUrl: second.baseUrl,
      apiKey: 'sk-second',
      priority: 1
    });
    const port = await proxy.start(0);

    await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});
    await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});

    assert.deepEqual(seen, ['first', 'second']);
  } finally {
    await proxy.stop();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('preheats likely site sync in the background while forwarding requests', async () => {
  const upstream = await createUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-site-sync-background-preheat-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  let releasePreheater;
  let preheaterArgs = null;
  const preheaterStarted = new Promise((resolve) => {
    releasePreheater = resolve;
  });
  const proxy = new OpenApiProxyServer({
    configService: config,
    siteSyncPreheater: async (args) => {
      preheaterArgs = args;
      await preheaterStarted;
      return { checkedSites: [], syncedSites: [], failedSites: [] };
    }
  });

  try {
    await loadConfig(config);
    await config.updateSiteSyncSettings({
      intervalValue: 30,
      intervalUnit: 'minute',
      intelligentScheduling: true
    });
    await config.addSite({
      name: 'primary',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-primary',
      sync: {
        enabled: true,
        dashboardUrl: 'https://relay.example.com/console/token',
        username: 'user@example.com',
        password: 'secret',
        intervalMode: 'global',
        lastSyncAt: '2026-06-09T08:05:00.000Z'
      }
    });
    const port = await proxy.start(0);

    const request = postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});
    await waitFor(() => preheaterArgs, 'site sync preheater to start');
    const { response, text } = await withTimeout(request, 'proxy request to finish');

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true });
    assert.equal(preheaterArgs.configService, config);
    releasePreheater();
  } finally {
    releasePreheater?.();
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not recover rate-limited sites during concurrent proxy requests', async () => {
  let upstreamRequests = 0;
  let availabilityTests = 0;
  const upstream = await createUpstream((_req, res) => {
    upstreamRequests += 1;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, 20);
  });

  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-rate-limit-concurrent-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({
    configService: config,
    siteTester: async () => {
      availabilityTests += 1;
      return { ok: true, statusCode: 200, message: 'ok' };
    }
  });

  try {
    await loadConfig(config);
    await config.addSite({
      name: 'limited',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-limited',
      rateLimit: {
        enabled: true,
        limit: 1,
        windowValue: 1,
        windowUnit: 'minute'
      }
    });
    const port = await proxy.start(0);

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {})
      )
    );

    assert.equal(upstreamRequests, 1);
    assert.equal(availabilityTests, 0);
    assert.deepEqual(
      responses.map(({ response }) => response.status).sort(),
      [200, 503, 503]
    );
  } finally {
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not emit an unhandled rejection when a proxied site is deleted before completion', async () => {
  const upstream = await createUpstream((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, 50);
  });
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-delete-during-request-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };

  process.on('unhandledRejection', onUnhandled);
  try {
    await loadConfig(config);
    const site = await config.addSite({
      name: 'primary',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-proxy'
    });
    const port = await proxy.start(0);

    const pending = postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await config.deleteSite(site.id);

    const { response, text } = await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true });
    assert.deepEqual(unhandled.map((reason) => reason?.message ?? String(reason)), []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await proxy.stop();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('serializes concurrent starts so stop closes the only listening proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-concurrent-start-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  async function health(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__proxy/health`, {
        signal: AbortSignal.timeout(500)
      });
      return response.status;
    } catch {
      return null;
    }
  }

  try {
    await loadConfig(config);
    const ports = await Promise.all([proxy.start(0), proxy.start(0)]);
    const reachableBeforeStop = await Promise.all(ports.map((port) => health(port)));

    await proxy.stop();
    const reachableAfterStop = await Promise.all(ports.map((port) => health(port)));

    assert.equal(new Set(ports).size, 1);
    assert.deepEqual(reachableBeforeStop, [200, 200]);
    assert.deepEqual(reachableAfterStop, [null, null]);
  } finally {
    await proxy.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
