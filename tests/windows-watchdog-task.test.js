import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getWatchdogTaskStatus,
  installWatchdogTask,
  removeWatchdogTask
} from '../src/monitoring/windows-watchdog-task.js';

test('queries, installs, starts, and removes the Windows watchdog task through bundled scripts', async () => {
  const calls = [];
  const runPowerShell = async (options) => {
    calls.push(options);
    if (options.command) {
      return JSON.stringify({
        supported: true,
        installed: true,
        running: true,
        lastRunAt: '2026-08-11T10:00:00+08:00',
        lastTaskResult: 267009
      });
    }
    return '';
  };

  const status = await getWatchdogTaskStatus({ platform: 'win32', runPowerShell });
  assert.equal(status.installed, true);
  assert.equal(status.running, true);

  await installWatchdogTask({
    platform: 'win32',
    projectRoot: 'E:\\JuanProxy',
    runPowerShell
  });
  await removeWatchdogTask({
    platform: 'win32',
    projectRoot: 'E:\\JuanProxy',
    runPowerShell
  });

  assert.match(calls[1].filePath, /scripts[\\/]install-feishu-watchdog\.ps1$/);
  assert.match(calls[2].filePath, /scripts[\\/]uninstall-feishu-watchdog\.ps1$/);
});

test('reports task controls as unsupported outside Windows', async () => {
  const status = await getWatchdogTaskStatus({ platform: 'linux' });
  assert.deepEqual(status, {
    supported: false,
    installed: false,
    running: false,
    lastRunAt: null,
    lastTaskResult: null
  });
});
