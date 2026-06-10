import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ConfigService } from '../src/proxy/config-service.js';
import { OpenApiProxyServer } from '../src/proxy/proxy-server.js';
import { startProxyWithFallback } from '../src/proxy/start-proxy-with-fallback.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('keeps configured port and starts after killing the process that occupies it', async () => {
  const blocker = http.createServer((_req, res) => res.end('busy'));
  const blockedPort = await listen(blocker);
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-fallback-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });
  const releasedPorts = [];

  try {
    await config.load();
    await config.updateProxySettings({ port: blockedPort });

    const result = await startProxyWithFallback({
      proxyServer: proxy,
      configService: config,
      releasePort: async (port) => {
        releasedPorts.push(port);
        await new Promise((resolve) => blocker.close(resolve));
        return [{ pid: 1234, name: 'blocker', killed: true }];
      },
      logger: { warn() {}, error() {} }
    });

    assert.equal(result.usedFallback, false);
    assert.equal(result.actualPort, blockedPort);
    assert.equal(config.getState().proxy.port, blockedPort);
    assert.deepEqual(releasedPorts, [blockedPort]);

    const response = await fetch(`http://127.0.0.1:${blockedPort}/__proxy/health`);
    assert.equal(response.status, 200);
  } finally {
    await proxy.stop();
    if (blocker.listening) {
      await new Promise((resolve) => blocker.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps configured port and reports an error when occupied port cannot be released', async () => {
  const blocker = http.createServer((_req, res) => res.end('busy'));
  const blockedPort = await listen(blocker);
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-fallback-error-'));
  const config = new ConfigService({ filePath: join(dir, 'config.json') });
  const proxy = new OpenApiProxyServer({ configService: config });

  try {
    await config.load();
    await config.updateProxySettings({ port: blockedPort });

    await assert.rejects(
      startProxyWithFallback({
        proxyServer: proxy,
        configService: config,
        releasePort: async () => [{ pid: 1234, name: 'blocker', killed: false, error: 'denied' }],
        logger: { warn() {}, error() {} }
      }),
      /Proxy port .* is still unavailable/
    );

    assert.equal(proxy.getStatus().running, false);
    assert.equal(proxy.getStatus().port, null);
    assert.equal(config.getState().proxy.port, blockedPort);
  } finally {
    await proxy.stop();
    await new Promise((resolve) => blocker.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
