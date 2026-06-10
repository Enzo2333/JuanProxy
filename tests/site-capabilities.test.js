import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  detectSiteCapabilities,
  inferModelFeatures
} from '../src/proxy/site-capabilities.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('detects site models from the configured API key without making generation requests', async () => {
  const observedRequests = [];
  const server = http.createServer((req, res) => {
    observedRequests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'gpt-5-mini' },
        { id: 'dall-e-3' },
        { id: 'text-embedding-3-small' },
        { id: 'whisper-1' }
      ]
    }));
  });
  const port = await listen(server);

  try {
    const result = await detectSiteCapabilities({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-capability'
    });

    assert.equal(result.ok, true);
    assert.equal(observedRequests.length, 1);
    assert.equal(observedRequests[0].method, 'GET');
    assert.equal(observedRequests[0].url, '/v1/models');
    assert.equal(observedRequests[0].authorization, 'Bearer sk-capability');
    assert.deepEqual(result.capabilities.models, [
      'dall-e-3',
      'gpt-5-mini',
      'text-embedding-3-small',
      'whisper-1'
    ]);
    assert.equal(result.capabilities.features.textGeneration, true);
    assert.equal(result.capabilities.features.imageGeneration, true);
    assert.equal(result.capabilities.features.embeddings, true);
    assert.equal(result.capabilities.features.audioTranscription, true);
    assert.equal(result.capabilities.features.audioSpeech, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('returns a bounded failure result when the models endpoint rejects the key', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  const port = await listen(server);

  try {
    const result = await detectSiteCapabilities({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-bad'
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
    assert.match(result.message, /HTTP 401/);
    assert.equal(result.capabilities.lastStatus, 'failure');
    assert.equal(result.capabilities.models.length, 0);
    assert.match(result.capabilities.lastError, /bad key/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('infers feature support from common model families and metadata', () => {
  const features = inferModelFeatures([
    { id: 'gpt-image-1' },
    { id: 'bge-m3' },
    { id: 'gpt-4o-mini-tts' },
    { id: 'o3-mini' },
    { id: 'custom-chat', capabilities: { vision: true, function_calling: true } }
  ]);

  assert.equal(features.textGeneration, true);
  assert.equal(features.imageGeneration, true);
  assert.equal(features.embeddings, true);
  assert.equal(features.audioSpeech, true);
  assert.equal(features.vision, true);
  assert.equal(features.reasoning, true);
  assert.equal(features.toolCalling, true);
});
