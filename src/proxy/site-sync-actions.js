import {
  loginAndCreateSiteKey,
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

  if (shouldUpdateSiteMultiplier(site, result.multiplier)) {
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

  const candidates = configService.getGroupSyncWebsiteSites(websiteKey);
  let lastFailure = null;
  let lastRepresentativeSite = representativeSite;

  for (const candidate of candidates) {
    const result = await fetchRemoteSync({
      sync: candidate.sync,
      apiKey: candidate.apiKey
    });

    if (!result.ok) {
      lastFailure = result;
      lastRepresentativeSite = candidate;
      continue;
    }

    const affectedSites = await configService.recordGroupSyncSuccess(
      websiteKey,
      result,
      { representativeSiteId: candidate.id },
      now
    );
    return {
      ...result,
      website: configService.findGroupSyncWebsite(websiteKey),
      representativeSite: candidate,
      affectedSites
    };
  }

  if (lastFailure) {
    await configService.recordGroupSyncFailure(
      websiteKey,
      lastFailure.error ??
        new Error(lastFailure.syncPatch?.lastSyncError ?? 'Remote group sync failed'),
      { representativeSiteId: lastRepresentativeSite.id },
      now
    );
    return {
      ...lastFailure,
      website: configService.findGroupSyncWebsite(websiteKey),
      representativeSite: lastRepresentativeSite,
      affectedSites: []
    };
  }

  throw new Error(`Group sync representative site not found: ${websiteKey}`);
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

export async function createConfiguredSiteKey({
  configService,
  siteId,
  createRemoteKey = loginAndCreateSiteKey
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const site = configService.findSite(siteId);
  const result = await createRemoteKey({
    sync: site.sync,
    name: site.name || 'JuanProxy sync'
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

  if (result.ok && result.apiKey) {
    patch.apiKey = result.apiKey;
  }
  if (shouldUpdateSiteMultiplier(site, result.multiplier)) {
    patch.multiplier = result.multiplier;
  }

  await configService.updateSite(siteId, patch);
  return result;
}

export async function switchConfiguredSiteGroup({
  configService,
  siteId,
  groupName,
  groupId,
  switchRemoteGroup = loginAndSwitchSiteGroup
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const site = configService.findSite(siteId);
  const normalizedGroupName = String(groupName ?? '').trim();
  const normalizedGroupId = String(groupId ?? '').trim();
  if (!normalizedGroupName && !normalizedGroupId) {
    throw new Error('groupName or groupId is required');
  }

  const groups = Array.isArray(site.sync?.remote?.groups)
    ? site.sync.remote.groups
    : [];
  const selectedGroup = groups.find((group) =>
    (normalizedGroupId && String(group.id ?? '').trim() === normalizedGroupId) ||
    (normalizedGroupName && group.name === normalizedGroupName)
  ) ?? (
    normalizedGroupId
      ? {
          id: normalizedGroupId,
          name: normalizedGroupName || normalizedGroupId,
          multiplier: null,
          selected: true
        }
      : null
  );
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

  const nextRemotePatch = result.syncPatch?.remote ?? {};
  const nextGroupId = pickFirstString(nextRemotePatch.groupId, selectedGroup.id, site.sync.remote.groupId);
  const nextKeyGroup = pickFirstString(nextRemotePatch.keyGroup, selectedGroup.name, site.sync.remote.keyGroup);
  const nextGroups = normalizeRemoteGroupsAfterSwitch(
    nextRemotePatch.groups ?? groups,
    {
      ...selectedGroup,
      id: nextGroupId,
      name: nextKeyGroup
    }
  );
  const nextRemote = {
    ...site.sync.remote,
    ...nextRemotePatch,
    keyGroup: nextKeyGroup,
    groupId: nextGroupId,
    groupMultiplier: Number.isFinite(result.multiplier) && result.multiplier >= 0
      ? result.multiplier
      : Number.isFinite(selectedGroup.multiplier)
        ? selectedGroup.multiplier
        : nextRemotePatch.groupMultiplier,
    groups: nextGroups
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
  if (shouldUpdateSiteMultiplier(site, nextMultiplier)) {
    patch.multiplier = nextMultiplier;
  }

  return configService.updateSite(siteId, patch);
}

function shouldUpdateSiteMultiplier(site, multiplier) {
  return !site?.multiplierLocked && Number.isFinite(multiplier) && multiplier >= 0;
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

function pickFirstString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return '';
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
