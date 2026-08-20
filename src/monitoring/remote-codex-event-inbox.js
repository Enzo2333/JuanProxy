import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function storeRemoteCodexEvents({ inboxDir, source = {}, events = [] } = {}) {
  if (!inboxDir) {
    throw new Error('remote Codex event inbox is not configured');
  }
  await mkdir(inboxDir, { recursive: true });
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const value of Array.isArray(events) ? events.slice(0, 100) : []) {
    const event = normalizeRemoteCodexEvent({ ...value, source });
    if (!event) {
      rejected += 1;
      continue;
    }
    const filePath = join(inboxDir, `${createHash('sha256').update(event.key).digest('hex')}.json`);
    try {
      await writeFile(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'wx' });
      accepted += 1;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        duplicates += 1;
        continue;
      }
      throw error;
    }
  }
  return { accepted, duplicates, rejected };
}

export async function readRemoteCodexEvents(inboxDir) {
  if (!inboxDir) {
    return [];
  }
  let names;
  try {
    names = await readdir(inboxDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const events = [];
  for (const name of names.filter((value) => value.endsWith('.json'))) {
    const inboxPath = join(inboxDir, name);
    try {
      const event = normalizeRemoteCodexEvent(JSON.parse(await readFile(inboxPath, 'utf8')));
      if (event) {
        events.push({ ...event, inboxPath });
      }
    } catch {
      // The receiver may still be writing a newly-created inbox file.
    }
  }
  return events;
}

export async function removeRemoteCodexEventFiles(paths = []) {
  await Promise.all([...new Set(paths.filter(Boolean))].map(async (filePath) => {
    try {
      await rm(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }));
}

export function normalizeRemoteCodexEvent(value = {}) {
  const source = value.source && typeof value.source === 'object' ? value.source : {};
  const sourceId = limitedText(value.sourceId ?? source.id, 128);
  const machineName = limitedText(value.machineName ?? source.name, 128);
  const threadId = limitedText(value.threadId, 128);
  const status = limitedText(value.status, 32).toLowerCase();
  const createdAt = normalizeIso(value.createdAt);
  const updatedAt = normalizeIso(value.updatedAt);
  if (sourceId && machineName && threadId && ['paused', 'complete'].includes(status) && createdAt && updatedAt) {
    return {
      type: 'goal',
      source: 'remote',
      key: `remote:${sourceId}:${threadId}:${createdAt}:${updatedAt}:${status}`,
      sourceId,
      machineName,
      threadId,
      status,
      cwd: limitedText(value.cwd, 1000),
      threadName: limitedText(value.threadName, 200),
      receivedAt: normalizeIso(value.receivedAt) ?? new Date().toISOString(),
      createdAt,
      updatedAt
    };
  }
  const turnId = limitedText(value.turnId, 128);
  const completedAt = normalizeIso(value.completedAt);
  if (!sourceId || !machineName || !threadId || !turnId || !completedAt) {
    return null;
  }
  return {
    type: 'completion',
    source: 'remote',
    key: `remote:${sourceId}:${threadId}:${turnId}`,
    sourceId,
    machineName,
    threadId,
    turnId,
    cwd: limitedText(value.cwd, 1000),
    threadName: limitedText(value.threadName, 200),
    receivedAt: normalizeIso(value.receivedAt) ?? new Date().toISOString(),
    startedAt: normalizeIso(value.startedAt),
    completedAt,
    durationMs: Number.isFinite(Number(value.durationMs)) && Number(value.durationMs) >= 0
      ? Number(value.durationMs)
      : null
  };
}

function limitedText(value, limit) {
  return String(value ?? '').trim().slice(0, limit);
}

function normalizeIso(value) {
  const time = new Date(value ?? NaN).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
