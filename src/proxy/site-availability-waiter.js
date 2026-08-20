const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_MAX_PENDING_REQUESTS = 16;

export class SiteAvailabilityWaiter {
  constructor({
    configService,
    waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    if (!configService) {
      throw new Error('configService is required');
    }
    this.configService = configService;
    this.waitTimeoutMs = normalizePositiveInteger(waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
    this.pollIntervalMs = normalizePositiveInteger(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.maxPendingRequests = normalizePositiveInteger(
      maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS
    );
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = new Set();
  }

  getStatus() {
    return {
      pendingRequests: this.pending.size,
      maxPendingRequests: this.maxPendingRequests,
      waitTimeoutMs: this.waitTimeoutMs
    };
  }

  getDeadlineMs() {
    return this.now() + this.waitTimeoutMs;
  }

  async wait({ abortEmitter = null, deadlineMs = this.getDeadlineMs() } = {}) {
    const state = this.configService.getState();
    if (!state.proxy?.codexRecoveryEnabled) {
      return { reason: 'disabled' };
    }
    if (!hasRecoveryCandidate(state.sites)) {
      return { reason: 'unavailable' };
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return { reason: 'capacity' };
    }
    if (isDisconnected(abortEmitter)) {
      return { reason: 'aborted' };
    }

    const remainingMs = deadlineMs - this.now();
    if (remainingMs <= 0) {
      return { reason: 'timeout' };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimer(timer);
        this.configService.off('changed', onChanged);
        abortEmitter?.off?.('close', onAborted);
        this.pending.delete(finish);
        resolve({ reason });
      };
      const onChanged = () => {
        const currentState = this.configService.getState();
        finish(currentState.proxy?.codexRecoveryEnabled ? 'retry' : 'disabled');
      };
      const onAborted = () => finish('aborted');
      const timer = this.setTimer(
        () => finish(remainingMs <= this.pollIntervalMs ? 'timeout' : 'retry'),
        Math.min(remainingMs, this.pollIntervalMs)
      );
      timer.unref?.();

      this.pending.add(finish);
      this.configService.on('changed', onChanged);
      abortEmitter?.once?.('close', onAborted);
    });
  }

  cancelAll(reason = 'stopped') {
    for (const finish of [...this.pending]) {
      finish(reason);
    }
  }
}

export function hasRecoveryCandidate(sites) {
  return Array.isArray(sites) && sites.some((site) =>
    Boolean(site?.manualEnabled) && (
      Boolean(site.enabled) ||
      Boolean(site.failureDisabled && site.autoRecovery?.enabled)
    )
  );
}

function isDisconnected(emitter) {
  return Boolean(emitter?.destroyed || emitter?.writableEnded);
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}
