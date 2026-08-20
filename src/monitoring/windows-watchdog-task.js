import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const TASK_NAME = 'JuanProxy Feishu Watchdog';
const UNSUPPORTED_STATUS = {
  supported: false,
  installed: false,
  running: false,
  lastRunAt: null,
  lastTaskResult: null
};

export async function getWatchdogTaskStatus({
  platform = process.platform,
  runPowerShell = defaultRunPowerShell
} = {}) {
  if (platform !== 'win32') {
    return { ...UNSUPPORTED_STATUS };
  }
  const output = await runPowerShell({ command: buildStatusCommand() });
  const status = JSON.parse(String(output).trim());
  return {
    supported: true,
    installed: Boolean(status.installed),
    running: Boolean(status.running),
    lastRunAt: status.lastRunAt || null,
    lastTaskResult: status.lastTaskResult ?? null
  };
}

export async function installWatchdogTask({
  platform = process.platform,
  projectRoot,
  runPowerShell = defaultRunPowerShell
} = {}) {
  requireWindows(platform);
  await runPowerShell({
    filePath: join(projectRoot, 'scripts', 'install-feishu-watchdog.ps1')
  });
}

export async function removeWatchdogTask({
  platform = process.platform,
  projectRoot,
  runPowerShell = defaultRunPowerShell
} = {}) {
  requireWindows(platform);
  await runPowerShell({
    filePath: join(projectRoot, 'scripts', 'uninstall-feishu-watchdog.ps1')
  });
}

async function defaultRunPowerShell({ command, filePath }) {
  const args = filePath
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filePath]
    : ['-NoProfile', '-Command', command];
  const { stdout } = await execFileAsync('powershell.exe', args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

function buildStatusCommand() {
  return [
    `$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
    'if (-not $task) {',
    "  [pscustomobject]@{ installed = $false; running = $false; lastRunAt = $null; lastTaskResult = $null } | ConvertTo-Json -Compress",
    '  exit',
    '}',
    `$info = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}'`,
    '$lastRunAt = if ($info.LastRunTime -gt [DateTime]::MinValue) { $info.LastRunTime.ToString("o") } else { $null }',
    '[pscustomobject]@{',
    '  installed = $true',
    "  running = $task.State -eq 'Running'",
    '  lastRunAt = $lastRunAt',
    '  lastTaskResult = [int64]$info.LastTaskResult',
    '} | ConvertTo-Json -Compress'
  ].join('\n');
}

function requireWindows(platform) {
  if (platform !== 'win32') {
    throw new Error('Feishu Watchdog background task requires Windows');
  }
}
