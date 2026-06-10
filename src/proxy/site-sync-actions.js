import {
  loginAndFetchSiteSync,
  loginAndSwitchSiteGroup
} from './site-sync-service.js';

export async function syncConfiguredSite({
  configService,
  siteId,
  fetchRemoteSync = loginAndFetchSiteSync
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const site = configService.findSite(siteId);
  const result = await fetchRemoteSync({
    sync: site.sync,
    apiKey: site.apiKey
  });
  const syncPatch = {
    ...site.sync,
    ...result.syncPatch,
    remote: {
      ...site.sync.remote,
      ...(result.syncPatch?.remote ?? {})
    }
  };
  const patch = {
    sync: syncPatch
  };

  if (Number.isFinite(result.multiplier) && result.multiplier >= 0) {
    patch.multiplier = result.multiplier;
  }

  await configService.updateSite(siteId, patch);
  return result;
}

export async function syncGroupWebsite({
  configService,
  websiteKey,
  fetchRemoteSync = loginAndFetchSiteSync,
  now = new Date()
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const representativeSite = configService.findGroupSyncRepresentativeSite(websiteKey);
  if (!representativeSite) {
    throw new Error(`Group sync representative site not found: ${websiteKey}`);
  }

  const result = await fetchRemoteSync({
    sync: representativeSite.sync,
    apiKey: representativeSite.apiKey
  });

  if (!result.ok) {
    await configService.recordGroupSyncFailure(
      websiteKey,
      result.error ?? new Error(result.syncPatch?.lastSyncError ?? 'Remote group sync failed'),
      { representativeSiteId: representativeSite.id },
      now
    );
    return {
      ...result,
      website: configService.findGroupSyncWebsite(websiteKey),
      representativeSite,
      affectedSites: []
    };
  }

  const affectedSites = await configService.recordGroupSyncSuccess(
    websiteKey,
    result,
    { representativeSiteId: representativeSite.id },
    now
  );
  return {
    ...result,
    website: configService.findGroupSyncWebsite(websiteKey),
    representativeSite,
    affectedSites
  };
}

export async function syncAllConfiguredSites({
  configService,
  fetchRemoteSync = loginAndFetchSiteSync
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const checkedWebsites = configService.getGroupSyncSettings().websites;
  const syncedSites = [];
  const failedSites = [];
  const syncedWebsites = [];
  const failedWebsites = [];
  const checkedSites = checkedWebsites
    .map((website) => configService.findGroupSyncRepresentativeSite(website.key))
    .filter(Boolean);

  for (const website of checkedWebsites) {
    const representativeSite = configService.findGroupSyncRepresentativeSite(website.key);
    if (!representativeSite) {
      continue;
    }
    try {
      const result = await syncGroupWebsite({
        configService,
        websiteKey: website.key,
        fetchRemoteSync
      });
      if (result.ok) {
        syncedWebsites.push(result.website);
        pushUniqueSites(syncedSites, result.affectedSites);
      } else {
        failedWebsites.push(result.website);
        failedSites.push(configService.findSite(representativeSite.id));
      }
    } catch (error) {
      const failedWebsite = await configService.recordGroupSyncFailure(
        website.key,
        error,
        { representativeSiteId: representativeSite.id }
      );
      failedWebsites.push(failedWebsite);
      failedSites.push(configService.findSite(representativeSite.id));
    }
  }

  return {
    checkedSites,
    syncedSites,
    failedSites,
    checkedWebsites,
    syncedWebsites,
    failedWebsites
  };
}

export async function switchConfiguredSiteGroup({
  configService,
  siteId,
  groupName,
  switchRemoteGroup = loginAndSwitchSiteGroup
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const site = configService.findSite(siteId);
  const normalizedGroupName = String(groupName ?? '').trim();
  if (!normalizedGroupName) {
    throw new Error('groupName is required');
  }

  const groups = Array.isArray(site.sync?.remote?.groups)
    ? site.sync.remote.groups
    : [];
  const selectedGroup = groups.find((group) => group.name === normalizedGroupName);
  if (!selectedGroup) {
    throw new Error(`Synced group not found: ${normalizedGroupName}`);
  }

  const result = await switchRemoteGroup({
    sync: site.sync,
    apiKey: site.apiKey,
    group: selectedGroup
  });

  if (!result.ok) {
    const syncPatch = {
      ...site.sync,
      ...result.syncPatch,
      remote: site.sync.remote
    };
    await configService.updateSite(siteId, {
      sync: syncPatch
    });
    throw result.error ?? new Error(result.syncPatch?.lastSyncError ?? 'Remote group switch failed');
  }

  const nextRemote = {
    ...site.sync.remote,
    ...(result.syncPatch?.remote ?? {}),
    keyGroup: selectedGroup.name,
    groupMultiplier: selectedGroup.multiplier,
    groups: normalizeRemoteGroupsAfterSwitch(
      result.syncPatch?.remote?.groups ?? groups,
      selectedGroup
    )
  };
  const patch = {
    sync: {
      ...site.sync,
      ...result.syncPatch,
      remote: nextRemote
    }
  };

  const nextMultiplier = Number.isFinite(result.multiplier) && result.multiplier >= 0
    ? result.multiplier
    : selectedGroup.multiplier;
  if (Number.isFinite(nextMultiplier) && nextMultiplier >= 0) {
    patch.multiplier = nextMultiplier;
  }

  return configService.updateSite(siteId, patch);
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

function normalizeRemoteGroupsAfterSwitch(groups, selectedGroup) {
  const selectedId = String(selectedGroup.id ?? '').trim();
  const selectedName = String(selectedGroup.name ?? '').trim();
  const list = Array.isArray(groups) ? groups : [];
  const nextGroups = list.map((group) => ({
    ...group,
    selected: Boolean(
      (selectedId && String(group.id ?? '').trim() === selectedId) ||
        group.name === selectedName
    )
  }));
  return nextGroups;
}
