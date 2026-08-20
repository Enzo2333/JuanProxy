import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('Electron UI and background task entries wire the Feishu watchdog end to end', async () => {
  const [main, preload, html, renderer, installer, watchdog, remoteInstaller, releaseWorkflow] = await Promise.all([
    read('../src/main.js'),
    read('../src/preload.js'),
    read('../src/renderer/index.html'),
    read('../src/renderer/app.js'),
    read('../scripts/install-feishu-watchdog.ps1'),
    read('../scripts/feishu-watchdog.js'),
    read('../scripts/install-remote-codex-monitor.ps1'),
    read('../.github/workflows/release-remote-monitor.yml')
  ]);

  assert.match(main, /handleLogged\('monitoring:update'/);
  assert.match(main, /handleLogged\('monitoring:update-rule'/);
  assert.match(main, /handleLogged\('monitoring:test'/);
  assert.match(main, /handleLogged\('monitoring-task:install'/);
  assert.match(main, /handleLogged\('monitoring-task:remove'/);
  assert.match(main, /handleLogged\('remote-monitoring:open-download'/);
  assert.match(main, /releases\/latest/);
  assert.match(preload, /ipcRenderer\.invoke\('monitoring:update'/);
  assert.match(preload, /ipcRenderer\.invoke\('monitoring:update-rule'/);
  assert.match(preload, /ipcRenderer\.invoke\('monitoring:test'/);
  assert.match(preload, /ipcRenderer\.invoke\('monitoring-task:install'/);
  assert.match(preload, /ipcRenderer\.invoke\('monitoring-task:remove'/);
  assert.match(preload, /ipcRenderer\.invoke\('remote-monitoring:open-download'/);
  assert.match(html, /id="monitoring-enabled"/);
  assert.match(html, /id="monitoring-multiplier-changed"/);
  assert.match(html, /id="monitoring-low-balance"/);
  assert.match(html, /id="monitoring-no-usable-site"/);
  assert.match(html, /id="monitoring-program-issues"/);
  assert.match(html, /id="monitoring-answer-completed"/);
  assert.match(html, /id="monitoring-goal-status-changed"/);
  assert.match(html, /id="monitoring-remote-completion"/);
  assert.match(html, /id="no-usable-site-delay-minutes"/);
  assert.match(html, /id="site-monitoring-enabled"/);
  assert.match(html, /id="install-monitoring-task"/);
  assert.match(html, /id="remove-monitoring-task"/);
  assert.match(html, /id="open-remote-monitor-download"/);
  assert.match(renderer, /api\.updateMonitoringSettings\(/);
  assert.match(renderer, /api\.updateMonitoringRule\(/);
  assert.match(renderer, /api\.testFeishuWebhook\(/);
  assert.match(renderer, /api\.installMonitoringTask\(/);
  assert.match(renderer, /api\.removeMonitoringTask\(/);
  assert.match(installer, /JuanProxy Feishu Watchdog/);
  assert.match(installer, /feishu-watchdog\.js/);
  assert.match(installer, /-MultipleInstances IgnoreNew/);
  assert.match(watchdog, /sessionsDir/);
  assert.match(remoteInstaller, /JuanProxy Remote Codex Monitor/);
  assert.match(remoteInstaller, /task_complete/);
  assert.match(remoteInstaller, /thread_goal_updated/);
  assert.match(remoteInstaller, /remote-codex-events/);
  assert.match(releaseWorkflow, /GOOS=windows GOARCH=amd64/);
  assert.match(releaseWorkflow, /GOOS=darwin GOARCH=arm64/);
  assert.match(releaseWorkflow, /GOOS=darwin GOARCH=amd64/);
  assert.match(releaseWorkflow, /softprops\/action-gh-release/);
});
