import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launcherPath = fileURLToPath(new URL('../JuanProxy.vbs', import.meta.url));
const commandLauncherPath = fileURLToPath(new URL('../JuanProxy.cmd', import.meta.url));

test('vbs launcher starts Electron without showing a console window', async () => {
  const source = await readFile(launcherPath, 'utf8');

  assert.match(source, /node_modules\\electron\\dist\\electron\.exe/);
  assert.doesNotMatch(source, /node_modules\\\.bin\\electron\.cmd/);
});

test('double-click launchers stop only this project Electron before starting it', async () => {
  const [vbsSource, commandSource] = await Promise.all([
    readFile(launcherPath, 'utf8'),
    readFile(commandLauncherPath, 'utf8')
  ]);

  assert.match(vbsSource, /Win32_Process WHERE Name = 'electron\.exe'/);
  assert.match(vbsSource, /process\.ExecutablePath/);
  assert.match(vbsSource, /process\.Terminate/);
  assert.ok(vbsSource.indexOf('StopExistingJuanProxy electronExe') < vbsSource.indexOf('shell.Run command'));

  assert.match(commandSource, /Get-CimInstance Win32_Process/);
  assert.match(commandSource, /\.ExecutablePath -ieq \$target/);
  assert.match(commandSource, /Stop-Process -Id \$_\.ProcessId -Force/);
  assert.ok(commandSource.indexOf('call :stop_existing_juanproxy') < commandSource.indexOf('start "JuanProxy"'));
});
