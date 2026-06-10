import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  loadWindowSize,
  saveWindowSize
} from '../src/window-state.js';

test('persists and reloads the latest window size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-window-state-'));
  const filePath = join(dir, 'window-state.json');

  try {
    saveWindowSize(filePath, { width: 1320.8, height: 810.2 });

    assert.deepEqual(loadWindowSize(filePath), {
      width: 1321,
      height: 810
    });

    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(saved, {
      width: 1321,
      height: 810
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('falls back to the default size when no saved window size exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-window-state-missing-'));

  try {
    assert.deepEqual(loadWindowSize(join(dir, 'window-state.json')), DEFAULT_WINDOW_SIZE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizes invalid saved window sizes to usable dimensions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-proxy-window-state-invalid-'));
  const filePath = join(dir, 'window-state.json');

  try {
    await writeFile(filePath, JSON.stringify({ width: 100, height: 'bad' }), 'utf8');

    assert.deepEqual(loadWindowSize(filePath), {
      width: MIN_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
