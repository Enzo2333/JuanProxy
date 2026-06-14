import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function createUpstream(handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer client-key'
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
        Authorization: 'Bearer client-key',
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
    await config.load();
    await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-proxy' });
    const port = await proxy.start(0);

    const { response, text } = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      messages: [{ role: 'user', content: 'hello' }]
    });

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
    await config.load();
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
    await config.load();
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
    await config.load();
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

  try {
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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
    await config.load();
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
    await config.load();
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
    await config.load();
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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

test('retries and disables sites for upstream HTTP errors', async () => {
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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

test('retries and disables sites for upstream feature permission errors', async () => {
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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
    assert.equal(updatedFirst.failureDisabled, true);
    assert.equal(updatedFirst.enabled, false);
    assert.equal(updatedFirst.consecutiveErrors, 1);
    assert.equal(updatedFirst.errorCount, 1);
    assert.equal(updatedFirst.lastError.statusCode, 403);
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
    await config.load();
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
    await config.addSite({ name: 'bad', baseUrl: bad.baseUrl, apiKey: 'sk-bad', priority: 1 });
    await config.addSite({ name: 'good', baseUrl: good.baseUrl, apiKey: 'sk-good', priority: 2 });
    const port = await proxy.start(0);

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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
    await config.load();
    await config.addSite({ name: 'primary', baseUrl: upstream.baseUrl, apiKey: 'sk-primary' });
    const port = await proxy.start(0);

    const clientReq = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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
    await config.load();
    await config.updateProxySettings({ failureThreshold: 0 });
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
    await config.load();
    await config.updateProxySettings({ samePriorityStrategy: 'round-robin' });
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
    await config.load();
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
    await config.load();
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
    await config.load();
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
    await config.load();
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
