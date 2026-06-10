import { EventEmitter } from 'node:events';

import { testSiteAvailability } from './site-tester.js';
import { isRequestScopedAvailabilityFailure } from './upstream-error-classification.js';

export async function recoverDueDisabledSites({
  configService,
  testSite = testSiteAvailability,
  now = new Date()
}) {
  const dueSites = configService.getDueDisabledAutoRecoverySites(now);
  const recoveredSites = [];
  const failedSites = [];

  for (const site of dueSites) {
    const result = await testSite(site);

    if (result.ok) {
      const recovered = await configService.recordSiteAutoRecoverySuccess(
        site.id,
        {
          statusCode: result.statusCode,
          message: result.message
        },
        now
      );
      recoveredSites.push(recovered);
    } else {
      const failed = await configService.recordSiteAutoRecoveryFailure(
        site.id,
        {
          statusCode: result.statusCode,
          message: result.message,
          detail: result.detail,
          affectsSiteHealth: !isRequestScopedAvailabilityFailure(result)
        },
        now
      );
      failedSites.push(failed);
    }
  }

  return {
    checkedSites: dueSites,
    recoveredSites,
    failedSites
  };
}

export class DisabledSiteAutoRecoveryScheduler extends EventEmitter {
  constructor({
    configService,
    testSite = testSiteAvailability,
    intervalMs = 60_000,
    logger = console
  }) {
    super();
    if (!configService) {
      throw new Error('configService is required');
    }

    this.configService = configService;
    this.testSite = testSite;
    this.intervalMs = intervalMs;
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
        now
      });

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
