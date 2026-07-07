import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launcherPath = fileURLToPath(new URL('../JuanProxy.vbs', import.meta.url));

test('vbs launcher starts Electron without showing a console window', async () => {
  const source = await readFile(launcherPath, 'utf8');

  assert.match(source, /node_modules\\electron\\dist\\electron\.exe/);
  assert.doesNotMatch(source, /node_modules\\\.bin\\electron\.cmd/);
});
