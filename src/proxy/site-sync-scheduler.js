import { EventEmitter } from 'node:events';

import { syncGroupWebsite } from './site-sync-actions.js';

export async function syncDueSites({
  configService,
  syncSite,
  syncWebsite,
  now = new Date(),
  includePreheat = true,
  preheatCandidateLimit
}) {
  return syncDueGroupWebsites({
    configService,
    syncWebsite: syncWebsite ?? createSyncWebsiteAdapter(syncSite),
    now,
    includePreheat,
    preheatCandidateLimit
  });
}

export async function syncDueGroupWebsites({
  configService,
  syncWebsite = syncGroupWebsite,
  now = new Date(),
  includePreheat = true,
  preheatCandidateLimit
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const dueWebsites = configService.getDueGroupSyncWebsites(now);
  if (!includePreheat) {
    return syncWebsiteList({
      configService,
      syncWebsite,
      websites: dueWebsites
    });
  }

  const dueWebsiteKeys = new Set(dueWebsites.map((website) => website.key));
  const preheatWebsites = configService.getLikelyGroupSyncWebsites(now, {
    limit: preheatCandidateLimit
  }).filter((website) => !dueWebsiteKeys.has(website.key));

  return syncWebsiteList({
    configService,
    syncWebsite,
    websites: [...dueWebsites, ...preheatWebsites]
  });
}

export async function syncLikelySiteSyncSites({
  configService,
  syncSite,
  syncWebsite,
  now = new Date(),
  preheatCandidateLimit,
  excludeSiteIds
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const likelyWebsites = configService.getLikelyGroupSyncWebsites(now, {
    limit: preheatCandidateLimit,
    excludeSiteIds
  });
  return syncWebsiteList({
    configService,
    syncWebsite: syncWebsite ?? createSyncWebsiteAdapter(syncSite),
    websites: likelyWebsites
  });
}

async function syncWebsiteList({
  configService,
  syncWebsite,
  websites
}) {
  const checkedSites = [];
  const syncedSites = [];
  const failedSites = [];
  const syncedWebsites = [];
  const failedWebsites = [];

  for (const website of websites) {
    const representativeSite = configService.findGroupSyncRepresentativeSite(website.key);
    if (representativeSite) {
      checkedSites.push(representativeSite);
    }
    const result = await syncWebsite({
      configService,
      websiteKey: website.key
    });

    if (result?.ok) {
      syncedWebsites.push(result.website ?? website);
      pushUniqueSites(syncedSites, result.affectedSites ?? (representativeSite ? [representativeSite] : []));
    } else {
      failedWebsites.push(result?.website ?? website);
      if (representativeSite) {
        failedSites.push(representativeSite);
      }
    }
  }

  return {
    checkedSites,
    syncedSites,
    failedSites,
    checkedWebsites: websites,
    syncedWebsites,
    failedWebsites
  };
}

function createSyncWebsiteAdapter(syncSite) {
  if (!syncSite) {
    return syncGroupWebsite;
  }
  return async ({ configService, websiteKey }) => {
    const representativeSite = configService.findGroupSyncRepresentativeSite(websiteKey);
    const result = await syncSite({
      configService,
      siteId: representativeSite?.id,
      websiteKey
    });
    return {
      ...result,
      website: configService.findGroupSyncWebsite(websiteKey),
      representativeSite,
      affectedSites: representativeSite ? [representativeSite] : []
    };
  };
}

function pushUniqueSites(target, sites = []) {
  const seen = new Set(target.map((site) => site.id));
  for (const site of sites) {
    if (!site?.id || seen.has(site.id)) {
      continue;
    }
    seen.add(site.id);
    target.push(site);
  }
}

export class SiteSyncScheduler extends EventEmitter {
  constructor({
    configService,
    syncSite,
    syncWebsite,
    intervalMs = 60_000,
    logger = console
  }) {
    super();
    if (!configService) {
      throw new Error('configService is required');
    }

    this.configService = configService;
    this.syncWebsite = syncWebsite ?? createSyncWebsiteAdapter(syncSite);
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.startedAt = null;
    this.lastCheckStartedAt = null;
    this.lastCheckCompletedAt = null;
    this.nextCheckAt = null;
    this.lastResultSummary = {
      checkedWebsiteCount: 0,
      syncedWebsiteCount: 0,
      failedWebsiteCount: 0
    };
  }

  start() {
    if (this.timer) {
      return;
    }

    const startedAt = new Date();
    this.startedAt = startedAt.toISOString();
    this.nextCheckAt = new Date(startedAt.getTime() + this.intervalMs).toISOString();
    this.timer = setInterval(() => {
      const now = new Date();
      this.nextCheckAt = new Date(now.getTime() + this.intervalMs).toISOString();
      this.tick(now).catch((error) => this.logger.error?.('Remote site sync failed:', error));
    }, this.intervalMs);
    this.timer.unref?.();
    this.emit('status-changed', this.getStatus());
    this.tick(startedAt).catch((error) => this.logger.error?.('Remote site sync failed:', error));
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    this.emit('status-changed', this.getStatus());
  }

  getStatus() {
    return {
      monitoring: Boolean(this.timer),
      checking: this.running,
      intervalMs: this.intervalMs,
      startedAt: this.startedAt,
      lastCheckStartedAt: this.lastCheckStartedAt,
      lastCheckCompletedAt: this.lastCheckCompletedAt,
      nextCheckAt: this.nextCheckAt,
      ...this.lastResultSummary
    };
  }

  async tick(now = new Date()) {
    if (this.running) {
      return null;
    }

    this.running = true;
    const checkedAt = new Date(now);
    this.lastCheckStartedAt = Number.isFinite(checkedAt.getTime()) ? checkedAt.toISOString() : null;
    this.emit('status-changed', this.getStatus());
    try {
      const result = await syncDueSites({
        configService: this.configService,
        syncWebsite: this.syncWebsite,
        now
      });
      this.lastResultSummary = {
        checkedWebsiteCount: result.checkedWebsites.length,
        syncedWebsiteCount: result.syncedWebsites.length,
        failedWebsiteCount: result.failedWebsites.length
      };

      if (result.checkedSites.length > 0) {
        this.emit('checked', result);
      }
      if (result.syncedSites.length > 0 || result.failedSites.length > 0) {
        this.emit('synced', result);
      }

      return result;
    } finally {
      this.lastCheckCompletedAt = this.lastCheckStartedAt;
      this.running = false;
      this.emit('status-changed', this.getStatus());
    }
  }
}
