import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  CodexAppServerClient,
  findCodexExecutable
} from '../src/codex/codex-app-server-client.js';

function createFakeProcess(onMessage) {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  let input = '';
  process.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      let newline;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (line) {
          onMessage(JSON.parse(line), (message) => {
            process.stdout.write(`${JSON.stringify(message)}\n`);
          });
        }
      }
      callback();
    }
  });
  process.kill = () => {
    process.emit('exit', 0, null);
    return true;
  };
  return process;
}

test('initializes App Server and starts a continuation turn for an active goal', async () => {
  const messages = [];
  const fakeProcess = createFakeProcess((message, reply) => {
    messages.push(message);
    if (message.method === 'initialize') {
      reply({ id: message.id, result: { userAgent: 'test' } });
    } else if (message.method === 'thread/resume') {
      reply({ id: message.id, result: { thread: { id: 'thread-1' } } });
    } else if (message.method === 'thread/goal/get') {
      reply({ id: message.id, result: { goal: { status: 'active' } } });
    } else if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'turn-2', status: 'inProgress' } } });
      queueMicrotask(() => reply({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } }
      }));
    }
  });
  const client = new CodexAppServerClient({
    executablePath: 'codex.exe',
    spawnProcess: () => fakeProcess
  });

  const result = await client.runContinuation({
    threadId: 'thread-1',
    prompt: 'continue'
  });

  assert.deepEqual(result, {
    started: true,
    threadId: 'thread-1',
    turnId: 'turn-2',
    goalStatus: 'active',
    turnStatus: 'completed'
  });
  assert.deepEqual(messages.map((message) => message.method), [
    'initialize',
    'initialized',
    'thread/resume',
    'thread/goal/get',
    'turn/start'
  ]);
  assert.deepEqual(messages.at(-1).params.input, [{ type: 'text', text: 'continue' }]);
});

test('does not continue a goal that the user paused', async () => {
  const messages = [];
  const fakeProcess = createFakeProcess((message, reply) => {
    messages.push(message);
    if (message.method === 'initialize') {
      reply({ id: message.id, result: {} });
    } else if (message.method === 'thread/resume') {
      reply({ id: message.id, result: { thread: { id: 'thread-1' } } });
    } else if (message.method === 'thread/goal/get') {
      reply({ id: message.id, result: { goal: { status: 'paused' } } });
    }
  });
  const client = new CodexAppServerClient({
    executablePath: 'codex.exe',
    spawnProcess: () => fakeProcess
  });

  assert.deepEqual(await client.runContinuation({ threadId: 'thread-1', prompt: 'continue' }), {
    started: false,
    threadId: 'thread-1',
    turnId: null,
    goalStatus: 'paused',
    turnStatus: null
  });
  assert.equal(messages.some((message) => message.method === 'turn/start'), false);
});

test('rejects when App Server exits before the continuation turn completes', async () => {
  const fakeProcess = createFakeProcess((message, reply) => {
    if (message.method === 'initialize') {
      reply({ id: message.id, result: {} });
    } else if (message.method === 'thread/resume') {
      reply({ id: message.id, result: { thread: { id: 'thread-1' } } });
    } else if (message.method === 'thread/goal/get') {
      reply({ id: message.id, result: { goal: { status: 'active' } } });
    } else if (message.method === 'turn/start') {
      reply({ id: message.id, result: { turn: { id: 'turn-2', status: 'inProgress' } } });
      queueMicrotask(() => fakeProcess.emit('exit', 1, null));
    }
  });
  const client = new CodexAppServerClient({
    executablePath: 'codex.exe',
    spawnProcess: () => fakeProcess
  });

  await assert.rejects(
    client.runContinuation({ threadId: 'thread-1', prompt: 'continue' }),
    /exited before completion/
  );
});

test('discovers the newest Codex Windows App executable before npm and PATH fallbacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-executable-'));
  try {
    const localAppData = join(dir, 'Local');
    const appData = join(dir, 'Roaming');
    const oldExecutable = join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe');
    const newExecutable = join(localAppData, 'OpenAI', 'Codex', 'bin', 'hash', 'codex.exe');
    await mkdir(join(localAppData, 'OpenAI', 'Codex', 'bin', 'hash'), { recursive: true });
    await mkdir(join(appData, 'npm'), { recursive: true });
    await writeFile(oldExecutable, 'old');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(newExecutable, 'new');
    await writeFile(join(appData, 'npm', 'codex.cmd'), 'npm');

    assert.equal(await findCodexExecutable({
      env: { LOCALAPPDATA: localAppData, APPDATA: appData },
      platform: 'win32'
    }), newExecutable);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reads user-facing names for completed Codex threads', async () => {
  const messages = [];
  const fakeProcess = createFakeProcess((message, reply) => {
    messages.push(message);
    if (message.method === 'initialize') {
      reply({ id: message.id, result: {} });
    } else if (message.method === 'thread/read') {
      reply({
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            name: message.params.threadId === 'thread-1' ? '飞书完成通知' : null
          }
        }
      });
    }
  });
  const appServer = await import('../src/codex/codex-app-server-client.js');

  assert.equal(typeof appServer.readCodexThreadNames, 'function');
  assert.deepEqual(await appServer.readCodexThreadNames({
    threadIds: ['thread-1', 'thread-2'],
    executablePath: 'codex.exe',
    spawnProcess: () => fakeProcess
  }), new Map([['thread-1', '飞书完成通知']]));
  assert.deepEqual(
    messages.filter((message) => message.method === 'thread/read').map((message) => message.params),
    [
      { threadId: 'thread-1', includeTurns: false },
      { threadId: 'thread-2', includeTurns: false }
    ]
  );
});

test('bounds thread name lookup time so notifications can use their fallback title', async () => {
  const fakeProcess = createFakeProcess((message, reply) => {
    if (message.method === 'initialize') {
      reply({ id: message.id, result: {} });
    }
  });
  const appServer = await import('../src/codex/codex-app-server-client.js');
  const forcedExit = setTimeout(() => fakeProcess.emit('exit', 1, null), 50);

  try {
    await assert.rejects(appServer.readCodexThreadNames({
      threadIds: ['thread-1'],
      executablePath: 'codex.exe',
      spawnProcess: () => fakeProcess,
      requestTimeoutMs: 5
    }), /request timed out: thread\/read/);
  } finally {
    clearTimeout(forcedExit);
  }
});
