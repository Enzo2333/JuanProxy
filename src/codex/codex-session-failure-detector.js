import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const JUANPROXY_NO_SITE_MESSAGE = 'No active API site configuration is available';
export const JUANPROXY_NO_SITE_CODE = 'juanproxy_no_available_site';

const RETRYABLE_TASK_ERROR_FRAGMENTS = [
  'selected model is at capacity. please try a different model.',
  'stream disconnected before completion: stream closed before response.completed'
];

const DEFAULT_HEAD_BYTES = 64 * 1024;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const ROLLOUT_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export async function inspectCodexRollout(filePath, {
  headBytes = DEFAULT_HEAD_BYTES,
  tailBytes = DEFAULT_TAIL_BYTES
} = {}) {
  const metadata = await readSessionMetadata(filePath, headBytes);
  if (!metadata.threadId || metadata.isSubagent) {
    return null;
  }

  const latestEvent = await readLatestTaskLifecycleEvent(filePath, tailBytes);
  if (
    latestEvent?.kind !== 'complete' ||
    !isRetryableCodexTaskError(latestEvent.errorMessage)
  ) {
    return null;
  }

  return {
    threadId: metadata.threadId,
    failedTurnId: latestEvent.turnId ?? null,
    rolloutPath: filePath,
    cwd: metadata.cwd ?? null,
    failedAt: latestEvent.timestamp ?? null
  };
}

export async function findRecentJuanProxyFailures({ sessionsDir, sinceMs = 0 }) {
  if (!sessionsDir) {
    return [];
  }

  const rolloutPaths = await listRolloutFiles(sessionsDir);
  const failuresByThread = new Map();
  for (const rolloutPath of rolloutPaths) {
    let fileStat;
    try {
      fileStat = await stat(rolloutPath);
    } catch {
      continue;
    }
    if (fileStat.mtimeMs < sinceMs) {
      continue;
    }

    let failure;
    try {
      failure = await inspectCodexRollout(rolloutPath);
    } catch {
      continue;
    }
    if (!failure) {
      continue;
    }

    const existing = failuresByThread.get(failure.threadId);
    if (!existing || compareFailureTime(failure, existing) >= 0) {
      failuresByThread.set(failure.threadId, failure);
    }
  }

  return [...failuresByThread.values()].sort(compareFailureTime);
}

export async function inspectCodexRolloutCompletions(filePath, {
  sinceMs = 0,
  headBytes = DEFAULT_HEAD_BYTES,
  tailBytes = DEFAULT_TAIL_BYTES
} = {}) {
  const metadata = await readSessionMetadata(filePath, headBytes);
  if (!metadata.threadId || metadata.isSubagent) {
    return [];
  }
  const events = await readTaskLifecycleEvents(filePath, tailBytes);
  return events
    .filter((event) =>
      event.kind === 'complete' &&
      !event.hasError &&
      event.turnId &&
      dateMs(event.completedAt) >= sinceMs
    )
    .map((event) => ({
      threadId: metadata.threadId,
      turnId: event.turnId,
      rolloutPath: filePath,
      cwd: metadata.cwd ?? null,
      startedAt: event.startedAt,
      completedAt: event.completedAt,
      durationMs: event.durationMs
    }));
}

export async function findRecentCodexCompletions({ sessionsDir, sinceMs = 0 }) {
  if (!sessionsDir) {
    return [];
  }
  const completions = [];
  // ponytail: this is O(session files); persist per-file cursors if polling becomes measurable.
  for (const rolloutPath of await listRolloutFiles(sessionsDir)) {
    let fileStat;
    try {
      fileStat = await stat(rolloutPath);
    } catch {
      continue;
    }
    if (fileStat.mtimeMs < sinceMs) {
      continue;
    }
    try {
      completions.push(...await inspectCodexRolloutCompletions(rolloutPath, { sinceMs }));
    } catch {
      // A rollout can still be appended while the watchdog reads it.
    }
  }
  return completions.sort((left, right) => dateMs(left.completedAt) - dateMs(right.completedAt));
}

export async function findRecentCodexEvents({
  sessionsDir,
  eventSinceMs = 0,
  modifiedSinceMs = 0,
  includeGoalContext = false
}) {
  if (!sessionsDir) {
    return [];
  }
  const events = [];
  // ponytail: this is O(session files); persist per-file cursors if polling becomes measurable.
  for (const rolloutPath of await listRolloutFiles(sessionsDir)) {
    let fileStat;
    try {
      fileStat = await stat(rolloutPath);
    } catch {
      continue;
    }
    if (fileStat.mtimeMs < modifiedSinceMs) {
      continue;
    }
    try {
      events.push(...await inspectCodexRolloutEvents(rolloutPath, {
        eventSinceMs,
        includeGoalContext
      }));
    } catch {
      // A rollout can still be appended while the watchdog reads it.
    }
  }
  return events.sort((left, right) => eventTimeMs(left) - eventTimeMs(right));
}

export function isJuanProxyNoSiteError(message) {
  return typeof message === 'string' && (
    message.includes(JUANPROXY_NO_SITE_CODE) ||
    message.includes(JUANPROXY_NO_SITE_MESSAGE)
  );
}

export function isRetryableCodexTaskError(message) {
  if (isJuanProxyNoSiteError(message)) {
    return true;
  }
  if (typeof message !== 'string') {
    return false;
  }

  const normalized = message.toLowerCase();
  return RETRYABLE_TASK_ERROR_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

async function readSessionMetadata(filePath, maxBytes) {
  const text = await readFilePart(filePath, { start: 0, maxBytes });
  const firstLine = text.split(/\r?\n/, 1)[0];
  const parsed = tryParseJson(firstLine);
  if (parsed?.type === 'session_meta') {
    return {
      threadId: parsed.payload?.id ?? extractThreadIdFromPath(filePath),
      cwd: parsed.payload?.cwd ?? null,
      isSubagent: parsed.payload?.thread_source === 'subagent' ||
        Boolean(parsed.payload?.parent_thread_id)
    };
  }

  return {
    threadId: readJsonStringField(text, 'id') ?? extractThreadIdFromPath(filePath),
    cwd: readJsonStringField(text, 'cwd'),
    isSubagent: readJsonStringField(text, 'thread_source') === 'subagent' ||
      text.includes('"parent_thread_id"')
  };
}

async function readLatestTaskLifecycleEvent(filePath, maxBytes) {
  return (await readTaskLifecycleEvents(filePath, maxBytes)).at(-1) ?? null;
}

async function readTaskLifecycleEvents(filePath, maxBytes) {
  return (await readCodexTimelineEvents(filePath, maxBytes))
    .filter((event) => event.kind === 'started' || event.kind === 'complete');
}

async function inspectCodexRolloutEvents(filePath, {
  eventSinceMs,
  includeGoalContext,
  headBytes = DEFAULT_HEAD_BYTES,
  tailBytes = DEFAULT_TAIL_BYTES
}) {
  const metadata = await readSessionMetadata(filePath, headBytes);
  if (!metadata.threadId || metadata.isSubagent) {
    return [];
  }
  const timeline = await readCodexTimelineEvents(filePath, tailBytes);
  const previousGoal = includeGoalContext
    ? timeline.filter((event) => event.kind === 'goal' && dateMs(event.updatedAt) < eventSinceMs).at(-1)
    : null;
  return timeline
    .filter((event) =>
      (event.kind === 'complete' && !event.hasError && event.turnId && dateMs(event.completedAt) >= eventSinceMs) ||
      (event.kind === 'goal' && (event === previousGoal || dateMs(event.updatedAt) >= eventSinceMs))
    )
    .map((event) => event.kind === 'goal'
      ? {
          type: 'goal',
          key: `${metadata.threadId}:${event.createdAtKey}:${event.updatedAtKey}:${event.status}`,
          threadId: metadata.threadId,
          rolloutPath: filePath,
          cwd: metadata.cwd ?? null,
          status: event.status,
          createdAt: event.createdAt,
          updatedAt: event.updatedAt
        }
      : {
          type: 'completion',
          key: `${metadata.threadId}:${event.turnId}`,
          threadId: metadata.threadId,
          turnId: event.turnId,
          rolloutPath: filePath,
          cwd: metadata.cwd ?? null,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
          durationMs: event.durationMs
        });
}

async function readCodexTimelineEvents(filePath, maxBytes) {
  const fileStat = await stat(filePath);
  const start = Math.max(0, fileStat.size - maxBytes);
  let text = await readFilePart(filePath, { start, maxBytes });
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }

  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"type":"event_msg"')) {
      continue;
    }
    if (
      !line.includes('"type":"task_started"') &&
      !line.includes('"type":"task_complete"') &&
      !line.includes('"type":"thread_goal_updated"')
    ) {
      continue;
    }
    const envelope = tryParseJson(line);
    const payload = envelope?.type === 'event_msg' ? envelope.payload : null;
    if (payload?.type === 'task_started') {
      events.push({
        kind: 'started',
        turnId: payload.turn_id ?? null,
        timestamp: envelope.timestamp ?? null,
        startedAt: codexTimestamp(payload.started_at) ?? envelope.timestamp ?? null,
        completedAt: null,
        durationMs: null,
        hasError: false,
        errorMessage: null
      });
    } else if (payload?.type === 'task_complete') {
      events.push({
        kind: 'complete',
        turnId: payload.turn_id ?? null,
        timestamp: envelope.timestamp ?? null,
        startedAt: codexTimestamp(payload.started_at),
        completedAt: codexTimestamp(payload.completed_at) ?? envelope.timestamp ?? null,
        durationMs: finiteNonNegative(payload.duration_ms),
        hasError: payload.error !== null && payload.error !== undefined,
        errorMessage: payload.error?.message ?? null
      });
    } else if (payload?.type === 'thread_goal_updated') {
      const status = String(payload.goal?.status ?? '').trim().toLowerCase();
      const createdAt = codexTimestamp(payload.goal?.createdAt);
      const updatedAt = codexTimestamp(payload.goal?.updatedAt) ?? envelope.timestamp ?? null;
      if (status && createdAt && updatedAt) {
        events.push({
          kind: 'goal',
          status,
          createdAt,
          updatedAt,
          createdAtKey: String(payload.goal.createdAt),
          updatedAtKey: String(payload.goal.updatedAt ?? envelope.timestamp)
        });
      }
    }
  }
  return events;
}

async function listRolloutFiles(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await listRolloutFiles(path));
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      found.push(path);
    }
  }
  return found;
}

async function readFilePart(filePath, { start, maxBytes }) {
  const handle = await open(filePath, 'r');
  try {
    const fileStat = await handle.stat();
    const length = Math.max(0, Math.min(maxBytes, fileStat.size - start));
    if (length === 0) {
      return '';
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function readJsonStringField(text, field) {
  const pattern = new RegExp(`"${escapeRegExp(field)}":"((?:\\\\.|[^"\\\\])*)"`);
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function extractThreadIdFromPath(filePath) {
  return basename(filePath).match(ROLLOUT_ID_PATTERN)?.[1] ?? null;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compareFailureTime(left, right) {
  return Date.parse(left.failedAt ?? 0) - Date.parse(right.failedAt ?? 0);
}

function codexTimestamp(value) {
  const number = Number(value);
  const date = Number.isFinite(number)
    ? new Date(number < 1e12 ? number * 1000 : number)
    : new Date(value ?? NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dateMs(value) {
  const time = new Date(value ?? 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function eventTimeMs(event) {
  return dateMs(event.type === 'goal' ? event.updatedAt : event.completedAt);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
