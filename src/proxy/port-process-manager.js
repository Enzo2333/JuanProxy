import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_RELEASE_TIMEOUT_MS = 3000;
const RELEASE_POLL_INTERVAL_MS = 100;

export async function releasePortOccupants(
  port,
  {
    currentPid = process.pid,
    exemptPids = [],
    killProcess = process.kill,
    listPortOwners = findListeningProcessIds,
    timeoutMs = DEFAULT_RELEASE_TIMEOUT_MS
  } = {}
) {
  const fixedPort = normalizeFixedPort(port);
  const exempt = new Set([currentPid, ...exemptPids].filter((pid) => Number.isInteger(pid)));
  const owners = uniqueProcessIds(await listPortOwners(fixedPort)).filter((pid) => !exempt.has(pid));
  const results = [];

  for (const pid of owners) {
    try {
      killProcess(pid, 'SIGKILL');
      results.push({ pid, killed: true });
    } catch (error) {
      if (error?.code === 'ESRCH') {
        results.push({ pid, killed: true, alreadyExited: true });
      } else {
        results.push({ pid, killed: false, error: error?.message ?? String(error) });
      }
    }
  }

  await waitForPortOwnersToExit(fixedPort, {
    exempt,
    listPortOwners,
    timeoutMs
  });

  return results;
}

export async function findListeningProcessIds(port) {
  const fixedPort = normalizeFixedPort(port);
  if (platform() === 'win32') {
    return findWindowsListeningProcessIds(fixedPort);
  }
  return findUnixListeningProcessIds(fixedPort);
}

export function normalizeFixedPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('proxy port must be an integer between 1 and 65535');
  }
  return value;
}

async function waitForPortOwnersToExit(port, { exempt, listPortOwners, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [];

  do {
    remaining = uniqueProcessIds(await listPortOwners(port)).filter((pid) => !exempt.has(pid));
    if (remaining.length === 0) {
      return;
    }
    await delay(RELEASE_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  throw new Error(`Port ${port} is still occupied by process ${remaining.join(', ')}`);
}

async function findWindowsListeningProcessIds(port) {
  try {
    return parseProcessIdJson(await runPowerShellPortLookup(port));
  } catch {
    return findWindowsListeningProcessIdsWithNetstat(port);
  }
}

async function runPowerShellPortLookup(port) {
  const script = [
    `$pids = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    '| Select-Object -ExpandProperty OwningProcess',
    '| Sort-Object -Unique);',
    "if ($pids.Count -eq 0) { '[]' } else { $pids | ConvertTo-Json -Compress }"
  ].join(' ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 5000 }
  );
  return stdout;
}

async function findWindowsListeningProcessIdsWithNetstat(port) {
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
    windowsHide: true,
    timeout: 5000
  });
  const pids = [];

  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') {
      continue;
    }
    const [, localAddress, , state, pid] = columns;
    if (state.toUpperCase() === 'LISTENING' && addressUsesPort(localAddress, port)) {
      pids.push(Number(pid));
    }
  }

  return uniqueProcessIds(pids);
}

async function findUnixListeningProcessIds(port) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      timeout: 5000
    });
    return uniqueProcessIds(stdout.split(/\s+/).map(Number));
  } catch {
    return findUnixListeningProcessIdsWithSs(port);
  }
}

async function findUnixListeningProcessIdsWithSs(port) {
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnp', 'sport', '=', `:${port}`], {
      timeout: 5000
    });
    return uniqueProcessIds(
      [...stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))
    );
  } catch {
    return [];
  }
}

function parseProcessIdJson(stdout) {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  return uniqueProcessIds(Array.isArray(parsed) ? parsed : [parsed]);
}

function addressUsesPort(address, port) {
  return address.endsWith(`:${port}`);
}

function uniqueProcessIds(values) {
  return [...new Set(values)]
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
