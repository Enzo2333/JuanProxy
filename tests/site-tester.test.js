import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  CODEX_DESKTOP_USER_AGENT,
  testSiteAvailability
} from '../src/proxy/site-tester.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('tests a site with list-form Responses input required by stricter relays', async () => {
  let observed = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      observed = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        accept: req.headers.accept,
        userAgent: req.headers['user-agent'],
        body: JSON.parse(body)
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_test' }));
    });
  });
  const port = await listen(server);

  try {
    const result = await testSiteAvailability(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-test'
      },
      { testModel: 'gpt-test' }
    );

    assert.equal(result.ok, true);
    assert.equal(observed.method, 'POST');
    assert.equal(observed.url, '/v1/responses');
    assert.equal(observed.authorization, 'Bearer sk-test');
    assert.equal(observed.accept, 'text/event-stream');
    assert.equal(observed.userAgent, CODEX_DESKTOP_USER_AGENT);
    assert.equal(observed.body.model, 'gpt-test');
    assert.equal(observed.body.instructions, 'Reply briefly.');
    assert.deepEqual(observed.body.input, [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Hi'
          }
        ]
      }
    ]);
    assert.equal(observed.body.max_output_tokens, 1);
    assert.equal(observed.body.stream, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('treats a 2xx Responses stream containing an error event as a failed test', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: error\ndata: {"error":{"message":"channel unavailable"}}\n\n');
  });
  const port = await listen(server);

  try {
    const result = await testSiteAvailability({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test'
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 200);
    assert.match(result.message, /channel unavailable/);
    assert.match(result.detail, /channel unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('treats a 2xx JSON error envelope as a failed availability test', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
  });
  const port = await listen(server);

  try {
    const result = await testSiteAvailability({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test'
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 200);
    assert.match(result.message, /quota exhausted/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
