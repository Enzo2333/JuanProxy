import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { testSiteAvailability } from '../src/proxy/site-tester.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('tests a site with a responses request compatible with stricter relays', async () => {
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
        body: JSON.parse(body)
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_test' }));
    });
  });
  const port = await listen(server);

  try {
    const result = await testSiteAvailability({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      testModel: 'gpt-test'
    });

    assert.equal(result.ok, true);
    assert.equal(observed.method, 'POST');
    assert.equal(observed.url, '/v1/responses');
    assert.equal(observed.authorization, 'Bearer sk-test');
    assert.equal(observed.body.model, 'gpt-test');
    assert.equal(observed.body.instructions, 'Reply briefly.');
    assert.equal(observed.body.input, 'Hi');
    assert.equal(observed.body.max_output_tokens, 1);
    assert.equal(observed.body.stream, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
