import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_WINDOW_SIZE = {
  width: 1180,
  height: 760
};

export const MIN_WINDOW_SIZE = {
  width: 980,
  height: 640
};

export function loadWindowSize(filePath) {
  if (!existsSync(filePath)) {
    return { ...DEFAULT_WINDOW_SIZE };
  }

  try {
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalizeWindowSize(saved);
  } catch {
    return { ...DEFAULT_WINDOW_SIZE };
  }
}

export function saveWindowSize(filePath, bounds) {
  const size = normalizeWindowSize(bounds);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(size, null, 2)}\n`, 'utf8');
  return size;
}

function normalizeWindowSize(value) {
  return {
    width: normalizeDimension(value?.width, DEFAULT_WINDOW_SIZE.width, MIN_WINDOW_SIZE.width),
    height: normalizeDimension(value?.height, DEFAULT_WINDOW_SIZE.height, MIN_WINDOW_SIZE.height)
  };
}

function normalizeDimension(value, fallback, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(Math.round(number), minimum);
}
