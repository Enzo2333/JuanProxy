import { homedir } from 'node:os';
import { join } from 'node:path';

import { runWatchdogCheck } from '../src/monitoring/feishu-watchdog.js';

const appDataPath = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const userDataPath = join(appDataPath, 'JuanProxy');
const configPath = process.env.JUANPROXY_CONFIG_PATH || join(userDataPath, 'config.json');
const statePath = process.env.JUANPROXY_WATCHDOG_STATE_PATH ||
  join(userDataPath, 'feishu-watchdog-state.json');
const codexHomePath = process.env.CODEX_HOME || join(homedir(), '.codex');
const sessionsDir = join(codexHomePath, 'sessions');
const remoteEventsDir = process.env.JUANPROXY_REMOTE_EVENTS_DIR ||
  join(userDataPath, 'remote-codex-events');

while (true) {
  let intervalMs = 30_000;
  try {
    const result = await runWatchdogCheck({ configPath, statePath, sessionsDir, remoteEventsDir });
    intervalMs = result.intervalMs;
  } catch (error) {
    console.error(`[feishu-watchdog] ${error?.message ?? error}`);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
