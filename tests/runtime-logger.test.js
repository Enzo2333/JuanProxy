import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { RuntimeLogger, createRuntimeLogger, sanitizeLogValue } from '../src/runtime-logger.js';

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('runtime logger appends structured error entries to a jsonl file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-runtime-log-'));
  const logger = new RuntimeLogger({ directory: dir, now: () => new Date('2026-06-09T12:00:00.000Z') });

  try {
    const error = new Error('upstream failed');
    error.code = 'ECONNRESET';

    const result = await logger.error('proxy.request-error', error, {
      siteId: 'site-1',
      baseUrl: 'https://api.example/v1'
    });

    assert.equal(result.ok, true);
    assert.equal(result.filePath, logger.filePath);

    const [entry] = await readJsonl(logger.filePath);
    assert.equal(entry.timestamp, '2026-06-09T12:00:00.000Z');
    assert.equal(entry.level, 'error');
    assert.equal(entry.source, 'proxy.request-error');
    assert.equal(entry.message, 'upstream failed');
    assert.equal(entry.error.name, 'Error');
    assert.equal(entry.error.message, 'upstream failed');
    assert.equal(entry.error.code, 'ECONNRESET');
    assert.match(entry.error.stack, /upstream failed/);
    assert.deepEqual(entry.context, {
      siteId: 'site-1',
      baseUrl: 'https://api.example/v1'
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime logger redacts credentials from errors and context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-runtime-log-redact-'));
  const logger = new RuntimeLogger({ directory: dir });

  try {
    const error = new Error('Authorization Bearer sk-live-secret failed with token=very-secret-token');
    await logger.error('config.save', error, {
      apiKey: 'sk-config-secret',
      password: 'plain-password',
      nested: {
        authorization: 'Bearer sk-nested-secret',
        cookie: 'session=abc',
        note: 'model failed'
      }
    });

    const raw = await readFile(logger.filePath, 'utf8');
    assert.doesNotMatch(raw, /sk-live-secret/);
    assert.doesNotMatch(raw, /very-secret-token/);
    assert.doesNotMatch(raw, /sk-config-secret/);
    assert.doesNotMatch(raw, /plain-password/);
    assert.doesNotMatch(raw, /sk-nested-secret/);
    assert.doesNotMatch(raw, /session=abc/);

    const [entry] = JSON.parse(`[${raw.trim()}]`);
    assert.match(entry.message, /Authorization Bearer \[REDACTED\]/);
    assert.equal(entry.context.apiKey, '[REDACTED]');
    assert.equal(entry.context.password, '[REDACTED]');
    assert.equal(entry.context.nested.authorization, '[REDACTED]');
    assert.equal(entry.context.nested.cookie, '[REDACTED]');
    assert.equal(entry.context.nested.note, 'model failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime logger bounds circular and large context values', () => {
  const circular = { ok: true };
  circular.self = circular;

  assert.deepEqual(sanitizeLogValue(circular), {
    ok: true,
    self: '[Circular]'
  });

  const longText = 'x'.repeat(6000);
  const sanitized = sanitizeLogValue({ value: longText });

  assert.equal(sanitized.value.length, 4000 + '...[truncated]'.length);
  assert.match(sanitized.value, /\.\.\.\[truncated\]$/);
});

test('runtime logger does not throw when a log write fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-runtime-log-failure-'));
  const logger = new RuntimeLogger({
    directory: dir,
    fileName: 'runtime-errors.jsonl',
    console: null
  });

  try {
    await mkdir(logger.filePath);

    const result = await logger.error('write.failure', new Error('cannot append'));

    assert.equal(result.ok, false);
    assert.equal(typeof result.error.message, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createRuntimeLogger stores logs under the app userData logs directory', () => {
  const logger = createRuntimeLogger({ userDataPath: 'C:\\Users\\Example\\AppData\\Roaming\\JuanProxy' });

  assert.match(logger.filePath, /logs[\\/]runtime-errors\.jsonl$/);
});
