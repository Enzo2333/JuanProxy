import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CONTINUABLE_GOAL_STATUSES = new Set(['active']);

export class CodexAppServerClient extends EventEmitter {
  constructor({
    executablePath,
    spawnProcess = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    env = process.env
  }) {
    super();
    if (!executablePath) {
      throw new Error('executablePath is required');
    }
    this.executablePath = executablePath;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.env = env;
    this.process = null;
    this.reader = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.recentNotifications = [];
    this.closed = false;
    this.closeError = null;
  }

  async start() {
    if (this.process) {
      return;
    }
    this.closed = false;
    this.closeError = null;
    this.process = this.spawnProcess(
      this.executablePath,
      ['app-server', '--listen', 'stdio://'],
      {
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32' && /\.cmd$/i.test(this.executablePath)
      }
    );
    this.reader = createInterface({ input: this.process.stdout });
    this.reader.on('line', (line) => this.handleLine(line));
    this.process.once('error', (error) => this.handleProcessClosed(error));
    this.process.once('exit', (code, signal) => {
      this.handleProcessClosed(new Error(
        `Codex App Server exited before completion (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      ));
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'juanproxy',
        title: 'JuanProxy',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify('initialized', {});
  }

  async runContinuation({ threadId, prompt, signal = null }) {
    const onAbort = () => this.close(new Error('Codex continuation was cancelled'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) {
        throw new Error('Codex continuation was cancelled');
      }
      await this.start();
      await this.request('thread/resume', { threadId });
      const goal = await this.getThreadGoal(threadId);
      const goalStatus = goal?.status ?? null;
      if (goalStatus && !CONTINUABLE_GOAL_STATUSES.has(goalStatus)) {
        return {
          started: false,
          threadId,
          turnId: null,
          goalStatus,
          turnStatus: null
        };
      }

      const response = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }]
      });
      const turnId = response?.turn?.id;
      if (!turnId) {
        throw new Error('Codex App Server did not return a turn id');
      }
      const completion = await this.waitForNotification(
        'turn/completed',
        (params) => params?.threadId === threadId && params?.turn?.id === turnId,
        { signal }
      );
      return {
        started: true,
        threadId,
        turnId,
        goalStatus,
        turnStatus: completion.turn?.status ?? null
      };
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      this.close();
    }
  }

  async getThreadGoal(threadId) {
    try {
      const response = await this.request('thread/goal/get', { threadId });
      return response?.goal ?? null;
    } catch (error) {
      if (error.code === -32601) {
        return null;
      }
      throw error;
    }
  }

  request(method, params = {}) {
    if (this.closed || !this.process?.stdin) {
      return Promise.reject(new Error('Codex App Server is not running'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      this.write({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  waitForNotification(method, predicate = () => true, { signal = null } = {}) {
    const existingIndex = this.recentNotifications.findIndex((notification) =>
      notification.method === method && predicate(notification.params)
    );
    if (existingIndex >= 0) {
      const [notification] = this.recentNotifications.splice(existingIndex, 1);
      return Promise.resolve(notification.params);
    }
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error('Codex App Server closed before notification')
      );
    }

    return new Promise((resolve, reject) => {
      const onNotification = (params) => {
        if (!predicate(params)) {
          return;
        }
        cleanup();
        resolve(params);
      };
      const onClosed = (error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Codex continuation was cancelled'));
      };
      const cleanup = () => {
        this.off(method, onNotification);
        this.off('closed', onClosed);
        signal?.removeEventListener?.('abort', onAbort);
      };
      this.on(method, onNotification);
      this.once('closed', onClosed);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? `Codex App Server request failed: ${pending.method}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      this.recentNotifications.push({ method: message.method, params: message.params });
      this.recentNotifications = this.recentNotifications.slice(-100);
      this.emit(message.method, message.params);
    }
  }

  write(message) {
    if (this.closed || !this.process?.stdin?.writable) {
      throw new Error('Codex App Server input is unavailable');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleProcessClosed(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.emit('closed', error);
  }

  close(error = null) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error ?? new Error('Codex App Server closed');
    this.reader?.close();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('Codex App Server closed'));
    }
    this.pendingRequests.clear();
    this.process?.stdin?.end?.();
    this.process?.kill?.();
  }
}

export async function runCodexContinuation({
  threadId,
  prompt,
  signal = null,
  env = process.env,
  executablePath = null,
  spawnProcess = spawn
}) {
  const resolvedExecutable = executablePath ?? await findCodexExecutable({ env });
  const client = new CodexAppServerClient({
    executablePath: resolvedExecutable,
    spawnProcess,
    env
  });
  return client.runContinuation({ threadId, prompt, signal });
}

export async function readCodexThreadNames({
  threadIds = [],
  env = process.env,
  executablePath = null,
  spawnProcess = spawn
} = {}) {
  const ids = [...new Set(threadIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) {
    return new Map();
  }
  const client = new CodexAppServerClient({
    executablePath: executablePath ?? await findCodexExecutable({ env }),
    spawnProcess,
    env
  });
  try {
    await client.start();
    const names = new Map();
    for (const threadId of ids) {
      const response = await client.request('thread/read', { threadId, includeTurns: false });
      const name = String(response?.thread?.name ?? '').trim();
      if (name) {
        names.set(threadId, name);
      }
    }
    return names;
  } finally {
    client.close();
  }
}

export async function findCodexExecutable({
  env = process.env,
  platform = process.platform
} = {}) {
  if (platform === 'win32') {
    const appBin = env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
      : null;
    const appExecutables = appBin ? await findNamedFiles(appBin, 'codex.exe', 2) : [];
    if (appExecutables.length > 0) {
      const withStats = await Promise.all(appExecutables.map(async (path) => ({
        path,
        mtimeMs: (await stat(path)).mtimeMs
      })));
      withStats.sort((left, right) => right.mtimeMs - left.mtimeMs);
      return withStats[0].path;
    }
  }

  if (env.CODEX_CLI_PATH && await exists(env.CODEX_CLI_PATH)) {
    return env.CODEX_CLI_PATH;
  }
  if (platform === 'win32' && env.APPDATA) {
    const npmShim = join(env.APPDATA, 'npm', 'codex.cmd');
    if (await exists(npmShim)) {
      return npmShim;
    }
  }
  return platform === 'win32' ? 'codex.exe' : 'codex';
}

async function findNamedFiles(directory, name, remainingDepth) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      found.push(path);
    } else if (entry.isDirectory() && remainingDepth > 0) {
      found.push(...await findNamedFiles(path, name, remainingDepth - 1));
    }
  }
  return found;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
