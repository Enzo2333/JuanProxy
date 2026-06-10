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
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error?.('Remote site sync failed:', error));
    }, this.intervalMs);
    this.timer.unref?.();
    this.tick().catch((error) => this.logger.error?.('Remote site sync failed:', error));
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
      const result = await syncDueSites({
        configService: this.configService,
        syncWebsite: this.syncWebsite,
        now
      });

      if (result.checkedSites.length > 0) {
        this.emit('checked', result);
      }
      if (result.syncedSites.length > 0 || result.failedSites.length > 0) {
        this.emit('synced', result);
      }

      return result;
    } finally {
      this.running = false;
    }
  }
}
