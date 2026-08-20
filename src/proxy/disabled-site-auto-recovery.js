import { EventEmitter } from 'node:events';

import { testSiteAvailability } from './site-tester.js';
import { isRequestScopedAvailabilityFailure } from './upstream-error-classification.js';

const DEFAULT_RECOVERY_TEST_CONCURRENCY = 8;
const MAX_RECOVERY_TEST_CONCURRENCY = 16;

export async function recoverDueDisabledSites({
  configService,
  testSite = testSiteAvailability,
  now = new Date(),
  concurrency = DEFAULT_RECOVERY_TEST_CONCURRENCY
}) {
  const dueSites = configService.getDueDisabledAutoRecoverySites(now);
  const testModel = configService.getState().proxy.testModel;
  const outcomes = await runWithConcurrency(
    dueSites,
    normalizeConcurrency(concurrency),
    (site) => runAvailabilityCheck(
      configService,
      site.id,
      () => checkDueSite({
        configService,
        site,
        testSite,
        testModel,
        now
      })
    )
  );

  const recoveredSites = [];
  const failedSites = [];
  const errors = [];
  const skippedSites = [];

  for (const outcome of outcomes) {
    if (outcome.skipped) {
      skippedSites.push(outcome.skipped);
    }
    if (outcome.recovered) {
      recoveredSites.push(outcome.recovered);
    }
    if (outcome.failed) {
      failedSites.push(outcome.failed);
    }
    if (outcome.error) {
      errors.push(outcome.error);
    }
  }

  return {
    checkedSites: dueSites,
    skippedSites,
    recoveredSites,
    failedSites,
    errors
  };
}

function runAvailabilityCheck(configService, siteId, operation) {
  if (typeof configService.runSiteAvailabilityCheck === 'function') {
    return configService.runSiteAvailabilityCheck(siteId, operation);
  }
  return operation();
}

async function checkDueSite({ configService, site, testSite, testModel, now }) {
  const currentState = configService.getState?.();
  if (Array.isArray(currentState?.sites)) {
    const current = currentState.sites.find((candidate) => candidate.id === site.id);
    const nextCheckMs = new Date(current?.autoRecoveryState?.nextCheckAt ?? '').getTime();
    if (
      !current ||
      !current.manualEnabled ||
      !current.failureDisabled ||
      !current.autoRecovery?.enabled ||
      !Number.isFinite(nextCheckMs) ||
      nextCheckMs > new Date(now).getTime()
    ) {
      return { skipped: site };
    }
  }

  let result;

  try {
    result = await testSite(site, { testModel });
  } catch (error) {
    result = {
      ok: false,
      statusCode: error?.statusCode ?? null,
      message: error?.message ?? String(error),
      detail: error?.detail ?? null,
      affectsSiteHealth: true
    };
  }

  if (result?.ok) {
    try {
      const recovered = await configService.recordSiteAutoRecoverySuccess(
        site.id,
        {
          statusCode: result.statusCode,
          message: result.message
        },
        now
      );
      return { recovered };
    } catch (error) {
      return {
        failed: site,
        error: createRecoveryError(site, 'success-persist', error)
      };
    }
  }

  const details = {
    statusCode: result?.statusCode ?? null,
    message: result?.message ?? 'Availability test failed',
    detail: result?.detail ?? null,
    affectsSiteHealth: result?.affectsSiteHealth ?? (
      !isRequestScopedAvailabilityFailure(result ?? {})
    )
  };

  try {
    const failed = await configService.recordSiteAutoRecoveryFailure(site.id, details, now);
    return { failed };
  } catch (error) {
    return {
      failed: site,
      error: createRecoveryError(site, 'failure-persist', error)
    };
  }
}

function createRecoveryError(site, phase, error) {
  return {
    siteId: site.id,
    siteName: site.name,
    phase,
    message: error?.message ?? String(error)
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

function normalizeConcurrency(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0
    ? Math.min(numeric, MAX_RECOVERY_TEST_CONCURRENCY)
    : DEFAULT_RECOVERY_TEST_CONCURRENCY;
}

export class DisabledSiteAutoRecoveryScheduler extends EventEmitter {
  constructor({
    configService,
    testSite = testSiteAvailability,
    intervalMs = 60_000,
    testConcurrency = DEFAULT_RECOVERY_TEST_CONCURRENCY,
    logger = console
  }) {
    super();
    if (!configService) {
      throw new Error('configService is required');
    }

    this.configService = configService;
    this.testSite = testSite;
    this.intervalMs = intervalMs;
    this.testConcurrency = normalizeConcurrency(testConcurrency);
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error?.('Disabled site auto recovery failed:', error));
    }, this.intervalMs);
    this.timer.unref?.();
    this.tick().catch((error) => this.logger.error?.('Disabled site auto recovery failed:', error));
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()) {
    if (this.running) {
      return null;
    }

    this.running = true;
    try {
      const result = await recoverDueDisabledSites({
        configService: this.configService,
        testSite: this.testSite,
        now,
        concurrency: this.testConcurrency
      });

      for (const error of result.errors ?? []) {
        this.logger.warn?.('Disabled site auto recovery could not persist result:', error);
      }

      if (result.checkedSites.length > 0) {
        this.emit('checked', result);
      }
      if (result.recoveredSites.length > 0) {
        this.emit('sites-recovered', result);
      }

      return result;
    } finally {
      this.running = false;
    }
  }
}
