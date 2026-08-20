import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mainPath = fileURLToPath(new URL('../src/main.js', import.meta.url));

test('main process wires Codex recovery triggers, state, and shutdown', async () => {
  const source = await readFile(mainPath, 'utf8');

  assert.match(source, /new CodexRecoveryCoordinator\(/);
  assert.match(source, /proxyServer\.on\('availability-exhausted'/);
  assert.match(source, /proxyServer\.on\('codex-retry-needed'/);
  assert.match(source, /proxyServer\.on\('sites-recovered'/);
  assert.match(source, /autoRecoveryScheduler\.on\('sites-recovered'/);
  assert.match(source, /await codexRecoveryCoordinator\.start\(\)/);
  assert.match(source, /codexRecoveryStatus: codexRecoveryCoordinator\?\.getStatus\(\) \?\? null/);
  assert.match(source, /await codexRecoveryCoordinator\?\.stop\(\)/);
});

test('main process forwards the exact remote challenge URL to browser verification', async () => {
  const source = await readFile(mainPath, 'utf8');

  assert.match(source, /resolveRemoteBrowserSessionWithWindow\(\{/);
  assert.match(source, /challengeUrl:\s*context\?\.challengeUrl/);
});
