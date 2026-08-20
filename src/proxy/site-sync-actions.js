import {
  loginAndCreateSiteKey,
  loginAndDeleteSiteKey,
  loginAndFetchSiteSync,
  loginAndSwitchSiteGroup,
  logoutRemoteAccountSession
} from './site-sync-service.js';
import { testSiteAvailability } from './site-tester.js';
import {
  calculateEffectiveMultiplier,
  isRateLimitPaused,
  isUsableSite
} from './switching-policy.js';

const remoteAccountOperationQueues = new WeakMap();
const autoProvisionQueues = new WeakMap();

export async function syncConfiguredSite({
  configService,
  siteId,
  fetchRemoteSync = loginAndFetchSiteSync,
  resolveTurnstileToken,
  resolveBrowserSession
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const { site, result } = await runRemoteAccountOperation({
    configService,
    siteId,
    operation: ({ site: currentSite, authSession, accountSites }) => fetchRemoteSync({
      sync: currentSite.sync,
      apiKey: currentSite.apiKey,
      targetSiteId: currentSite.id,
      targets: accountSites.map((candidate) => ({
        siteId: candidate.id,
        apiKey: candidate.apiKey
      })),
      authSession,
      resolveTurnstileToken,
      resolveBrowserSession
    })
  });
  if (result.accountSync?.siteResults && typeof configService.applyRemoteAccountSyncResults === 'function') {
    await configService.applyRemoteAccountSyncResults(siteId, result);
    return result;
  }

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

export async function logoutConfiguredSiteAccount({
  configService,
  siteId,
  logoutRemoteAccount = logoutRemoteAccountSession
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const { result } = await runRemoteAccountOperation({
    configService,
    siteId,
    operation: ({ site, authSession }) => logoutRemoteAccount({
      sync: site.sync,
      authSession
    })
  });
  if (result.ok) {
    await configService.clearRemoteAccountSession(siteId, { loggedOut: true });
  }
  return result;
}

export async function syncGroupWebsite({
  configService,
  websiteKey,
  fetchRemoteSync = loginAndFetchSiteSync,
  createRemoteKey = loginAndCreateSiteKey,
  deleteRemoteKey = loginAndDeleteSiteKey,
  testSite = testSiteAvailability,
  resolveTurnstileToken,
  resolveBrowserSession,
  onActivity,
  trigger = 'manual',
  now = new Date()
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const candidates = configService.getGroupSyncWebsiteSites(websiteKey);
  if (!candidates.length) {
    throw new Error(`Group sync representative site not found: ${websiteKey}`);
  }

  await emitActivity(onActivity, {
    category: 'sync',
    type: 'sync-started',
    status: 'running',
    message: `开始刷新分组信息（${trigger === 'scheduled' ? '自动监控' : '手动刷新'}）`,
    websiteKey,
    trigger
  });

  const accountGroups = groupSitesByAccount(candidates);
  const accountResults = [];
  const affectedSites = [];
  for (const accountSites of accountGroups) {
    const representativeSite = accountSites[0];
    let result;
    try {
      const operationResult = await runRemoteAccountOperation({
        configService,
        siteId: representativeSite.id,
        operation: ({ site: currentSite, authSession, accountSites: refreshedAccountSites }) => fetchRemoteSync({
          sync: currentSite.sync,
          apiKey: currentSite.apiKey,
          targetSiteId: currentSite.id,
          targets: refreshedAccountSites.map((candidate) => ({
            siteId: candidate.id,
            apiKey: candidate.apiKey
          })),
          authSession,
          resolveTurnstileToken,
          resolveBrowserSession
        })
      });
      result = operationResult.result;
    } catch (error) {
      result = {
        ok: false,
        syncPatch: {
          lastSyncStatus: 'failure',
          lastSyncError: error.message || String(error)
        },
        error
      };
    }
    const effectiveResult = normalizeAccountSyncResult(result);
    const targetResults = effectiveResult.accountSync?.siteResults ?? [];
    const accountOk = Boolean(effectiveResult.ok && targetResults.every((target) => target.ok));
    let accountAffectedSites = [];

    if (effectiveResult.ok || targetResults.some((target) => target.ok)) {
      // Keep website-level status/group metadata current, then reapply the
      // per-key results so a missing key remains a failure for that site only.
      const recordedSites = await configService.recordGroupSyncSuccess(
        websiteKey,
        effectiveResult,
        {
          // Older injected sync adapters return one website-level result. The
          // production service returns per-key results and enables account
          // isolation for that path.
          ...(targetResults.length ? { accountId: representativeSite.sync?.accountId } : {}),
          representativeSiteId: representativeSite.id
        },
        now
      );
      if (targetResults.length && typeof configService.applyRemoteAccountSyncResults === 'function') {
        accountAffectedSites = await configService.applyRemoteAccountSyncResults(
          representativeSite.id,
          effectiveResult,
          now
        );
      } else {
        accountAffectedSites = recordedSites ?? [];
      }

      let provisionResult = null;
      if (accountOk) {
        try {
          provisionResult = await provisionMissingLowMultiplierGroup({
            configService,
            siteId: representativeSite.id,
            syncResult: effectiveResult,
            createRemoteKey,
            deleteRemoteKey,
            testSite,
            resolveTurnstileToken,
            resolveBrowserSession,
            websiteKey,
            onActivity,
            trigger,
            now
          });
        } catch (error) {
          provisionResult = { ok: false, skipped: false, error };
        }
      }
      accountResults.push({
        accountId: representativeSite.sync?.accountId ?? '',
        representativeSite,
        ok: accountOk,
        result: effectiveResult,
        provisionResult,
        affectedSites: accountAffectedSites
      });
    } else {
      await configService.recordGroupSyncFailure(
        websiteKey,
        effectiveResult.error ??
          new Error(effectiveResult.syncPatch?.lastSyncError ?? 'Remote group sync failed'),
        {
          ...(targetResults.length ? { accountId: representativeSite.sync?.accountId } : {}),
          representativeSiteId: representativeSite.id
        },
        now
      );
      accountResults.push({
        accountId: representativeSite.sync?.accountId ?? '',
        representativeSite,
        ok: false,
        result: effectiveResult,
        provisionResult: null,
        affectedSites: accountAffectedSites
      });
    }

    pushUniqueSites(affectedSites, accountAffectedSites);
  }

  const successfulAccounts = accountResults.filter((entry) => entry.ok);
  const representative = successfulAccounts[0]?.representativeSite ?? accountResults[0].representativeSite;
  const firstResult = successfulAccounts[0]?.result ?? accountResults[0].result;
  const output = {
    ...firstResult,
    ok: accountResults.length > 0 && accountResults.some((entry) => entry.ok),
    website: configService.findGroupSyncWebsite(websiteKey),
    representativeSite: representative,
    affectedSites,
    accountResults
  };
  await emitActivity(onActivity, {
    category: 'sync',
    type: output.ok ? 'sync-completed' : 'sync-failed',
    status: output.ok ? 'success' : 'failure',
    message: output.ok
      ? `分组刷新完成：${successfulAccounts.length} 个账号成功，发现 ${output.website?.groups?.length ?? 0} 个分组`
      : '分组刷新失败',
    websiteKey,
    trigger,
    checkedAccountCount: accountResults.length,
    successfulAccountCount: successfulAccounts.length,
    failedAccountCount: accountResults.length - successfulAccounts.length,
    groupCount: output.website?.groups?.length ?? 0
  });
  return output;
}

export async function syncAllConfiguredSites({
  configService,
  fetchRemoteSync = loginAndFetchSiteSync,
  resolveTurnstileToken,
  resolveBrowserSession,
  onActivity,
  trigger = 'manual'
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
        fetchRemoteSync,
        resolveTurnstileToken,
        resolveBrowserSession,
        onActivity,
        trigger
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
  name,
  createRemoteKey = loginAndCreateSiteKey,
  deleteRemoteKey = loginAndDeleteSiteKey,
  resolveTurnstileToken,
  resolveBrowserSession
}) {
  if (!configService) {
    throw new Error('configService is required');
  }

  const { site, result } = await runRemoteAccountOperation({
    configService,
    siteId,
    operation: ({ site: currentSite, authSession }) => createRemoteKey({
      sync: currentSite.sync,
      name: name || currentSite.name || 'JuanProxy sync',
      authSession,
      resolveTurnstileToken,
      resolveBrowserSession
    })
  });
  const syncPatch = {
    ...site.sync,
    ...result.syncPatch,
    remote: {
      ...site.sync.remote,
      ...(result.syncPatch?.remote ?? {})
    }
  };
  if (result.ok && result.apiKey) {
    try {
      const createdSite = await configService.addSite({
        name: buildCreatedSiteName(configService, result.keyName || site.name),
        remark: site.remark,
        baseUrl: site.baseUrl,
        apiKey: result.apiKey,
        priority: site.priority,
        multiplier: shouldUpdateSiteMultiplier(site, result.multiplier)
          ? result.multiplier
          : site.multiplier,
        customMultiplier: site.customMultiplier,
        multiplierLocked: site.multiplierLocked,
        modelMapping: site.modelMapping,
        capabilities: site.capabilities,
        sync: syncPatch,
        rateLimit: site.rateLimit,
        autoRecovery: site.autoRecovery,
        manualEnabled: site.manualEnabled,
        failureDisabled: false
      });
      return {
        ...result,
        createdSiteId: createdSite.id,
        createdSite
      };
    } catch (error) {
      await rollbackCreatedRemoteKey({
        deleteRemoteKey,
        site,
        result,
        authSession: result.authSession,
        resolveTurnstileToken,
        resolveBrowserSession
      });
      throw error;
    }
  }

  await configService.updateSite(siteId, { sync: syncPatch });
  return result;
}

export async function provisionMissingLowMultiplierGroup({
  configService,
  siteId,
  syncResult,
  createRemoteKey = loginAndCreateSiteKey,
  deleteRemoteKey = loginAndDeleteSiteKey,
  testSite = testSiteAvailability,
  resolveTurnstileToken,
  resolveBrowserSession,
  websiteKey = '',
  onActivity,
  trigger = 'scheduled',
  now = new Date()
}) {
  if (!configService) {
    throw new Error('configService is required');
  }
  const site = configService.findSite(siteId);
  const accountId = String(site.sync?.accountId ?? '').trim();
  const limit = configService.getState().proxy.autoSwitchMultiplierLimit;
  if (!accountId || !limit?.enabled) {
    return { ok: true, skipped: true, reason: 'auto-provision-disabled' };
  }

  return runAutoProvisionOperation(configService, accountId, async () => {
    const currentSite = configService.findSite(siteId);
    const accountSites = configService.getRemoteAccountSites?.(siteId) ?? [currentSite];
    const lowestAvailableMultiplier = findLowestAvailableMultiplier(
      configService.getState().sites,
      now
    );
    const candidate = findMissingLowMultiplierGroup({
      sites: accountSites,
      syncResult,
      maxMultiplier: limit.maxMultiplier
    });
    if (!candidate) {
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'no-candidate',
        status: 'skipped',
        message: '未发现符合自动导入条件的缺失分组',
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        currentLowestMultiplier: lowestAvailableMultiplier
      }));
      return { ok: true, skipped: true, reason: 'no-missing-group' };
    }

    const candidateEffectiveMultiplier = calculateCandidateEffectiveMultiplier(currentSite, candidate);
    if (
      Number.isFinite(lowestAvailableMultiplier) &&
      !(candidateEffectiveMultiplier < lowestAvailableMultiplier)
    ) {
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'not-beneficial',
        status: 'skipped',
        message: `候选分组倍率 ${formatActivityMultiplier(candidateEffectiveMultiplier)}x 不低于当前最低 ${formatActivityMultiplier(lowestAvailableMultiplier)}x，本次跳过`,
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate,
        candidateMultiplier: candidateEffectiveMultiplier,
        currentLowestMultiplier: lowestAvailableMultiplier
      }));
      return { ok: true, skipped: true, reason: 'not-beneficial', group: candidate };
    }

    const existingAttempt = configService.getAutoProvisionAttempt?.(accountId, candidate.id);
    const nowMs = new Date(now).getTime();
    const nextAttemptMs = existingAttempt?.nextAttemptAt
      ? new Date(existingAttempt.nextAttemptAt).getTime()
      : null;
    if (Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs) {
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'cooldown',
        status: 'skipped',
        message: `分组“${candidate.name}”仍在失败冷却期内，暂不重试`,
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate,
        nextAttemptAt: existingAttempt.nextAttemptAt
      }));
      return {
        ok: true,
        skipped: true,
        reason: 'cooldown',
        group: candidate,
        nextAttemptAt: existingAttempt.nextAttemptAt
      };
    }

    await emitActivity(onActivity, buildProvisionActivity({
      type: 'candidate-found',
      status: 'running',
      message: `发现更低倍率分组“${candidate.name}”（${formatActivityMultiplier(candidateEffectiveMultiplier)}x），开始创建密钥`,
      site: currentSite,
      accountId,
      websiteKey,
      trigger,
      group: candidate,
      candidateMultiplier: candidateEffectiveMultiplier,
      currentLowestMultiplier: Number.isFinite(lowestAvailableMultiplier)
        ? lowestAvailableMultiplier
        : null
    }));

    const createSync = {
      ...currentSite.sync,
      remote: {
        ...currentSite.sync.remote,
        keyGroup: candidate.name,
        groupId: candidate.id
      }
    };
    let result;
    try {
      ({ result } = await runRemoteAccountOperation({
        configService,
        siteId,
        operation: ({ authSession }) => createRemoteKey({
          sync: createSync,
          name: buildAutoProvisionKeyName(currentSite, candidate),
          authSession,
          resolveTurnstileToken,
          resolveBrowserSession
        })
      }));
    } catch (error) {
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'create-failed',
        status: 'failure',
        message: '远端密钥创建出现异常，本次自动导入已停止',
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate
      }));
      await configService.recordAutoProvisionAttempt?.({
        accountId,
        groupId: candidate.id,
        groupName: candidate.name,
        status: 'failure',
        error: error.message,
        now
      });
      return { ok: false, skipped: false, group: candidate, error };
    }

    if (!result.ok || !result.apiKey) {
      const rolledBack = await rollbackCreatedRemoteKey({
        deleteRemoteKey,
        site: currentSite,
        result,
        authSession: result.authSession,
        resolveTurnstileToken,
        resolveBrowserSession
      });
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'create-failed',
        status: 'failure',
        message: result.error?.message ?? result.syncPatch?.lastSyncError ?? '远端密钥创建失败，已跳过导入',
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate,
        rolledBack
      }));
      await configService.recordAutoProvisionAttempt?.({
        accountId,
        groupId: candidate.id,
        groupName: candidate.name,
        status: 'failure',
        error: result.error?.message ?? result.syncPatch?.lastSyncError ?? 'Remote key creation failed',
        now
      });
      return { ok: false, skipped: false, group: candidate, result };
    }

    const syncPatch = {
      ...currentSite.sync,
      ...result.syncPatch,
      remote: {
        ...createSync.remote,
        ...(result.syncPatch?.remote ?? {}),
        keyGroup: candidate.name,
        groupId: candidate.id,
        groups: currentSite.sync.remote.groups
      }
    };
    const temporarySite = {
      ...currentSite,
      name: buildAutoProvisionKeyName(currentSite, candidate),
      apiKey: result.apiKey,
      multiplier: shouldUpdateSiteMultiplier(currentSite, result.multiplier)
        ? result.multiplier
        : candidate.multiplier,
      sync: syncPatch,
      manualEnabled: true,
      failureDisabled: false
    };
    await emitActivity(onActivity, buildProvisionActivity({
      type: 'key-created',
      status: 'running',
      message: `远端密钥已创建，开始测试模型“${configService.getState().proxy.testModel}”`,
      site: currentSite,
      accountId,
      websiteKey,
      trigger,
      group: candidate,
      candidateMultiplier: candidateEffectiveMultiplier
    }));
    let testResult;
    try {
      testResult = await testSite(temporarySite, {
        testModel: configService.getState().proxy.testModel,
        timeoutMs: Math.min(configService.getProxyTimeoutMs?.() ?? 30000, 30000)
      });
    } catch (error) {
      const rolledBack = await rollbackCreatedRemoteKey({
        deleteRemoteKey,
        site: currentSite,
        result,
        authSession: result.authSession,
        resolveTurnstileToken,
        resolveBrowserSession
      });
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'test-failed',
        status: 'failure',
        message: '模型测试出现异常，已执行远端密钥回滚',
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate,
        rolledBack
      }));
      await configService.recordAutoProvisionAttempt?.({
        accountId,
        groupId: candidate.id,
        groupName: candidate.name,
        status: 'failure',
        error: error.message,
        now
      });
      return { ok: false, skipped: false, group: candidate, result, error };
    }
    if (!testResult?.ok) {
      const rolledBack = await rollbackCreatedRemoteKey({
        deleteRemoteKey,
        site: currentSite,
        result,
        authSession: result.authSession,
        resolveTurnstileToken,
        resolveBrowserSession
      });
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'test-failed',
        status: 'failure',
        message: testResult?.message ?? '模型测试失败，已删除远端密钥',
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate,
        rolledBack
      }));
      await configService.recordAutoProvisionAttempt?.({
        accountId,
        groupId: candidate.id,
        groupName: candidate.name,
        status: 'failure',
        error: testResult?.message ?? 'Availability test failed',
        now
      });
      return { ok: false, skipped: false, group: candidate, result, testResult };
    }

    await emitActivity(onActivity, buildProvisionActivity({
      type: 'test-passed',
      status: 'running',
      message: '模型测试通过，正在导入站点配置',
      site: currentSite,
      accountId,
      websiteKey,
      trigger,
      group: candidate,
      candidateMultiplier: candidateEffectiveMultiplier
    }));

    try {
      const importedSite = await configService.addSite({
        ...temporarySite,
        name: buildCreatedSiteName(configService, temporarySite.name)
      });
      await configService.recordAutoProvisionAttempt?.({
        accountId,
        groupId: candidate.id,
        groupName: candidate.name,
        status: 'success',
        error: null,
        now
      });
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'imported',
        status: 'success',
        message: `已导入并启用“${importedSite.name}”`,
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate,
        candidateMultiplier: candidateEffectiveMultiplier,
        createdSiteId: importedSite.id
      }));
      return {
        ok: true,
        skipped: false,
        group: candidate,
        result,
        testResult,
        createdSiteId: importedSite.id,
        createdSite: importedSite
      };
    } catch (error) {
      const rolledBack = await rollbackCreatedRemoteKey({
        deleteRemoteKey,
        site: currentSite,
        result,
        authSession: result.authSession,
        resolveTurnstileToken,
        resolveBrowserSession
      });
      await emitActivity(onActivity, buildProvisionActivity({
        type: 'import-failed',
        status: 'failure',
        message: '站点配置导入失败，已执行远端密钥回滚',
        site: currentSite,
        accountId,
        websiteKey,
        trigger,
        group: candidate,
        rolledBack
      }));
      await configService.recordAutoProvisionAttempt?.({
        accountId,
        groupId: candidate.id,
        groupName: candidate.name,
        status: 'failure',
        error: error.message,
        now
      });
      throw error;
    }
  });
}

function groupSitesByAccount(sites) {
  const groups = new Map();
  for (const site of sites) {
    const accountKey = String(site.sync?.accountId ?? '').trim() || `site:${site.id}`;
    const list = groups.get(accountKey) ?? [];
    list.push(site);
    groups.set(accountKey, list);
  }
  return [...groups.values()];
}

function normalizeAccountSyncResult(result = {}) {
  const siteResults = Array.isArray(result.accountSync?.siteResults)
    ? result.accountSync.siteResults
    : [];
  if (!siteResults.length) {
    return result;
  }
  const successful = siteResults.find((target) => target.ok && target.remote);
  if (!successful) {
    return result;
  }
  return {
    ...result,
    syncPatch: {
      ...result.syncPatch,
      remote: successful.remote
    },
    multiplier: successful.multiplier ?? result.multiplier
  };
}

function findMissingLowMultiplierGroup({
  sites = [],
  syncResult,
  maxMultiplier
}) {
  const site = sites[0];
  const groups = Array.isArray(syncResult?.syncPatch?.remote?.groups)
    ? syncResult.syncPatch.remote.groups
    : Array.isArray(site.sync?.remote?.groups)
      ? site.sync.remote.groups
      : [];
  const configured = new Set();
  for (const candidate of sites) {
    const remote = candidate.sync?.remote ?? {};
    const groupId = String(remote.groupId ?? '').trim();
    const groupName = String(remote.keyGroup ?? '').trim();
    if (groupId) configured.add(`id:${groupId}`);
    if (groupName) configured.add(`name:${groupName}`);
  }
  const limitValue = Number(maxMultiplier);
  return groups
    .map((group) => ({
      id: String(group?.id ?? group?.key ?? group?.value ?? group?.name ?? '').trim(),
      name: String(group?.name ?? group?.groupName ?? group?.group_name ?? '').trim(),
      multiplier: Number(group?.multiplier)
    }))
    .filter((group) =>
      group.id && group.name && Number.isFinite(group.multiplier) && group.multiplier >= 0 &&
      (!Number.isFinite(limitValue) || group.multiplier <= limitValue) &&
      !configured.has(`id:${group.id}`) && !configured.has(`name:${group.name}`)
    )
    .sort((left, right) => left.multiplier - right.multiplier || left.name.localeCompare(right.name))[0] ?? null;
}

function findLowestAvailableMultiplier(sites = [], now = new Date()) {
  let lowest = Infinity;
  for (const site of sites) {
    if (!isUsableSite(site) || isRateLimitPaused(site, now)) {
      continue;
    }
    const multiplier = calculateEffectiveMultiplier(site);
    if (Number.isFinite(multiplier) && multiplier >= 0) {
      lowest = Math.min(lowest, multiplier);
    }
  }
  return lowest;
}

function calculateCandidateEffectiveMultiplier(site, group) {
  return calculateEffectiveMultiplier({
    ...site,
    multiplier: group.multiplier,
    sync: {
      ...site?.sync,
      remote: {
        ...site?.sync?.remote,
        groupMultiplier: group.multiplier
      }
    }
  });
}

function buildProvisionActivity({
  type,
  status,
  message,
  site,
  accountId,
  websiteKey,
  trigger,
  group,
  candidateMultiplier,
  currentLowestMultiplier,
  nextAttemptAt,
  createdSiteId,
  rolledBack = false
}) {
  return {
    category: 'auto-provision',
    type,
    status,
    message,
    siteId: site?.id ?? null,
    siteName: site?.name ?? null,
    accountId,
    websiteKey: websiteKey || null,
    trigger,
    groupId: group?.id ?? null,
    groupName: group?.name ?? null,
    groupMultiplier: Number.isFinite(group?.multiplier) ? group.multiplier : null,
    candidateMultiplier: Number.isFinite(candidateMultiplier) ? candidateMultiplier : null,
    currentLowestMultiplier: Number.isFinite(currentLowestMultiplier)
      ? currentLowestMultiplier
      : null,
    nextAttemptAt: nextAttemptAt ?? null,
    createdSiteId: createdSiteId ?? null,
    rolledBack
  };
}

function formatActivityMultiplier(value) {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return Number(value.toPrecision(12)).toString();
}

async function emitActivity(onActivity, event) {
  if (typeof onActivity !== 'function') {
    return;
  }
  try {
    await onActivity(event);
  } catch {
    // Activity logging must never interrupt synchronization or provisioning.
  }
}

function buildAutoProvisionKeyName(site, group) {
  return `${site.name || 'JuanProxy'} - ${group.name}`.slice(0, 120);
}

async function rollbackCreatedRemoteKey({
  deleteRemoteKey,
  site,
  result,
  authSession,
  resolveTurnstileToken,
  resolveBrowserSession
}) {
  const remoteKeyId = result?.syncPatch?.remote?.remoteKeyId ?? result?.remoteKeyId;
  if (!remoteKeyId || typeof deleteRemoteKey !== 'function') {
    return false;
  }
  try {
    const deleteResult = await deleteRemoteKey({
      sync: site.sync,
      apiKey: result.apiKey,
      remoteKeyId,
      authSession,
      resolveTurnstileToken,
      resolveBrowserSession
    });
    return deleteResult?.ok === true;
  } catch {
    // Preserve the local failure while allowing the caller to continue.
    return false;
  }
}

function runAutoProvisionOperation(configService, accountId, operation) {
  let queues = autoProvisionQueues.get(configService);
  if (!queues) {
    queues = new Map();
    autoProvisionQueues.set(configService, queues);
  }
  const previous = queues.get(accountId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  queues.set(accountId, run);
  return run.finally(() => {
    if (queues.get(accountId) === run) {
      queues.delete(accountId);
    }
  });
}

export async function switchConfiguredSiteGroup({
  configService,
  siteId,
  groupName,
  groupId,
  switchRemoteGroup = loginAndSwitchSiteGroup,
  resolveTurnstileToken,
  resolveBrowserSession
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

  const { site: currentSite, result } = await runRemoteAccountOperation({
    configService,
    siteId,
    operation: ({ site: lockedSite, authSession }) => switchRemoteGroup({
      sync: lockedSite.sync,
      apiKey: lockedSite.apiKey,
      group: selectedGroup,
      authSession,
      resolveTurnstileToken,
      resolveBrowserSession
    })
  });

  if (!result.ok) {
    const syncPatch = {
      ...currentSite.sync,
      ...result.syncPatch,
      remote: currentSite.sync.remote
    };
    await configService.updateSite(siteId, {
      sync: syncPatch
    });
    throw result.error ?? new Error(result.syncPatch?.lastSyncError ?? 'Remote group switch failed');
  }

  const nextRemotePatch = result.syncPatch?.remote ?? {};
  const nextGroupId = pickFirstString(nextRemotePatch.groupId, selectedGroup.id, currentSite.sync.remote.groupId);
  const nextKeyGroup = pickFirstString(nextRemotePatch.keyGroup, selectedGroup.name, currentSite.sync.remote.keyGroup);
  const nextGroups = normalizeRemoteGroupsAfterSwitch(
    nextRemotePatch.groups ?? groups,
    {
      ...selectedGroup,
      id: nextGroupId,
      name: nextKeyGroup
    }
  );
  const nextRemote = {
    ...currentSite.sync.remote,
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
      ...currentSite.sync,
      ...result.syncPatch,
      remote: nextRemote
    }
  };

  const nextMultiplier = Number.isFinite(result.multiplier) && result.multiplier >= 0
    ? result.multiplier
    : selectedGroup.multiplier;
  if (shouldUpdateSiteMultiplier(currentSite, nextMultiplier)) {
    patch.multiplier = nextMultiplier;
  }

  return configService.updateSite(siteId, patch);
}

async function runRemoteAccountOperation({ configService, siteId, operation }) {
  const initialSite = configService.findSite(siteId);
  const accountKey = initialSite.sync?.accountId || `site:${siteId}`;
  const queues = getRemoteAccountOperationQueue(configService);
  const previous = queues.get(accountKey) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const site = configService.findSite(siteId);
    const accountSites = configService.getRemoteAccountSites?.(siteId) ?? [site];
    const authSession = configService.getRemoteAccountSession?.(siteId) ?? null;
    const result = await operation({ site, accountSites, authSession });
    // An invalidated session must be cleared before considering any session
    // attached to the error. Failed refreshes can carry the expired session
    // for diagnostics, but it must never be persisted back to the account.
    if (result?.authSessionInvalidated && authSession) {
      await configService.clearRemoteAccountSession?.(siteId);
    } else if (result?.authSession && !sameAuthSession(authSession, result.authSession)) {
      await configService.updateRemoteAccountSession?.(siteId, result.authSession);
    }
    return { site, result };
  });
  queues.set(accountKey, run);
  try {
    return await run;
  } finally {
    if (queues.get(accountKey) === run) {
      queues.delete(accountKey);
    }
  }
}

function getRemoteAccountOperationQueue(configService) {
  let queues = remoteAccountOperationQueues.get(configService);
  if (!queues) {
    queues = new Map();
    remoteAccountOperationQueues.set(configService, queues);
  }
  return queues;
}

function sameAuthSession(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function buildCreatedSiteName(configService, preferredName) {
  const baseName = String(preferredName ?? '').trim() || '新远端密钥';
  const existingNames = new Set(
    (configService.getState?.().sites ?? []).map((site) => String(site.name ?? '').trim())
  );
  if (!existingNames.has(baseName)) {
    return baseName;
  }
  const importedBaseName = `${baseName} 新密钥`;
  if (!existingNames.has(importedBaseName)) {
    return importedBaseName;
  }
  let suffix = 2;
  while (existingNames.has(`${importedBaseName} ${suffix}`)) {
    suffix += 1;
  }
  return `${importedBaseName} ${suffix}`;
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
