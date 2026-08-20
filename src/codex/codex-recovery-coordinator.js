import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isRateLimitPaused } from '../proxy/switching-policy.js';
import { runCodexContinuation } from './codex-app-server-client.js';
import {
  findRecentJuanProxyFailures,
  inspectCodexRollout
} from './codex-session-failure-detector.js';

const DEFAULT_SCAN_DELAYS_MS = [250, 1500, 5000];
const MAX_RESUME_ATTEMPTS = 3;
const FAILURE_SCAN_GRACE_MS = 5000;
const CONTINUATION_PROMPT =
  'JuanProxy 检测到可用站点已恢复。请先核对工作区现状，避免重复已完成的操作，然后从上次中断处继续当前任务或目标。';

export class CodexRecoveryCoordinator extends EventEmitter {
  constructor({
    configService,
    sessionsDir,
    queueFilePath,
    findFailures = findRecentJuanProxyFailures,
    inspectRollout: inspectRolloutFn = inspectCodexRollout,
    resumeThread = runCodexContinuation,
    scanDelaysMs = DEFAULT_SCAN_DELAYS_MS,
    now = () => new Date(),
    logger = console
  }) {
    super();
    if (!configService) {
      throw new Error('configService is required');
    }
    if (!sessionsDir) {
      throw new Error('sessionsDir is required');
    }
    if (!queueFilePath) {
      throw new Error('queueFilePath is required');
    }
    this.configService = configService;
    this.sessionsDir = sessionsDir;
    this.queueFilePath = queueFilePath;
    this.findFailures = findFailures;
    this.inspectRollout = inspectRolloutFn;
    this.resumeThread = resumeThread;
    this.scanDelaysMs = scanDelaysMs;
    this.now = now;
    this.logger = logger;
    this.pending = new Map();
    this.scanTimers = new Set();
    this.enabled = false;
    this.started = false;
    this.stopped = false;
    this.drainPromise = null;
    this.activeAbortController = null;
    this.queueSavePromise = Promise.resolve();
    this.lastError = null;
    this.onConfigChanged = () => {
      this.handleConfigChanged().catch((error) => this.recordError(error));
    };
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    await this.loadQueue();
    this.enabled = this.isEnabledInConfig();
    if (!this.enabled && this.pending.size > 0) {
      this.pending.clear();
      await this.saveQueue();
    }
    this.configService.on('changed', this.onConfigChanged);
    if (this.enabled && this.hasUsableSite()) {
      void this.drain();
    }
  }

  async stop() {
    if (!this.started) {
      return;
    }
    this.stopped = true;
    this.started = false;
    this.configService.off('changed', this.onConfigChanged);
    for (const timer of this.scanTimers) {
      clearTimeout(timer);
    }
    this.scanTimers.clear();
    this.activeAbortController?.abort();
    await this.drainPromise?.catch(() => {});
  }

  getStatus() {
    const entries = [...this.pending.values()];
    return {
      enabled: this.enabled,
      pendingTasks: entries.filter((entry) => entry.attempts < MAX_RESUME_ATTEMPTS).length,
      failedTasks: entries.filter((entry) => entry.attempts >= MAX_RESUME_ATTEMPTS).length,
      resuming: Boolean(this.drainPromise),
      lastError: this.lastError
    };
  }

  handleAvailabilityExhausted(event = {}) {
    if (!this.enabled || this.stopped) {
      return;
    }
    const occurredAtMs = Date.parse(event.occurredAt ?? '') || this.now().getTime();
    const sinceMs = occurredAtMs - FAILURE_SCAN_GRACE_MS;
    for (const delayMs of this.scanDelaysMs) {
      const timer = setTimeout(() => {
        this.scanTimers.delete(timer);
        this.scanNow({ sinceMs }).catch((error) => this.recordError(error));
      }, delayMs);
      timer.unref?.();
      this.scanTimers.add(timer);
    }
  }

  notifySitesRecovered() {
    if (this.enabled && !this.stopped) {
      void this.drain();
    }
  }

  async scanNow({ sinceMs }) {
    if (!this.enabled || this.stopped) {
      return [];
    }
    const failures = await this.findFailures({
      sessionsDir: this.sessionsDir,
      sinceMs
    });
    let changed = false;
    for (const failure of failures) {
      const existing = this.pending.get(failure.threadId);
      if (existing && compareFailureTime(existing, failure) > 0) {
        continue;
      }
      this.pending.set(failure.threadId, {
        threadId: failure.threadId,
        failedTurnId: failure.failedTurnId ?? null,
        rolloutPath: failure.rolloutPath,
        cwd: failure.cwd ?? null,
        failedAt: failure.failedAt ?? null,
        detectedAt: this.now().toISOString(),
        attempts: existing?.failedTurnId === failure.failedTurnId ? existing.attempts : 0,
        lastError: existing?.failedTurnId === failure.failedTurnId ? existing.lastError : null
      });
      changed = true;
    }
    if (changed) {
      await this.saveQueue();
      this.emit('queue-changed', this.getStatus());
    }
    if (this.hasUsableSite()) {
      await this.drain();
    }
    return failures;
  }

  drain() {
    if (this.drainPromise) {
      return this.drainPromise;
    }
    if (!this.enabled || this.stopped || !this.hasUsableSite()) {
      return Promise.resolve();
    }
    this.drainPromise = this.drainNow()
      .catch((error) => this.recordError(error))
      .finally(() => {
        this.drainPromise = null;
        this.emit('queue-changed', this.getStatus());
      });
    return this.drainPromise;
  }

  async drainNow() {
    for (const queued of [...this.pending.values()]) {
      if (!this.enabled || this.stopped || !this.hasUsableSite()) {
        return;
      }
      if (queued.attempts >= MAX_RESUME_ATTEMPTS) {
        continue;
      }

      const currentFailure = await this.inspectRollout(queued.rolloutPath);
      if (!currentFailure || currentFailure.threadId !== queued.threadId) {
        this.pending.delete(queued.threadId);
        await this.saveQueue();
        continue;
      }
      if (currentFailure.failedTurnId !== queued.failedTurnId) {
        queued.failedTurnId = currentFailure.failedTurnId ?? null;
        queued.failedAt = currentFailure.failedAt ?? null;
        queued.detectedAt = this.now().toISOString();
        queued.attempts = 0;
        queued.lastError = null;
      }

      queued.attempts += 1;
      queued.lastError = null;
      await this.saveQueue();
      this.activeAbortController = new AbortController();
      try {
        await this.resumeThread({
          threadId: queued.threadId,
          prompt: CONTINUATION_PROMPT,
          signal: this.activeAbortController.signal
        });
        this.pending.delete(queued.threadId);
        this.lastError = null;
        await this.saveQueue();
      } catch (error) {
        queued.lastError = sanitizeError(error);
        this.lastError = queued.lastError;
        await this.saveQueue();
      } finally {
        this.activeAbortController = null;
      }
    }
  }

  async handleConfigChanged() {
    const nextEnabled = this.isEnabledInConfig();
    if (!nextEnabled) {
      this.enabled = false;
      this.activeAbortController?.abort();
      for (const timer of this.scanTimers) {
        clearTimeout(timer);
      }
      this.scanTimers.clear();
      if (this.pending.size > 0) {
        this.pending.clear();
        await this.saveQueue();
      }
      this.emit('queue-changed', this.getStatus());
      return;
    }

    this.enabled = true;
    if (this.hasUsableSite()) {
      await this.drain();
    }
  }

  isEnabledInConfig() {
    return Boolean(this.configService.getState().proxy?.codexRecoveryEnabled);
  }

  hasUsableSite() {
    return this.configService.getState().sites.some((site) =>
      site.enabled && !isRateLimitPaused(site, this.now())
    );
  }

  async loadQueue() {
    try {
      const payload = JSON.parse(await readFile(this.queueFilePath, 'utf8'));
      for (const entry of Array.isArray(payload?.pending) ? payload.pending : []) {
        if (isValidQueueEntry(entry)) {
          this.pending.set(entry.threadId, normalizeQueueEntry(entry));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }

  saveQueue() {
    const save = this.queueSavePromise
      .catch(() => {})
      .then(() => this.writeQueue());
    this.queueSavePromise = save;
    return save;
  }

  async writeQueue() {
    const payload = `${JSON.stringify({
      version: 1,
      pending: [...this.pending.values()]
    }, null, 2)}\n`;
    await mkdir(dirname(this.queueFilePath), { recursive: true });
    const tempPath = `${this.queueFilePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, payload, 'utf8');
    await rename(tempPath, this.queueFilePath);
  }

  recordError(error) {
    this.lastError = sanitizeError(error);
    this.logger.error?.('Codex recovery failed:', error);
    this.emit('recovery-error', error);
  }
}

function isValidQueueEntry(entry) {
  return Boolean(
    entry &&
    typeof entry.threadId === 'string' && entry.threadId &&
    typeof entry.rolloutPath === 'string' && entry.rolloutPath
  );
}

function normalizeQueueEntry(entry) {
  return {
    threadId: entry.threadId,
    failedTurnId: entry.failedTurnId ?? null,
    rolloutPath: entry.rolloutPath,
    cwd: entry.cwd ?? null,
    failedAt: entry.failedAt ?? null,
    detectedAt: entry.detectedAt ?? null,
    attempts: Math.max(0, Number(entry.attempts) || 0),
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null
  };
}

function compareFailureTime(left, right) {
  return Date.parse(left.failedAt ?? 0) - Date.parse(right.failedAt ?? 0);
}

function sanitizeError(error) {
  return String(error?.message ?? error ?? 'Unknown Codex recovery error').slice(0, 500);
}
