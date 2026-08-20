import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  getRemoteAccountIdentity,
  hydrateSiteWithRemoteAccount,
  normalizeRemoteAccount,
  normalizeRemoteAccountSession,
  reconcileRemoteAccounts,
  remoteAccountPublicView
} from './remote-accounts.js';

import {
  DEFAULT_AUTO_RECOVERY_STATE,
  DEFAULT_AUTO_SWITCH_MULTIPLIER_LIMIT,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_GROUP_SYNC_SETTINGS,
  DEFAULT_MODEL_MAPPING,
  DEFAULT_PRIORITY_MODE,
  DEFAULT_RATE_LIMIT_STATE,
  DEFAULT_SITE_CAPABILITIES,
  DEFAULT_SITE_SYNC_SETTINGS,
  DEFAULT_TEST_MODEL,
  MAX_ERROR_LOG_SIZE,
  chooseBestSite,
  chooseFailoverSite,
  getGroupSyncSettingsIntervalMs,
  getNextAutoRecoveryCheckAt,
  getSiteSyncIntervalMs,
  getSiteSyncSettingsIntervalMs,
  isRateLimitPaused,
  normalizeGroupSyncSettings,
  normalizeModelMapping,
  normalizeSite,
  normalizeSiteCapabilities,
  normalizeSiteSync,
  normalizeSiteSyncSettings,
  normalizeAutoSwitchMultiplierLimit,
  nowIso,
  recordAvailabilityFailure,
  recordFailure,
  recordRequestFailure,
  recordSuccess,
  shouldSwitchAfterFailure
} from './switching-policy.js';

const DEFAULT_SITE_SYNC_PREHEAT_CANDIDATE_LIMIT = 3;
const MAX_SITE_SYNC_PREHEAT_CANDIDATE_LIMIT = 10;
const SITE_SYNC_PREHEAT_LEAD_RATIO = 0.25;
const SITE_SYNC_PREHEAT_MIN_LEAD_MS = 5 * 60 * 1000;
const SITE_SYNC_PREHEAT_MAX_LEAD_MS = 15 * 60 * 1000;
const DEFAULT_MAX_REPLAYABLE_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MIN_REPLAYABLE_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REPLAYABLE_REQUEST_BODY_BYTES = 512 * 1024 * 1024;

export const DEFAULT_MONITORING_SETTINGS = {
  enabled: false,
  feishuWebhook: '',
  checkIntervalSeconds: 30,
  failureThreshold: 3,
  repeatIntervalMinutes: 30,
  noUsableSiteDelayMinutes: 5,
  notifications: {
    multiplierChanged: true,
    lowBalance: true,
    noUsableSite: true,
    programIssues: true,
    answerCompleted: false,
    goalStatusChanged: false
  },
  rules: []
};

export const DEFAULT_STATE = {
  version: 2,
  appSettings: {
    floatingWindow: {
      alwaysOnTop: false,
      position: null
    }
  },
  proxy: {
    port: 8787,
    allowLanAccess: false,
    localApiKeyHash: '',
    testModel: DEFAULT_TEST_MODEL,
    timeoutMs: 120000,
    maxReplayableRequestBodyBytes: DEFAULT_MAX_REPLAYABLE_REQUEST_BODY_BYTES,
    codexRecoveryEnabled: false,
    failureThreshold: DEFAULT_FAILURE_THRESHOLD,
    smartSwitching: false,
    priorityMode: DEFAULT_PRIORITY_MODE,
    samePriorityStrategy: 'round-robin',
    lastSelectedSiteId: null,
    autoSwitchMultiplierLimit: DEFAULT_AUTO_SWITCH_MULTIPLIER_LIMIT
  },
  modelMapping: DEFAULT_MODEL_MAPPING,
  siteSync: DEFAULT_SITE_SYNC_SETTINGS,
  groupSync: DEFAULT_GROUP_SYNC_SETTINGS,
  monitoring: DEFAULT_MONITORING_SETTINGS,
  autoProvisionAttempts: [],
  remoteAccounts: [],
  activeSiteId: null,
  sites: []
};

export class ConfigService extends EventEmitter {
  constructor({
    filePath,
    saveDelayMs = 1000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    super();
    if (!filePath) {
      throw new Error('filePath is required');
    }
    this.filePath = filePath;
    this.state = structuredClone(DEFAULT_STATE);
    this.saveQueue = Promise.resolve();
    this.saveDelayMs = saveDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pendingSaveTimer = null;
    this.pendingSaveEmit = false;
    this.siteAvailabilityQueues = new Map();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.state = structuredClone(DEFAULT_STATE);
        await this.save({ emit: false });
      } else if (error instanceof SyntaxError) {
        await this.quarantineInvalidConfig();
        this.state = structuredClone(DEFAULT_STATE);
        await this.save({ emit: false });
      } else {
        throw error;
      }
    }

    this.state.sites = unifyWebsiteCustomMultipliers(this.state.sites, {
      preferNonNull: true
    });
    this.disableLocalProxySites();
    this.ensureActiveSite();
    this.refreshAutoRecoverySchedules();
    this.rebuildGroupSyncWebsites();
    await this.save({ emit: false });
    return this.getState();
  }

  getState() {
    return structuredClone(this.state);
  }

  runSiteAvailabilityCheck(id, operation) {
    const siteId = String(id ?? '').trim();
    if (!siteId || typeof operation !== 'function') {
      throw new Error('site availability check requires a site id and operation');
    }

    const previous = this.siteAvailabilityQueues.get(siteId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => operation());
    this.siteAvailabilityQueues.set(siteId, current);

    return current.finally(() => {
      if (this.siteAvailabilityQueues.get(siteId) === current) {
        this.siteAvailabilityQueues.delete(siteId);
      }
    });
  }

  getRendererState() {
    const state = this.getState();
    state.proxy.localApiKey = { configured: Boolean(this.state.proxy.localApiKeyHash) };
    delete state.proxy.localApiKeyHash;
    state.remoteAccounts = this.state.remoteAccounts.map((account) => remoteAccountPublicView(
      account,
      this.state.sites.filter((site) => site.sync?.accountId === account.id).length
    ));
    return state;
  }

  getRemoteAccountForSite(siteId) {
    const site = this.findSite(siteId);
    const account = this.findRemoteAccount(site.sync?.accountId);
    return account ? structuredClone(account) : null;
  }

  getRemoteAccountSession(siteId) {
    return structuredClone(this.getRemoteAccountForSite(siteId)?.session ?? null);
  }

  getRemoteAccountSites(siteId) {
    const site = this.findSite(siteId);
    const accountId = String(site.sync?.accountId ?? '').trim();
    if (!accountId) {
      return [structuredClone(site)];
    }
    return this.state.sites
      .filter((candidate) => String(candidate.sync?.accountId ?? '').trim() === accountId)
      .map((candidate) => structuredClone(candidate));
  }

  async applyRemoteAccountSyncResults(siteId, result, now = new Date()) {
    const sourceSite = this.findSite(siteId);
    const accountId = String(sourceSite.sync?.accountId ?? '').trim();
    const siteResults = Array.isArray(result?.accountSync?.siteResults)
      ? result.accountSync.siteResults
      : [];
    if (!siteResults.length) {
      return [];
    }

    const resultBySiteId = new Map(siteResults.map((entry) => [String(entry.siteId), entry]));
    const refreshedAt = result.syncPatch?.lastSyncAt ?? nowIso(now);
    const affectedSites = [];
    this.state.sites = this.state.sites.map((candidate) => {
      if (
        accountId && String(candidate.sync?.accountId ?? '').trim() !== accountId
      ) {
        return candidate;
      }
      const target = resultBySiteId.get(String(candidate.id));
      if (!target) {
        return candidate;
      }
      const normalizedSite = normalizeSite(candidate);
      const nextRemote = target.ok && target.remote
        ? {
            ...normalizedSite.sync.remote,
            ...target.remote
          }
        : normalizedSite.sync.remote;
      const nextSite = normalizeSite({
        ...normalizedSite,
        ...(target.ok && shouldPersistSyncedMultiplier(normalizedSite, target.multiplier)
          ? { multiplier: target.multiplier }
          : {}),
        sync: {
          ...normalizedSite.sync,
          lastSyncAt: refreshedAt,
          lastSyncStatus: target.ok ? 'success' : 'failure',
          lastSyncError: target.ok ? null : String(target.error ?? 'Remote account sync failed'),
          remote: nextRemote
        },
        updatedAt: refreshedAt
      });
      affectedSites.push(nextSite);
      return nextSite;
    });
    this.rebuildGroupSyncWebsites();
    await this.save();
    return affectedSites.map((site) => structuredClone(site));
  }

  async updateRemoteAccountSession(siteId, session, now = new Date()) {
    const site = this.findSite(siteId);
    const index = this.findRemoteAccountIndex(site.sync?.accountId);
    const normalizedSession = normalizeRemoteAccountSession(session);
    if (!normalizedSession) {
      throw new Error('Remote account session is invalid');
    }
    const at = nowIso(now);
    this.state.remoteAccounts[index] = normalizeRemoteAccount({
      ...this.state.remoteAccounts[index],
      session: normalizedSession,
      lastLoginAt: normalizedSession.createdAt ?? at,
      updatedAt: at
    }, now);
    await this.save();
    return structuredClone(this.state.remoteAccounts[index]);
  }

  async clearRemoteAccountSession(siteId, { loggedOut = false, now = new Date() } = {}) {
    const site = this.findSite(siteId);
    const index = this.findRemoteAccountIndex(site.sync?.accountId);
    const at = nowIso(now);
    this.state.remoteAccounts[index] = normalizeRemoteAccount({
      ...this.state.remoteAccounts[index],
      session: null,
      ...(loggedOut ? { lastLogoutAt: at } : {}),
      updatedAt: at
    }, now);
    await this.save();
    return structuredClone(this.state.remoteAccounts[index]);
  }

  getActiveSiteId() {
    return this.state.activeSiteId;
  }

  getProxyPort() {
    return this.state.proxy.port;
  }

  getProxyListenHost() {
    return this.state.proxy.allowLanAccess ? '0.0.0.0' : '127.0.0.1';
  }

  async generateLocalApiKey(value) {
    const apiKey = value === undefined
      ? `jp-${randomBytes(32).toString('base64url')}`
      : String(value).trim();
    if (Buffer.byteLength(apiKey, 'utf8') < 32) {
      throw new Error('local API key must contain at least 32 bytes');
    }
    this.state.proxy.localApiKeyHash = hashLocalApiKey(apiKey);
    await this.save();
    return apiKey;
  }

  async ensureLocalApiKey() {
    return this.state.proxy.localApiKeyHash ? null : this.generateLocalApiKey();
  }

  hasLocalApiKey() {
    return Boolean(this.state.proxy.localApiKeyHash);
  }

  verifyLocalApiKey(apiKey) {
    const expected = Buffer.from(this.state.proxy.localApiKeyHash, 'hex');
    const actual = Buffer.from(hashLocalApiKey(apiKey), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  getProxyTimeoutMs() {
    return this.state.proxy.timeoutMs;
  }

  getMaxReplayableRequestBodyBytes() {
    return this.state.proxy.maxReplayableRequestBodyBytes;
  }

  getSiteSyncSettings() {
    return structuredClone(this.state.siteSync);
  }

  getGroupSyncSettings() {
    return structuredClone(this.state.groupSync);
  }

  getMonitoringSettings() {
    return structuredClone(this.state.monitoring);
  }

  getAutoProvisionAttempt(accountId, groupId) {
    const normalizedAccountId = String(accountId ?? '').trim();
    const normalizedGroupId = String(groupId ?? '').trim();
    if (!normalizedAccountId || !normalizedGroupId) {
      return null;
    }
    const attempt = this.state.autoProvisionAttempts.find((candidate) =>
      candidate.accountId === normalizedAccountId && candidate.groupId === normalizedGroupId
    );
    return attempt ? structuredClone(attempt) : null;
  }

  async recordAutoProvisionAttempt({
    accountId,
    groupId,
    groupName = '',
    status = 'failure',
    error = null,
    now = new Date(),
    cooldownMs = 24 * 60 * 60 * 1000
  } = {}) {
    const normalizedAccountId = String(accountId ?? '').trim();
    const normalizedGroupId = String(groupId ?? '').trim();
    if (!normalizedAccountId || !normalizedGroupId) {
      return null;
    }
    const at = nowIso(now);
    const nextAttemptAt = status === 'failure'
      ? new Date(new Date(at).getTime() + Math.max(0, Number(cooldownMs) || 0)).toISOString()
      : null;
    const entry = {
      accountId: normalizedAccountId,
      groupId: normalizedGroupId,
      groupName: String(groupName ?? '').trim(),
      lastAttemptAt: at,
      nextAttemptAt,
      status: status === 'success' ? 'success' : 'failure',
      error: error ? String(error).slice(0, 1000) : null
    };
    const index = this.state.autoProvisionAttempts.findIndex((candidate) =>
      candidate.accountId === normalizedAccountId && candidate.groupId === normalizedGroupId
    );
    if (index >= 0) {
      this.state.autoProvisionAttempts[index] = entry;
    } else {
      this.state.autoProvisionAttempts.push(entry);
    }
    await this.save();
    return structuredClone(entry);
  }

  getModelMapping() {
    return structuredClone(this.state.modelMapping);
  }

  hasEnabledSites() {
    return this.state.sites.some((site) => site.enabled);
  }

  getSiteSnapshot(id) {
    const site = this.state.sites.find((candidate) => candidate.id === id);
    return site ? structuredClone(site) : null;
  }

  async addSite(input, now = new Date()) {
    const site = prepareAutoRecoverySchedule(this.attachRemoteAccountToSite(
      createSite(input, now, this.state.proxy),
      { updateExisting: false, now }
    ), {
      previousEnabled: true,
      autoRecoveryPatch: true,
      now
    });
    this.state.sites.push(site);
    this.state.sites = unifyWebsiteCustomMultipliers(this.state.sites);
    if (site.enabled && !this.state.activeSiteId) {
      this.state.activeSiteId = site.id;
    }
    this.rebuildGroupSyncWebsites();
    await this.save();
    return structuredClone(this.state.sites.find((candidate) => candidate.id === site.id));
  }

  async updateSite(id, patch, now = new Date()) {
    const index = this.findSiteIndex(id);
    const current = this.state.sites[index];
    const currentWebsiteKey = getSiteSyncWebsiteKey(current);
    const sanitizedPatch = sanitizePatch(patch);
    const autoRecoveryPatch = Object.hasOwn(patch ?? {}, 'autoRecovery');
    const manualEnabledPatch =
      Object.hasOwn(patch ?? {}, 'enabled') || Object.hasOwn(patch ?? {}, 'manualEnabled');
    const nextManualEnabled = manualEnabledPatch
      ? Boolean(patch?.manualEnabled ?? patch?.enabled)
      : current.manualEnabled;
    const connectionChanged =
      (Object.hasOwn(sanitizedPatch, 'baseUrl') && sanitizedPatch.baseUrl !== current.baseUrl) ||
      (Object.hasOwn(sanitizedPatch, 'apiKey') && sanitizedPatch.apiKey !== current.apiKey);
    let merged = normalizeSite({
      ...current,
      ...sanitizedPatch,
      ...(manualEnabledPatch ? { failureDisabled: false } : {}),
      ...(Object.hasOwn(patch ?? {}, 'rateLimit') || (manualEnabledPatch && nextManualEnabled)
        ? { rateLimitState: DEFAULT_RATE_LIMIT_STATE }
        : {}),
      ...(autoRecoveryPatch ? { autoRecoveryState: DEFAULT_AUTO_RECOVERY_STATE } : {}),
      ...(connectionChanged && !Object.hasOwn(sanitizedPatch, 'capabilities')
        ? { capabilities: DEFAULT_SITE_CAPABILITIES }
        : {}),
      updatedAt: nowIso(now)
    });
    if (Object.hasOwn(sanitizedPatch, 'sync')) {
      merged = this.attachRemoteAccountToSite(merged, {
        previousAccountId: current.sync?.accountId,
        updateExisting: true,
        now
      });
    } else {
      merged = this.hydrateSiteRemoteAccount(merged);
    }
    validateSite(merged, this.state.proxy);

    this.state.sites[index] = prepareAutoRecoverySchedule(merged, {
      previousEnabled: current.enabled,
      autoRecoveryPatch,
      now
    });
    this.hydrateSitesForRemoteAccount(this.state.sites[index].sync?.accountId);
    if (current.sync?.accountId !== this.state.sites[index].sync?.accountId) {
      this.removeRemoteAccountIfOrphaned(current.sync?.accountId);
    }
    const websiteKey = getSiteSyncWebsiteKey(this.state.sites[index]);
    const customMultiplierPatched = Object.hasOwn(sanitizedPatch, 'customMultiplier');
    const destinationSite = websiteKey && websiteKey !== currentWebsiteKey
      ? this.state.sites.find((site, siteIndex) =>
          siteIndex !== index &&
          site.sync?.accountId !== this.state.sites[index].sync?.accountId &&
          getSiteSyncWebsiteKey(site) === websiteKey
        )
      : null;
    if (websiteKey && (customMultiplierPatched || destinationSite)) {
      this.state.sites = unifyWebsiteCustomMultipliers(this.state.sites, {
        preferredByKey: new Map([
          [
            websiteKey,
            customMultiplierPatched
              ? this.state.sites[index].customMultiplier
              : normalizeSite(destinationSite).customMultiplier
          ]
        ]),
        updatedAt: nowIso(now)
      });
    }
    this.ensureActiveSite();
    this.rebuildGroupSyncWebsites();
    await this.save();
    return structuredClone(this.state.sites[index]);
  }

  async updateSiteCapabilities(id, capabilities, now = new Date()) {
    const index = this.findSiteIndex(id);
    this.state.sites[index] = normalizeSite({
      ...this.state.sites[index],
      capabilities: normalizeSiteCapabilities(capabilities),
      updatedAt: nowIso(now)
    });
    await this.save();
    return structuredClone(this.state.sites[index]);
  }

  async cloneSite(id, now = new Date()) {
    const source = this.findSite(id);
    const site = prepareAutoRecoverySchedule(createSite({
      name: `${source.name} Copy`,
      remark: source.remark,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      priority: source.priority,
      multiplier: source.multiplier,
      customMultiplier: source.customMultiplier,
      multiplierLocked: source.multiplierLocked,
      modelMapping: source.modelMapping,
      capabilities: source.capabilities,
      sync: source.sync,
      rateLimit: source.rateLimit,
      autoRecovery: source.autoRecovery,
      manualEnabled: source.manualEnabled,
      failureDisabled: source.failureDisabled
    }, now, this.state.proxy), {
      previousEnabled: true,
      autoRecoveryPatch: true,
      now
    });
    this.state.sites.push(site);
    this.state.sites = unifyWebsiteCustomMultipliers(this.state.sites);
    if (site.enabled && !this.state.activeSiteId) {
      this.state.activeSiteId = site.id;
    }
    this.rebuildGroupSyncWebsites();
    await this.save();
    return structuredClone(this.state.sites.find((candidate) => candidate.id === site.id));
  }

  async deleteSite(id) {
    const deleted = this.findSite(id);
    this.state.sites = this.state.sites.filter((site) => site.id !== id);
    this.removeRemoteAccountIfOrphaned(deleted.sync?.accountId);
    if (this.state.activeSiteId === id) {
      this.state.activeSiteId = null;
      this.ensureActiveSite();
    }
    this.rebuildGroupSyncWebsites();
    await this.save();
  }

  async setActiveSite(id) {
    const site = this.findSite(id);
    validateSite(site, this.state.proxy);
    if (!site.enabled) {
      throw new Error('Cannot activate a disabled site');
    }
    this.state.activeSiteId = id;
    await this.save();
    return structuredClone(site);
  }

  async setSiteEnabled(id, enabled, now = new Date()) {
    const index = this.findSiteIndex(id);
    const site = normalizeSite(this.state.sites[index]);
    if (enabled) {
      validateSite(site, this.state.proxy);
    }

    this.state.sites[index] = prepareAutoRecoverySchedule({
      ...site,
      manualEnabled: Boolean(enabled),
      failureDisabled: false,
      ...(enabled ? { rateLimitState: DEFAULT_RATE_LIMIT_STATE } : {}),
      updatedAt: nowIso(now)
    }, {
      previousEnabled: site.enabled,
      autoRecoveryPatch: false,
      now
    });

    if (!enabled && this.state.activeSiteId === id) {
      this.state.activeSiteId = null;
      this.ensureActiveSite();
    } else if (enabled && !this.state.activeSiteId) {
      this.state.activeSiteId = id;
    }

    this.rebuildGroupSyncWebsites();
    await this.save();
    return structuredClone(this.state.sites[index]);
  }

  getActiveSite() {
    return this.state.sites.find((site) => site.id === this.state.activeSiteId) ?? null;
  }

  async smartSwitchSite(now = new Date()) {
    this.refreshRateLimitWindows(now);
    const chosen = chooseBestSite(this.state.sites, this.getSelectionOptions(now));
    if (!chosen) {
      throw new Error('No usable site configuration found');
    }
    this.state.activeSiteId = chosen.id;
    this.state.proxy.lastSelectedSiteId = chosen.id;
    await this.save();
    return structuredClone(this.findSite(chosen.id));
  }

  async selectSiteForRequest(now = new Date(), options = {}) {
    this.refreshRateLimitWindows(now);
    const excludeSiteIds = new Set(options.excludeSiteIds ?? []);
    const persistSelection = options.persistSelection !== false;

    if (!this.state.proxy.smartSwitching) {
      const active = this.getActiveSite();
      if (active?.enabled && !excludeSiteIds.has(active.id)) {
        if (isRateLimitPaused(active, now)) {
          await this.saveHotState();
          return null;
        }
        this.consumeRateLimit(active.id, now);
        await this.saveHotState();
        return structuredClone(active);
      }
      await this.saveHotState();
      return null;
    }

    const chosen = chooseBestSite(this.state.sites, {
      ...this.getSelectionOptions(now),
      excludeSiteIds
    });
    if (!chosen) {
      await this.saveHotState();
      return null;
    }

    if (persistSelection) {
      this.state.activeSiteId = chosen.id;
      this.state.proxy.lastSelectedSiteId = chosen.id;
    }
    this.consumeRateLimit(chosen.id, now);
    await this.saveHotState();
    return structuredClone(this.findSite(chosen.id));
  }

  async updateProxySettings(patch) {
    const next = {
      ...this.state.proxy,
      ...patch
    };

    const port = Number(next.port);
    const timeoutMs = Number(next.timeoutMs);
    const maxReplayableRequestBodyBytes = Number(next.maxReplayableRequestBodyBytes);
    const failureThreshold = Number(next.failureThreshold);
    const testModel = normalizeTestModel(next.testModel);
    const priorityMode = normalizePriorityMode(next.priorityMode);
    const samePriorityStrategy = normalizeSamePriorityStrategy(next.samePriorityStrategy);
    const autoSwitchMultiplierLimit = normalizeAutoSwitchMultiplierLimit(next.autoSwitchMultiplierLimit);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('proxy port must be an integer between 1 and 65535');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
      throw new Error('upstream timeout must be an integer greater than or equal to 1000ms');
    }
    if (
      !Number.isInteger(maxReplayableRequestBodyBytes) ||
      maxReplayableRequestBodyBytes < MIN_REPLAYABLE_REQUEST_BODY_BYTES ||
      maxReplayableRequestBodyBytes > MAX_REPLAYABLE_REQUEST_BODY_BYTES
    ) {
      throw new Error('request body replay buffer must be an integer between 1MB and 512MB');
    }
    if (!Number.isInteger(failureThreshold) || failureThreshold < 0) {
      throw new Error('failure threshold must be a non-negative integer');
    }

    this.state.proxy = {
      port,
      allowLanAccess: Boolean(next.allowLanAccess),
      localApiKeyHash: this.state.proxy.localApiKeyHash,
      testModel,
      timeoutMs,
      maxReplayableRequestBodyBytes,
      codexRecoveryEnabled: Boolean(next.codexRecoveryEnabled),
      failureThreshold,
      smartSwitching: Boolean(next.smartSwitching),
      priorityMode,
      samePriorityStrategy,
      autoSwitchMultiplierLimit,
      lastSelectedSiteId: next.lastSelectedSiteId ?? this.state.proxy.lastSelectedSiteId ?? null
    };
    this.disableLocalProxySites();
    this.ensureActiveSite();
    await this.save();
    return structuredClone(this.state.proxy);
  }

  async updateSiteSyncSettings(patch) {
    this.state.siteSync = normalizeSiteSyncSettings({
      ...this.state.siteSync,
      ...patch
    });
    await this.save();
    return structuredClone(this.state.siteSync);
  }

  async updateGroupSyncSettings(patch) {
    this.state.groupSync = normalizeGroupSyncSettings({
      ...this.state.groupSync,
      ...patch,
      websites: Object.hasOwn(patch ?? {}, 'websites')
        ? patch.websites
        : this.state.groupSync.websites
    });
    this.rebuildGroupSyncWebsites();
    await this.save();
    return structuredClone(this.state.groupSync);
  }

  async updateModelMapping(patch) {
    this.state.modelMapping = normalizeModelMapping({
      ...this.state.modelMapping,
      ...patch
    });
    await this.save();
    return structuredClone(this.state.modelMapping);
  }

  async updateMonitoringSettings(patch = {}) {
    this.state.monitoring = normalizeMonitoringSettings({
      ...this.state.monitoring,
      ...patch,
      notifications: {
        ...this.state.monitoring.notifications,
        ...patch.notifications
      },
      rules: this.state.monitoring.rules
    }, this.state.sites);
    await this.save();
    return structuredClone(this.state.monitoring);
  }

  async updateMonitoringRule(siteId, patch = {}) {
    const site = this.findSite(siteId);
    const accountId = String(site.sync?.accountId ?? '').trim();
    const current = this.state.monitoring.rules.find((rule) => rule.accountId === accountId);
    const rule = normalizeMonitoringRule({
      ...current,
      ...patch,
      accountId
    });
    this.state.monitoring.rules = [
      ...this.state.monitoring.rules.filter((candidate) => candidate.accountId !== accountId),
      rule
    ];
    await this.save();
    return structuredClone(rule);
  }

  async updateAppSettings(patch = {}) {
    this.state.appSettings = normalizeAppSettings({
      ...this.state.appSettings,
      ...patch,
      floatingWindow: {
        ...this.state.appSettings?.floatingWindow,
        ...(patch?.floatingWindow ?? {})
      }
    });
    await this.save();
    return structuredClone(this.state.appSettings);
  }

  exportConfig(options = {}, now = new Date()) {
    const siteIds = normalizeOptionalIdSet(options.siteIds);
    const sites = this.state.sites
      .filter((site) => !siteIds || siteIds.has(site.id))
      .map(serializeSiteForExport);

    return {
      kind: 'juanproxy.config-export',
      version: 1,
      exportedAt: nowIso(now),
      settings: options.includeGlobalSettings === false
        ? null
        : serializeGlobalSettingsForExport(this.state),
      sites
    };
  }

  previewImportConfig(input) {
    const payload = normalizeImportPayload(input);
    return {
      kind: payload.kind,
      version: payload.version,
      hasGlobalSettings: Boolean(payload.settings),
      sites: payload.sites.map((site) => ({
        sourceId: site.sourceId,
        name: site.name,
        baseUrl: site.baseUrl,
        manualEnabled: site.manualEnabled,
        priority: site.priority,
        multiplier: site.multiplier,
        customMultiplier: site.customMultiplier
      }))
    };
  }

  async importConfig(input, options = {}, now = new Date()) {
    const payload = normalizeImportPayload(input);
    const siteIds = normalizeOptionalIdSet(options.siteIds);
    const selectedSites = payload.sites.filter((site) => !siteIds || siteIds.has(site.sourceId));
    const importGlobalSettings = Boolean(options.includeGlobalSettings && payload.settings);
    const nextProxy = importGlobalSettings
      ? normalizeImportedProxySettings(payload.settings.proxy, this.state.proxy)
      : this.state.proxy;
    const importedSites = selectedSites.map((site) => this.attachRemoteAccountToSite(
      createSite(site, now, nextProxy),
      { now }
    ));

    if (importGlobalSettings) {
      this.state.appSettings = normalizeAppSettings(payload.settings.appSettings);
      this.state.proxy = nextProxy;
      this.state.modelMapping = normalizeModelMapping(payload.settings.modelMapping);
      this.state.siteSync = normalizeSiteSyncSettings(payload.settings.siteSync);
      this.state.groupSync = normalizeGroupSyncSettings(payload.settings.groupSync);
    }

    this.state.sites.push(...importedSites);
    this.state.sites = unifyWebsiteCustomMultipliers(this.state.sites);
    this.disableLocalProxySites(now);
    this.ensureActiveSite();
    this.rebuildGroupSyncWebsites();
    await this.save();

    return {
      importedSiteCount: importedSites.length,
      importedGlobalSettings: importGlobalSettings,
      importedSiteIds: importedSites.map((site) => site.id),
      importedSiteNames: importedSites.map((site) => site.name)
    };
  }

  async recordSiteSuccess(id, details) {
    const index = this.findSiteIndex(id);
    this.state.sites[index] = recordSuccess(this.state.sites[index], details);
    await this.saveHotState();
    return structuredClone(this.state.sites[index]);
  }

  async recordSiteAvailabilitySuccess(id, details = {}, now = new Date()) {
    const index = this.findSiteIndex(id);
    const previous = normalizeSite(this.state.sites[index]);
    const at = nowIso(now);
    const success = recordSuccess(previous, details, now);
    const recovered = prepareAutoRecoverySchedule({
      ...success,
      failureDisabled: success.manualEnabled ? false : success.failureDisabled,
      ...(success.manualEnabled ? { rateLimitState: DEFAULT_RATE_LIMIT_STATE } : {}),
      updatedAt: at
    }, {
      previousEnabled: previous.enabled,
      autoRecoveryPatch: false,
      now
    });

    validateSite(recovered, this.state.proxy);
    this.state.sites[index] = recovered;
    if (recovered.enabled && !this.state.activeSiteId) {
      this.state.activeSiteId = id;
      this.state.proxy.lastSelectedSiteId = id;
    }
    this.ensureActiveSite();
    await this.save();
    return structuredClone(this.state.sites[index]);
  }

  async recordSiteFailure(id, error, now = new Date()) {
    const index = this.findSiteIndex(id);
    const previous = normalizeSite(this.state.sites[index]);
    let failed = recordFailure(previous, error, now);
    let disabled = false;

    if (
      this.state.proxy.smartSwitching &&
      failed.manualEnabled &&
      shouldSwitchAfterFailure(failed, this.state.proxy.failureThreshold)
    ) {
      failed = prepareAutoRecoverySchedule({
        ...failed,
        failureDisabled: true
      }, {
        previousEnabled: previous.enabled,
        autoRecoveryPatch: false,
        now
      });
      disabled = true;
    }
    this.state.sites[index] = failed;

    let switchedTo = null;
    const shouldFailover = shouldSwitchAfterFailure(failed, this.state.proxy.failureThreshold);
    const activeSiteWasDisabled = this.state.activeSiteId === id && !failed.enabled;
    if (this.state.proxy.smartSwitching && shouldFailover) {
      const failover = chooseFailoverSite(this.state.sites, id, this.getSelectionOptions());
      if (failover) {
        this.state.activeSiteId = failover.id;
        this.state.proxy.lastSelectedSiteId = failover.id;
        switchedTo = this.findSite(failover.id);
      } else if (activeSiteWasDisabled) {
        this.state.activeSiteId = null;
      }
    }

    await this.saveHotState();
    return {
      site: structuredClone(this.state.sites[index]),
      switchedTo: switchedTo ? structuredClone(switchedTo) : null,
      disabled,
      allSitesDisabled: !this.state.sites.some((site) => site.enabled)
    };
  }

  async recordSiteRequestFailure(id, error, now = new Date()) {
    const index = this.findSiteIndex(id);
    this.state.sites[index] = recordRequestFailure(this.state.sites[index], error, now);
    await this.saveHotState();
    return structuredClone(this.state.sites[index]);
  }

  async recordSiteAvailabilityFailure(id, error, now = new Date()) {
    const index = this.findSiteIndex(id);
    const at = nowIso(now);
    const failure = recordAvailabilityFailure(this.state.sites[index], error, now);
    this.state.sites[index] = normalizeSite({
      ...failure,
      autoRecoveryState: {
        ...failure.autoRecoveryState,
        lastCheckedAt: at,
        nextCheckAt: failure.manualEnabled && failure.failureDisabled
          ? getNextAutoRecoveryCheckAt(failure, now)
          : null,
        lastResult: 'failure',
        lastMessage: error.message ?? 'Availability test failed'
      },
      updatedAt: at
    });
    await this.saveHotState();
    return structuredClone(this.state.sites[index]);
  }

  getDueDisabledAutoRecoverySites(now = new Date()) {
    const nowMs = new Date(now).getTime();
    return this.state.sites
      .map(normalizeSite)
      .filter((site) => {
        if (
          !site.manualEnabled ||
          !site.failureDisabled ||
          !site.autoRecovery.enabled ||
          !site.autoRecoveryState.nextCheckAt
        ) {
          return false;
        }

        const nextCheckMs = new Date(site.autoRecoveryState.nextCheckAt).getTime();
        return Number.isFinite(nextCheckMs) && nextCheckMs <= nowMs;
      })
      .map((site) => structuredClone(site));
  }

  getDueSiteSyncSites(now = new Date(), options = {}) {
    const nowMs = new Date(now).getTime();
    const settings = normalizeSiteSyncSettings(this.state.siteSync);
    const dueSites = this.state.sites
      .map(normalizeSite)
      .filter((site) => isDueSiteSyncSite(site, nowMs, settings))
      .map((site) => structuredClone(site));

    if (!options.includePreheat) {
      return dueSites;
    }

    const dueSiteIds = new Set(dueSites.map((site) => site.id));
    const preheatSites = this.getLikelySiteSyncSites(now, {
      limit: options.preheatCandidateLimit,
      excludeSiteIds: options.excludeSiteIds
    }).filter((site) => !dueSiteIds.has(site.id));

    return [...dueSites, ...preheatSites];
  }

  getLikelySiteSyncSites(now = new Date(), options = {}) {
    const settings = normalizeSiteSyncSettings(this.state.siteSync);
    if (!settings.intelligentScheduling) {
      return [];
    }

    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) {
      return [];
    }

    return this.getLikelyRequestSites(now, options)
      .filter((site) =>
        isDueSiteSyncSite(site, nowMs, settings) ||
        isPreheatSiteSyncSite(site, nowMs, settings)
      )
      .map((site) => structuredClone(site));
  }

  getEffectiveSiteSyncIntervalMs(site, now = new Date()) {
    return getEffectiveSiteSyncIntervalMs(site, this.state.siteSync, now);
  }

  getDueGroupSyncWebsites(now = new Date()) {
    this.rebuildGroupSyncWebsites();
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) {
      return [];
    }
    const intervalMs = getGroupSyncSettingsIntervalMs(this.state.groupSync);

    return this.state.groupSync.websites
      .filter((website) => isDueGroupSyncWebsite(website, nowMs, intervalMs))
      .map((website) => structuredClone(website));
  }

  getLikelyGroupSyncWebsites(now = new Date(), options = {}) {
    this.rebuildGroupSyncWebsites();
    const settings = normalizeSiteSyncSettings(this.state.siteSync);
    if (!settings.intelligentScheduling) {
      return [];
    }

    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) {
      return [];
    }
    const intervalMs = getGroupSyncSettingsIntervalMs(this.state.groupSync);
    const siteWebsites = this.getLikelyRequestSites(now, options)
      .map((site) => this.findGroupSyncWebsite(getSiteSyncWebsiteKey(site)))
      .filter((website) =>
        website &&
          (
            isDueGroupSyncWebsite(website, nowMs, intervalMs) ||
            isPreheatGroupSyncWebsite(website, nowMs, intervalMs)
          )
      );
    const seen = new Set();
    const websites = [];
    for (const website of siteWebsites) {
      if (seen.has(website.key)) {
        continue;
      }
      seen.add(website.key);
      websites.push(website);
    }
    return websites;
  }

  findGroupSyncWebsite(key) {
    const normalizedKey = normalizeWebsiteKey(key);
    const website = this.state.groupSync.websites.find((candidate) => candidate.key === normalizedKey);
    return website ? structuredClone(website) : null;
  }

  findGroupSyncRepresentativeSite(key) {
    const normalizedKey = normalizeWebsiteKey(key);
    return this.getGroupSyncWebsiteSites(normalizedKey)
      .find(isConfiguredGroupSyncSite) ?? null;
  }

  getGroupSyncWebsiteSites(key) {
    const normalizedKey = normalizeWebsiteKey(key);
    return this.state.sites
      .map(normalizeSite)
      .filter((site) =>
        isConfiguredGroupSyncSite(site) &&
          getSiteSyncWebsiteKey(site) === normalizedKey
      )
      .map((site) => structuredClone(site));
  }

  async recordGroupSyncSuccess(key, result, options = {}, now = new Date()) {
    const normalizedKey = normalizeWebsiteKey(key);
    const index = this.findGroupSyncWebsiteIndex(normalizedKey);
    const remote = result?.syncPatch?.remote ?? {};
    const groups = normalizeSiteSync({ remote }).remote.groups;
    const refreshedAt = result?.syncPatch?.lastSyncAt ?? nowIso(now);
    const representativeSiteId = options.representativeSiteId ?? null;
    const accountId = String(options.accountId ?? '').trim();
    const affectedSites = [];

    this.state.groupSync.websites[index] = {
      ...this.state.groupSync.websites[index],
      lastRefreshAt: refreshedAt,
      lastRefreshStatus: 'success',
      lastRefreshError: null,
      groups
    };

    for (const [siteIndex, site] of this.state.sites.entries()) {
      const normalizedSite = normalizeSite(site);
      if (
        getSiteSyncWebsiteKey(normalizedSite) !== normalizedKey ||
        !isConfiguredGroupSyncSite(normalizedSite) ||
        (accountId && String(normalizedSite.sync.accountId ?? '').trim() !== accountId)
      ) {
        continue;
      }
      const nextSite = mergeGroupSyncResultIntoSite(normalizedSite, {
        result,
        groups,
        representative: normalizedSite.id === representativeSiteId,
        now
      });
      this.state.sites[siteIndex] = nextSite;
      affectedSites.push(nextSite);
    }

    await this.save();
    return affectedSites.map((site) => structuredClone(site));
  }

  async recordGroupSyncFailure(key, error, options = {}, now = new Date()) {
    const normalizedKey = normalizeWebsiteKey(key);
    const index = this.findGroupSyncWebsiteIndex(normalizedKey);
    const refreshedAt = nowIso(now);
    const message = error?.message ?? String(error ?? 'Group sync failed');
    const representativeSiteId = options.representativeSiteId ?? null;

    this.state.groupSync.websites[index] = {
      ...this.state.groupSync.websites[index],
      lastRefreshAt: refreshedAt,
      lastRefreshStatus: 'failure',
      lastRefreshError: message
    };

    if (representativeSiteId) {
      const siteIndex = this.state.sites.findIndex((site) => site.id === representativeSiteId);
      if (siteIndex >= 0) {
        this.state.sites[siteIndex] = normalizeSite({
          ...this.state.sites[siteIndex],
          sync: {
            ...this.state.sites[siteIndex].sync,
            lastSyncAt: refreshedAt,
            lastSyncStatus: 'failure',
            lastSyncError: message
          },
          updatedAt: refreshedAt
        });
      }
    }

    await this.save();
    return structuredClone(this.state.groupSync.websites[index]);
  }

  async recordSiteAutoRecoverySuccess(id, details = {}, now = new Date()) {
    const index = this.findSiteIndex(id);
    const at = nowIso(now);
    const success = recordSuccess(this.state.sites[index], details, now);
    const recovered = normalizeSite({
      ...success,
      failureDisabled: false,
      rateLimitState: DEFAULT_RATE_LIMIT_STATE,
      autoRecoveryState: {
        ...success.autoRecoveryState,
        lastCheckedAt: at,
        nextCheckAt: null,
        lastResult: 'success',
        lastMessage: details.message ?? 'Availability test succeeded'
      },
      updatedAt: at
    });
    validateSite(recovered, this.state.proxy);
    this.state.sites[index] = recovered;
    if (!this.state.activeSiteId) {
      this.state.activeSiteId = id;
      this.state.proxy.lastSelectedSiteId = id;
    }
    this.ensureActiveSite();
    await this.save();
    return structuredClone(this.state.sites[index]);
  }

  async recordSiteAutoRecoveryFailure(id, error = {}, now = new Date()) {
    const index = this.findSiteIndex(id);
    const at = nowIso(now);
    const failure = error.affectsSiteHealth === false
      ? recordAvailabilityFailure(this.state.sites[index], error, now)
      : recordFailure(this.state.sites[index], error, now);
    const failed = normalizeSite({
      ...failure,
      failureDisabled: failure.manualEnabled,
      autoRecoveryState: {
        ...failure.autoRecoveryState,
        lastCheckedAt: at,
        nextCheckAt: getNextAutoRecoveryCheckAt(failure, now),
        lastResult: 'failure',
        lastMessage: error.message ?? 'Availability test failed'
      },
      updatedAt: at
    });
    this.state.sites[index] = failed;
    this.ensureActiveSite();
    await this.save();
    return structuredClone(this.state.sites[index]);
  }

  ensureActiveSite() {
    const active = this.getActiveSite();
    if (active?.enabled) {
      return;
    }

    this.state.activeSiteId = chooseBestSite(this.state.sites, this.getSelectionOptions())?.id ?? null;
  }

  refreshAutoRecoverySchedules(now = new Date()) {
    this.state.sites = this.state.sites.map((site) =>
      prepareAutoRecoverySchedule(site, {
        previousEnabled: site.enabled,
        autoRecoveryPatch: false,
        now
      })
    );
  }

  disableLocalProxySites(now = new Date()) {
    this.state.sites = this.state.sites.map((site) =>
      disableLocalProxySite(site, this.state.proxy, now)
    );
  }

  getSelectionOptions(now = new Date()) {
    return {
      samePriorityStrategy: this.state.proxy.samePriorityStrategy,
      priorityMode: this.state.proxy.priorityMode,
      lastSelectedSiteId: this.state.proxy.lastSelectedSiteId,
      now,
      autoSwitchMultiplierLimit: this.state.proxy.autoSwitchMultiplierLimit
    };
  }

  getLikelyRequestSites(now = new Date(), options = {}) {
    const limit = normalizePreheatCandidateLimit(options.limit);
    const excludeSiteIds = new Set(options.excludeSiteIds ?? []);
    const candidates = [];

    for (let index = 0; index < limit; index += 1) {
      const chosen = chooseBestSite(this.state.sites, {
        ...this.getSelectionOptions(now),
        excludeSiteIds
      });
      if (!chosen) {
        break;
      }

      candidates.push(chosen);
      excludeSiteIds.add(chosen.id);
    }

    return candidates;
  }

  rebuildGroupSyncWebsites() {
    const existingByKey = new Map(
      normalizeGroupSyncSettings(this.state.groupSync).websites.map((website) => [website.key, website])
    );
    const websites = [];
    const seen = new Set();

    for (const site of this.state.sites.map(normalizeSite)) {
      if (!isConfiguredGroupSyncSite(site)) {
        continue;
      }
      const key = getSiteSyncWebsiteKey(site);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const existing = existingByKey.get(key) ?? {};
      websites.push({
        key,
        dashboardUrl: site.sync.dashboardUrl,
        providerType: site.sync.providerType,
        username: site.sync.username,
        lastRefreshAt: existing.lastRefreshAt ?? site.sync.lastSyncAt ?? null,
        lastRefreshStatus: existing.lastRefreshStatus ?? site.sync.lastSyncStatus ?? null,
        lastRefreshError: existing.lastRefreshError ?? site.sync.lastSyncError ?? null,
        groups: existing.groups ?? site.sync.remote.groups ?? []
      });
    }

    this.state.groupSync = normalizeGroupSyncSettings({
      ...this.state.groupSync,
      websites
    });
  }

  findGroupSyncWebsiteIndex(key) {
    const normalizedKey = normalizeWebsiteKey(key);
    const index = this.state.groupSync.websites.findIndex((website) => website.key === normalizedKey);
    if (index === -1) {
      throw new Error(`Group sync website not found: ${key}`);
    }
    return index;
  }

  refreshRateLimitWindows(now = new Date()) {
    const nowMs = new Date(now).getTime();
    this.state.sites = this.state.sites.map((site) => {
      const normalized = normalizeSite(site);
      if (!normalized.rateLimit.enabled) {
        return normalized;
      }

      const pausedUntilMs = normalized.rateLimitState.pausedUntil
        ? new Date(normalized.rateLimitState.pausedUntil).getTime()
        : null;
      const startedAtMs = normalized.rateLimitState.windowStartedAt
        ? new Date(normalized.rateLimitState.windowStartedAt).getTime()
        : null;
      const windowMs = getRateLimitWindowMs(normalized.rateLimit);
      const windowExpired = startedAtMs !== null && nowMs >= startedAtMs + windowMs;
      const pauseExpired = pausedUntilMs !== null && nowMs >= pausedUntilMs;

      if (windowExpired || pauseExpired) {
        return {
          ...normalized,
          rateLimitState: {
            windowStartedAt: null,
            used: 0,
            pausedUntil: null
          },
          updatedAt: nowIso(now)
        };
      }

      return normalized;
    });
  }

  consumeRateLimit(id, now = new Date()) {
    const index = this.findSiteIndex(id);
    const site = normalizeSite(this.state.sites[index]);
    if (!site.rateLimit.enabled) {
      this.state.sites[index] = site;
      return;
    }

    const nowDate = new Date(now);
    const nowMs = nowDate.getTime();
    const windowMs = getRateLimitWindowMs(site.rateLimit);
    const currentStartedAt = site.rateLimitState.windowStartedAt
      ? new Date(site.rateLimitState.windowStartedAt)
      : null;
    const windowStartedAt =
      currentStartedAt && nowMs < currentStartedAt.getTime() + windowMs ? currentStartedAt : nowDate;
    const used = (currentStartedAt === windowStartedAt ? site.rateLimitState.used : 0) + 1;
    const pausedUntil =
      used >= site.rateLimit.limit
        ? new Date(windowStartedAt.getTime() + windowMs).toISOString()
        : null;

    this.state.sites[index] = {
      ...site,
      rateLimitState: {
        windowStartedAt: windowStartedAt.toISOString(),
        used,
        pausedUntil
      },
      updatedAt: nowIso(now)
    };
  }

  findSite(id) {
    const site = this.state.sites.find((candidate) => candidate.id === id);
    if (!site) {
      throw new Error(`Site not found: ${id}`);
    }
    return site;
  }

  findRemoteAccount(id) {
    const normalizedId = String(id ?? '').trim();
    return this.state.remoteAccounts.find((account) => account.id === normalizedId) ?? null;
  }

  findRemoteAccountIndex(id) {
    const normalizedId = String(id ?? '').trim();
    const index = this.state.remoteAccounts.findIndex((account) => account.id === normalizedId);
    if (index === -1) {
      throw new Error(`Remote account not found: ${normalizedId}`);
    }
    return index;
  }

  attachRemoteAccountToSite(site, {
    previousAccountId = '',
    updateExisting = false,
    now = new Date()
  } = {}) {
    const normalizedSite = normalizeSite(site);
    const sync = normalizedSite.sync;
    if (!sync.dashboardUrl || !sync.username) {
      return normalizedSite;
    }

    const requestedAccountId = sync.accountId || previousAccountId;
    let account = this.findRemoteAccount(requestedAccountId);
    const accountChanged = Boolean(
      sync.accountId && previousAccountId && sync.accountId !== previousAccountId
    );
    if (!account) {
      const identity = getRemoteAccountIdentity(sync);
      account = this.state.remoteAccounts.find(
        (candidate) => getRemoteAccountIdentity(candidate) === identity
      ) ?? null;
    }

    const at = nowIso(now);
    if (!account) {
      account = normalizeRemoteAccount({
        dashboardUrl: sync.dashboardUrl,
        username: sync.username,
        password: sync.password,
        providerType: sync.providerType,
        createdAt: at,
        updatedAt: at
      }, now);
      this.state.remoteAccounts.push(account);
    } else if (updateExisting && !accountChanged) {
      const destinationAccount = this.state.remoteAccounts.find((candidate) =>
        candidate.id !== account.id &&
          getRemoteAccountIdentity(candidate) === getRemoteAccountIdentity(sync)
      );
      if (destinationAccount) {
        const mergedAccountId = account.id;
        account = destinationAccount;
        this.state.sites = this.state.sites.map((candidate) =>
          candidate.sync?.accountId === mergedAccountId
            ? normalizeSite(hydrateSiteWithRemoteAccount(candidate, account))
            : candidate
        );
        this.state.remoteAccounts = this.state.remoteAccounts.filter(
          (candidate) => candidate.id !== mergedAccountId
        );
      } else {
        const authChanged = account.dashboardUrl !== sync.dashboardUrl ||
          account.username !== sync.username ||
          account.password !== sync.password ||
          account.providerType !== sync.providerType;
        const index = this.findRemoteAccountIndex(account.id);
        account = normalizeRemoteAccount({
          ...account,
          dashboardUrl: sync.dashboardUrl,
          username: sync.username,
          password: sync.password,
          providerType: sync.providerType,
          ...(authChanged ? { session: null } : {}),
          updatedAt: authChanged ? at : account.updatedAt
        }, now);
        this.state.remoteAccounts[index] = account;
      }
    }

    return normalizeSite(hydrateSiteWithRemoteAccount(normalizedSite, account));
  }

  hydrateSiteRemoteAccount(site) {
    const account = this.findRemoteAccount(site?.sync?.accountId);
    return normalizeSite(hydrateSiteWithRemoteAccount(site, account));
  }

  hydrateSitesForRemoteAccount(accountId) {
    if (!accountId) {
      return;
    }
    const account = this.findRemoteAccount(accountId);
    if (!account) {
      return;
    }
    this.state.sites = this.state.sites.map((site) =>
      site.sync?.accountId === accountId
        ? normalizeSite(hydrateSiteWithRemoteAccount(site, account))
        : site
    );
  }

  removeRemoteAccountIfOrphaned(accountId) {
    if (!accountId || this.state.sites.some((site) => site.sync?.accountId === accountId)) {
      return;
    }
    this.state.remoteAccounts = this.state.remoteAccounts.filter((account) => account.id !== accountId);
  }

  findSiteIndex(id) {
    const index = this.state.sites.findIndex((site) => site.id === id);
    if (index === -1) {
      throw new Error(`Site not found: ${id}`);
    }
    return index;
  }

  async save({ emit = true, delay = false } = {}) {
    if (delay) {
      this.scheduleSave(emit);
      return;
    }

    this.clearPendingSave();
    this.state.monitoring = normalizeMonitoringSettings(this.state.monitoring, this.state.sites);
    const snapshot = this.getState();
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
    const run = this.saveQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFileAtomically(this.filePath, payload);
      if (emit) {
        this.emit('changed', structuredClone(snapshot));
      }
    });
    this.saveQueue = run.catch(() => {});
    await run;
  }

  async saveHotState() {
    await this.save({ delay: true, emit: false });
  }

  scheduleSave(emit) {
    this.pendingSaveEmit = this.pendingSaveEmit || emit;
    if (this.pendingSaveTimer) {
      return;
    }
    this.pendingSaveTimer = this.setTimer(() => {
      this.pendingSaveTimer = null;
      const shouldEmit = this.pendingSaveEmit;
      this.pendingSaveEmit = false;
      this.save({ emit: shouldEmit }).catch((error) => this.emit('save-error', error));
    }, this.saveDelayMs);
    this.pendingSaveTimer.unref?.();
  }

  clearPendingSave() {
    if (!this.pendingSaveTimer) {
      return;
    }
    this.clearTimer(this.pendingSaveTimer);
    this.pendingSaveTimer = null;
    this.pendingSaveEmit = false;
  }

  async flush() {
    const shouldEmit = this.pendingSaveEmit;
    this.clearPendingSave();
    await this.save({ emit: shouldEmit });
  }

  async quarantineInvalidConfig() {
    const quarantinePath = `${this.filePath}.invalid-${Date.now()}`;
    await rename(this.filePath, quarantinePath);
  }
}

async function writeFileAtomically(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, payload, 'utf8');
  await rename(tempPath, filePath);
}

function normalizeState(raw) {
  const legacyTestModel = Array.isArray(raw?.sites)
    ? raw.sites.find((site) => typeof site?.testModel === 'string' && site.testModel.trim())?.testModel
    : null;
  const initialSites = Array.isArray(raw?.sites) ? raw.sites.map(normalizeSite) : [];
  const reconciledAccounts = reconcileRemoteAccounts({
    accounts: raw?.remoteAccounts,
    sites: initialSites
  });
  const state = {
    ...structuredClone(DEFAULT_STATE),
    ...raw,
    proxy: {
      ...DEFAULT_STATE.proxy,
      ...(raw?.proxy ?? {}),
      testModel: raw?.proxy?.testModel ?? legacyTestModel ?? DEFAULT_TEST_MODEL
    },
    appSettings: normalizeAppSettings(raw?.appSettings ?? DEFAULT_STATE.appSettings),
    modelMapping: normalizeModelMapping(raw?.modelMapping ?? DEFAULT_STATE.modelMapping),
    siteSync: normalizeSiteSyncSettings(raw?.siteSync ?? DEFAULT_STATE.siteSync),
    groupSync: normalizeGroupSyncSettings(raw?.groupSync ?? DEFAULT_STATE.groupSync),
    monitoring: normalizeMonitoringSettings(
      raw?.monitoring ?? DEFAULT_STATE.monitoring,
      reconciledAccounts.sites
    ),
    autoProvisionAttempts: normalizeAutoProvisionAttempts(raw?.autoProvisionAttempts),
    remoteAccounts: reconciledAccounts.accounts,
    sites: reconciledAccounts.sites.map(normalizeSite)
  };

  state.proxy.port = Number.isInteger(Number(state.proxy.port)) ? Number(state.proxy.port) : 8787;
  state.proxy.allowLanAccess = Boolean(state.proxy.allowLanAccess);
  state.proxy.localApiKeyHash = normalizeLocalApiKeyHash(state.proxy.localApiKeyHash);
  state.proxy.testModel = normalizeTestModel(state.proxy.testModel);
  state.proxy.timeoutMs =
    Number.isInteger(Number(state.proxy.timeoutMs)) && Number(state.proxy.timeoutMs) >= 1000
      ? Number(state.proxy.timeoutMs)
      : DEFAULT_STATE.proxy.timeoutMs;
  state.proxy.maxReplayableRequestBodyBytes = normalizeReplayableRequestBodyBytes(
    state.proxy.maxReplayableRequestBodyBytes,
    DEFAULT_STATE.proxy.maxReplayableRequestBodyBytes
  );
  state.proxy.codexRecoveryEnabled = Boolean(state.proxy.codexRecoveryEnabled);
  state.proxy.failureThreshold = Number.isInteger(Number(state.proxy.failureThreshold))
    ? Number(state.proxy.failureThreshold)
    : DEFAULT_FAILURE_THRESHOLD;
  state.proxy.smartSwitching = Boolean(state.proxy.smartSwitching);
  state.proxy.priorityMode = normalizePriorityMode(state.proxy.priorityMode);
  state.proxy.samePriorityStrategy = normalizeSamePriorityStrategy(state.proxy.samePriorityStrategy);
  state.proxy.autoSwitchMultiplierLimit = normalizeAutoSwitchMultiplierLimit(
    state.proxy.autoSwitchMultiplierLimit
  );
  state.proxy.lastSelectedSiteId = state.proxy.lastSelectedSiteId ?? null;
  state.activeSiteId = state.activeSiteId ?? null;

  return state;
}

function hashLocalApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey ?? ''), 'utf8').digest('hex');
}

function normalizeLocalApiKeyHash(value) {
  const hash = String(value ?? '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function serializeGlobalSettingsForExport(state) {
  return {
    appSettings: normalizeAppSettings(state.appSettings),
    proxy: {
      port: state.proxy.port,
      allowLanAccess: state.proxy.allowLanAccess,
      testModel: state.proxy.testModel,
      timeoutMs: state.proxy.timeoutMs,
      maxReplayableRequestBodyBytes: state.proxy.maxReplayableRequestBodyBytes,
      codexRecoveryEnabled: state.proxy.codexRecoveryEnabled,
      failureThreshold: state.proxy.failureThreshold,
      smartSwitching: state.proxy.smartSwitching,
      priorityMode: state.proxy.priorityMode,
      samePriorityStrategy: state.proxy.samePriorityStrategy,
      autoSwitchMultiplierLimit: normalizeAutoSwitchMultiplierLimit(
        state.proxy.autoSwitchMultiplierLimit
      )
    },
    modelMapping: structuredClone(normalizeModelMapping(state.modelMapping)),
    siteSync: structuredClone(normalizeSiteSyncSettings(state.siteSync)),
    groupSync: structuredClone(serializeGroupSyncSettingsForExport(state.groupSync))
  };
}

function serializeGroupSyncSettingsForExport(groupSync) {
  const normalized = normalizeGroupSyncSettings(groupSync);
  return {
    intervalValue: normalized.intervalValue,
    intervalUnit: normalized.intervalUnit
  };
}

function serializeSiteForExport(site) {
  const normalized = normalizeSite(site);
  return {
    sourceId: normalized.id,
    name: normalized.name,
    remark: normalized.remark,
    baseUrl: normalized.baseUrl,
    apiKey: normalized.apiKey,
    priority: normalized.priority,
    multiplier: normalized.multiplier,
    customMultiplier: normalized.customMultiplier,
    multiplierLocked: normalized.multiplierLocked,
    modelMapping: structuredClone(normalized.modelMapping),
    sync: serializeSiteSyncForExport(normalized.sync),
    rateLimit: structuredClone(normalized.rateLimit),
    autoRecovery: structuredClone(normalized.autoRecovery),
    manualEnabled: normalized.manualEnabled
  };
}

function serializeSiteSyncForExport(sync) {
  const normalized = normalizeSiteSync(sync);
  return {
    enabled: normalized.enabled,
    dashboardUrl: normalized.dashboardUrl,
    username: normalized.username,
    password: normalized.password,
    providerType: normalized.providerType,
    intervalMode: normalized.intervalMode,
    intervalValue: normalized.intervalValue,
    intervalUnit: normalized.intervalUnit
  };
}

function normalizeImportPayload(input) {
  const raw = parseImportPayload(input);
  if (raw?.kind === 'juanproxy.config-export') {
    return {
      kind: 'juanproxy.config-export',
      version: raw.version ?? 1,
      settings: raw.settings ? normalizeExportedSettings(raw.settings) : null,
      sites: normalizeImportSites(raw.sites)
    };
  }

  const state = normalizeState(raw);
  return {
    kind: 'juanproxy.raw-config',
    version: state.version,
    settings: serializeGlobalSettingsForExport(state),
    sites: state.sites.map(serializeSiteForExport)
  };
}

function parseImportPayload(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      throw new Error('导入文件不是有效的 JSON');
    }
  }
  if (!input || typeof input !== 'object') {
    throw new Error('导入内容必须是 JSON 对象');
  }
  return input;
}

function normalizeExportedSettings(settings = {}) {
  return {
    appSettings: normalizeAppSettings(settings.appSettings),
    proxy: normalizeImportedProxySettings(settings.proxy, DEFAULT_STATE.proxy),
    modelMapping: normalizeModelMapping(settings.modelMapping),
    siteSync: normalizeSiteSyncSettings(settings.siteSync),
    groupSync: normalizeGroupSyncSettings(settings.groupSync)
  };
}

function normalizeAppSettings(settings = {}) {
  return {
    floatingWindow: {
      alwaysOnTop: Boolean(settings?.floatingWindow?.alwaysOnTop),
      position: normalizeFloatingWindowPosition(settings?.floatingWindow?.position)
    }
  };
}

export function normalizeMonitoringSettings(settings = {}, sites = []) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const validAccountIds = new Set((Array.isArray(sites) ? sites : [])
    .map((site) => String(site?.sync?.accountId ?? '').trim())
    .filter(Boolean));
  const rules = new Map();
  for (const input of Array.isArray(source.rules) ? source.rules : []) {
    const rule = normalizeMonitoringRule(input);
    if (validAccountIds.has(rule.accountId)) {
      rules.set(rule.accountId, rule);
    }
  }

  return {
    enabled: Boolean(source.enabled),
    feishuWebhook: String(source.feishuWebhook ?? '').trim(),
    checkIntervalSeconds: normalizeInteger(
      source.checkIntervalSeconds,
      DEFAULT_MONITORING_SETTINGS.checkIntervalSeconds,
      10
    ),
    failureThreshold: normalizeInteger(
      source.failureThreshold,
      DEFAULT_MONITORING_SETTINGS.failureThreshold,
      1
    ),
    repeatIntervalMinutes: normalizeInteger(
      source.repeatIntervalMinutes,
      DEFAULT_MONITORING_SETTINGS.repeatIntervalMinutes,
      1
    ),
    noUsableSiteDelayMinutes: normalizeInteger(
      source.noUsableSiteDelayMinutes,
      DEFAULT_MONITORING_SETTINGS.noUsableSiteDelayMinutes,
      1
    ),
    notifications: {
      multiplierChanged: source.notifications?.multiplierChanged === undefined
        ? DEFAULT_MONITORING_SETTINGS.notifications.multiplierChanged
        : Boolean(source.notifications.multiplierChanged),
      lowBalance: source.notifications?.lowBalance === undefined
        ? DEFAULT_MONITORING_SETTINGS.notifications.lowBalance
        : Boolean(source.notifications.lowBalance),
      noUsableSite: source.notifications?.noUsableSite === undefined
        ? DEFAULT_MONITORING_SETTINGS.notifications.noUsableSite
        : Boolean(source.notifications.noUsableSite),
      programIssues: source.notifications?.programIssues === undefined
        ? DEFAULT_MONITORING_SETTINGS.notifications.programIssues
        : Boolean(source.notifications.programIssues),
      answerCompleted: source.notifications?.answerCompleted === undefined
        ? DEFAULT_MONITORING_SETTINGS.notifications.answerCompleted
        : Boolean(source.notifications.answerCompleted),
      goalStatusChanged: source.notifications?.goalStatusChanged === undefined
        ? DEFAULT_MONITORING_SETTINGS.notifications.goalStatusChanged
        : Boolean(source.notifications.goalStatusChanged)
    },
    rules: [...rules.values()]
  };
}

function normalizeMonitoringRule(rule = {}) {
  const threshold = rule.balanceThreshold === null || rule.balanceThreshold === ''
    ? null
    : Number(rule.balanceThreshold);
  return {
    accountId: String(rule.accountId ?? '').trim(),
    enabled: rule.enabled === undefined ? true : Boolean(rule.enabled),
    balanceThreshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : null
  };
}

function normalizeInteger(value, fallback, minimum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
}

function normalizeFloatingWindowPosition(position) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) {
    return null;
  }
  const x = Number(position.x);
  const y = Number(position.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

function normalizeImportSites(sites = []) {
  if (!Array.isArray(sites)) {
    return [];
  }
  return sites.map(normalizeImportSite).filter(Boolean);
}

function normalizeImportSite(site = {}) {
  if (!site || typeof site !== 'object') {
    return null;
  }
  const normalized = normalizeSite(site);
  return {
    sourceId: String(site.sourceId ?? normalized.id ?? '').trim(),
    name: normalized.name,
    remark: normalized.remark,
    baseUrl: normalized.baseUrl,
    apiKey: normalized.apiKey,
    priority: normalized.priority,
    multiplier: normalized.multiplier,
    customMultiplier: normalized.customMultiplier,
    multiplierLocked: normalized.multiplierLocked,
    modelMapping: structuredClone(normalized.modelMapping),
    sync: serializeSiteSyncForExport(normalized.sync),
    rateLimit: structuredClone(normalized.rateLimit),
    autoRecovery: structuredClone(normalized.autoRecovery),
    manualEnabled: normalized.manualEnabled
  };
}

function normalizeImportedProxySettings(proxy = {}, currentProxy = DEFAULT_STATE.proxy) {
  const source = proxy && typeof proxy === 'object' ? proxy : {};
  const fallback = {
    ...DEFAULT_STATE.proxy,
    ...currentProxy
  };
  const port = Number(source.port);
  const testModel = normalizeTestModel(source.testModel ?? fallback.testModel);
  const timeoutMs = Number(source.timeoutMs);
  const failureThreshold = Number(source.failureThreshold);
  const maxReplayableRequestBodyBytes = normalizeReplayableRequestBodyBytes(
    source.maxReplayableRequestBodyBytes,
    fallback.maxReplayableRequestBodyBytes
  );

  return {
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback.port,
    allowLanAccess: source.allowLanAccess === undefined
      ? fallback.allowLanAccess
      : Boolean(source.allowLanAccess),
    localApiKeyHash: normalizeLocalApiKeyHash(fallback.localApiKeyHash),
    testModel,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : fallback.timeoutMs,
    maxReplayableRequestBodyBytes,
    codexRecoveryEnabled: source.codexRecoveryEnabled === undefined
      ? fallback.codexRecoveryEnabled
      : Boolean(source.codexRecoveryEnabled),
    failureThreshold: Number.isInteger(failureThreshold) && failureThreshold >= 0
      ? failureThreshold
      : fallback.failureThreshold,
    smartSwitching: source.smartSwitching === undefined
      ? fallback.smartSwitching
      : Boolean(source.smartSwitching),
    priorityMode: normalizePriorityMode(source.priorityMode ?? fallback.priorityMode),
    samePriorityStrategy: normalizeSamePriorityStrategy(
      source.samePriorityStrategy ?? fallback.samePriorityStrategy
    ),
    autoSwitchMultiplierLimit: normalizeAutoSwitchMultiplierLimit(
      source.autoSwitchMultiplierLimit ?? fallback.autoSwitchMultiplierLimit
    ),
    lastSelectedSiteId: fallback.lastSelectedSiteId ?? null
  };
}

function normalizeReplayableRequestBodyBytes(value, fallback) {
  const bytes = Number(value);
  return Number.isInteger(bytes) &&
    bytes >= MIN_REPLAYABLE_REQUEST_BODY_BYTES &&
    bytes <= MAX_REPLAYABLE_REQUEST_BODY_BYTES
    ? bytes
    : fallback;
}

function normalizeTestModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TEST_MODEL;
}

function normalizeOptionalIdSet(ids) {
  if (ids === null || ids === undefined) {
    return null;
  }
  if (!Array.isArray(ids)) {
    return new Set([String(ids)]);
  }
  return new Set(ids.map((id) => String(id)));
}

function createSite(input, now = new Date(), proxy = DEFAULT_STATE.proxy) {
  const at = nowIso(now);
  const site = normalizeSite({
    id: randomUUID(),
    name: input?.name,
    remark: input?.remark,
    baseUrl: input?.baseUrl,
    apiKey: input?.apiKey,
    priority: input?.priority,
    multiplier: input?.multiplier,
    customMultiplier: input?.customMultiplier,
    multiplierLocked: input?.multiplierLocked,
    modelMapping: input?.modelMapping,
    capabilities: input?.capabilities,
    sync: input?.sync,
    rateLimit: input?.rateLimit,
    autoRecovery: input?.autoRecovery,
    manualEnabled: input?.manualEnabled ?? input?.enabled ?? true,
    failureDisabled: input?.failureDisabled ?? false,
    status: 'idle',
    consecutiveErrors: 0,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    errorLog: [],
    createdAt: at,
    updatedAt: at
  });
  validateSite(site, proxy);
  return site;
}

function sanitizePatch(patch = {}) {
  const allowed = {};
  for (const key of [
    'name',
    'remark',
    'baseUrl',
    'apiKey',
    'priority',
    'multiplier',
    'customMultiplier',
    'multiplierLocked',
    'modelMapping',
    'capabilities',
    'sync',
    'rateLimit',
    'autoRecovery',
    'manualEnabled',
    'failureDisabled'
  ]) {
    if (Object.hasOwn(patch, key)) {
      allowed[key] = patch[key];
    }
  }
  if (Object.hasOwn(patch, 'enabled')) {
    allowed.manualEnabled = Boolean(patch.enabled);
  }
  return allowed;
}

function normalizeSamePriorityStrategy(value) {
  return value === 'random' ? 'random' : 'round-robin';
}

function normalizePriorityMode(value) {
  return value === 'multiplier' ? 'multiplier' : DEFAULT_PRIORITY_MODE;
}

function getRateLimitWindowMs(rateLimit) {
  const multiplier = rateLimit.windowUnit === 'hour' ? 60 * 60 * 1000 : 60 * 1000;
  return rateLimit.windowValue * multiplier;
}

function isDueSiteSyncSite(site, nowMs, settings = DEFAULT_SITE_SYNC_SETTINGS) {
  const sync = site.sync;
  if (!isConfiguredSiteSyncSite(site, settings)) {
    return false;
  }

  if (!sync.lastSyncAt) {
    return true;
  }

  const lastSyncMs = new Date(sync.lastSyncAt).getTime();
  if (!Number.isFinite(lastSyncMs)) {
    return true;
  }

  return lastSyncMs + getEffectiveSiteSyncIntervalMs(site, settings, new Date(nowMs)) <= nowMs;
}

function getEffectiveSiteSyncIntervalMs(site, settings = DEFAULT_SITE_SYNC_SETTINGS, now = new Date()) {
  const normalizedSite = normalizeSite(site);
  const normalizedSettings = normalizeSiteSyncSettings(settings);
  const baseIntervalMs = normalizedSite.sync.intervalMode === 'custom'
    ? getSiteSyncIntervalMs(normalizedSite.sync)
    : getSiteSyncSettingsIntervalMs(normalizedSettings);

  if (!normalizedSettings.intelligentScheduling) {
    return baseIntervalMs;
  }

  if (isAuthenticationSyncFailure(normalizedSite.sync)) {
    return Number.POSITIVE_INFINITY;
  }

  let effectiveIntervalMs = baseIntervalMs;
  if (normalizedSite.sync.lastSyncStatus === 'failure') {
    effectiveIntervalMs *= 2;
  }

  const nowMs = new Date(now).getTime();
  const lastRequestMs = normalizedSite.lastRequestAt
    ? new Date(normalizedSite.lastRequestAt).getTime()
    : null;
  if (Number.isFinite(nowMs) && Number.isFinite(lastRequestMs) && nowMs - lastRequestMs >= 24 * 60 * 60 * 1000) {
    effectiveIntervalMs *= 4;
  }

  return Math.min(effectiveIntervalMs, 24 * 60 * 60 * 1000);
}

function isPreheatSiteSyncSite(site, nowMs, settings = DEFAULT_SITE_SYNC_SETTINGS) {
  if (!normalizeSiteSyncSettings(settings).intelligentScheduling) {
    return false;
  }
  if (!isConfiguredSiteSyncSite(site, settings)) {
    return false;
  }
  if (!site.sync.lastSyncAt) {
    return false;
  }

  const lastSyncMs = new Date(site.sync.lastSyncAt).getTime();
  if (!Number.isFinite(lastSyncMs)) {
    return false;
  }

  const intervalMs = getEffectiveSiteSyncIntervalMs(site, settings, new Date(nowMs));
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return false;
  }

  const nextSyncMs = lastSyncMs + intervalMs;
  if (nowMs >= nextSyncMs) {
    return false;
  }

  return nowMs >= nextSyncMs - getSiteSyncPreheatLeadMs(intervalMs);
}

function getSiteSyncPreheatLeadMs(intervalMs) {
  return Math.max(
    SITE_SYNC_PREHEAT_MIN_LEAD_MS,
    Math.min(SITE_SYNC_PREHEAT_MAX_LEAD_MS, intervalMs * SITE_SYNC_PREHEAT_LEAD_RATIO)
  );
}

function shouldSkipSiteSyncSite(site, settings = DEFAULT_SITE_SYNC_SETTINGS) {
  const normalizedSettings = normalizeSiteSyncSettings(settings);
  return normalizedSettings.intelligentScheduling && isAuthenticationSyncFailure(site.sync);
}

function isConfiguredSiteSyncSite(site, settings = DEFAULT_SITE_SYNC_SETTINGS) {
  const sync = site.sync;
  if (!sync.enabled || !sync.dashboardUrl || !sync.username || !sync.password) {
    return false;
  }
  return !shouldSkipSiteSyncSite(site, settings);
}

function isConfiguredGroupSyncSite(site) {
  const sync = normalizeSite(site).sync;
  return Boolean(sync.enabled && sync.dashboardUrl && sync.username && sync.password);
}

function getSiteSyncWebsiteKey(site) {
  const sync = normalizeSite(site).sync;
  return getWebsiteKey(sync.dashboardUrl);
}

function getWebsiteKey(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

function shouldPersistSyncedMultiplier(site, multiplier) {
  return !site?.multiplierLocked && Number.isFinite(multiplier) && multiplier >= 0;
}

function unifyWebsiteCustomMultipliers(sites = [], {
  preferredByKey = new Map(),
  preferNonNull = false,
  updatedAt = null
} = {}) {
  const normalizedSites = sites.map(normalizeSite);
  const multiplierByKey = new Map();

  for (const site of normalizedSites) {
    const key = getSiteSyncWebsiteKey(site);
    if (!key) {
      continue;
    }
    if (!multiplierByKey.has(key)) {
      multiplierByKey.set(key, site.customMultiplier);
      continue;
    }
    if (
      preferNonNull &&
      multiplierByKey.get(key) === null &&
      site.customMultiplier !== null
    ) {
      multiplierByKey.set(key, site.customMultiplier);
    }
  }

  for (const [key, multiplier] of preferredByKey) {
    multiplierByKey.set(normalizeWebsiteKey(key), multiplier);
  }

  return normalizedSites.map((site) => {
    const key = getSiteSyncWebsiteKey(site);
    if (!key || !multiplierByKey.has(key)) {
      return site;
    }
    const customMultiplier = multiplierByKey.get(key);
    if (site.customMultiplier === customMultiplier) {
      return site;
    }
    return normalizeSite({
      ...site,
      customMultiplier,
      ...(updatedAt ? { updatedAt } : {})
    });
  });
}

function normalizeWebsiteKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeOptionalIso(value) {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeAutoProvisionAttempts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const accountId = String(entry?.accountId ?? '').trim();
      const groupId = String(entry?.groupId ?? '').trim();
      if (!accountId || !groupId) {
        return null;
      }
      const lastAttemptAt = normalizeOptionalIso(entry?.lastAttemptAt);
      const nextAttemptAt = normalizeOptionalIso(entry?.nextAttemptAt);
      return {
        accountId,
        groupId,
        groupName: String(entry?.groupName ?? '').trim(),
        lastAttemptAt,
        nextAttemptAt,
        status: entry?.status === 'success' ? 'success' : 'failure',
        error: entry?.error ? String(entry.error).slice(0, 1000) : null
      };
    })
    .filter(Boolean);
}

function isDueGroupSyncWebsite(website, nowMs, intervalMs) {
  if (!website?.lastRefreshAt) {
    return true;
  }

  const lastRefreshMs = new Date(website.lastRefreshAt).getTime();
  if (!Number.isFinite(lastRefreshMs)) {
    return true;
  }

  return lastRefreshMs + intervalMs <= nowMs;
}

function isPreheatGroupSyncWebsite(website, nowMs, intervalMs) {
  if (!website?.lastRefreshAt) {
    return false;
  }

  const lastRefreshMs = new Date(website.lastRefreshAt).getTime();
  if (!Number.isFinite(lastRefreshMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return false;
  }

  const nextRefreshMs = lastRefreshMs + intervalMs;
  if (nowMs >= nextRefreshMs) {
    return false;
  }

  return nowMs >= nextRefreshMs - getGroupSyncPreheatLeadMs(intervalMs);
}

function getGroupSyncPreheatLeadMs(intervalMs) {
  return Math.min(
    SITE_SYNC_PREHEAT_MAX_LEAD_MS,
    intervalMs * SITE_SYNC_PREHEAT_LEAD_RATIO
  );
}

function mergeGroupSyncResultIntoSite(site, { result, groups, representative, now }) {
  const normalized = normalizeSite(site);
  const at = result?.syncPatch?.lastSyncAt ?? nowIso(now);
  const remotePatch = result?.syncPatch?.remote ?? {};
  const groupSource = Array.isArray(groups) ? groups : [];

  if (representative) {
    const keyGroup = remotePatch.keyGroup ?? normalized.sync.remote.keyGroup;
    const groupId = remotePatch.groupId ?? normalized.sync.remote.groupId;
    const selectedGroups = markRemoteGroupsSelected(groupSource, { keyGroup, groupId });
    const selectedGroup = findMatchingRemoteGroup({ keyGroup, groupId }, selectedGroups);
    const groupMultiplier = selectedGroup?.multiplier ?? remotePatch.groupMultiplier ?? normalized.sync.remote.groupMultiplier;
    const nextMultiplier = Number.isFinite(result?.multiplier) && result.multiplier >= 0
      ? result.multiplier
      : Number.isFinite(groupMultiplier)
        ? groupMultiplier
        : normalized.multiplier;
    return normalizeSite({
      ...normalized,
      ...(!normalized.multiplierLocked ? { multiplier: nextMultiplier } : {}),
      sync: {
        ...normalized.sync,
        ...result.syncPatch,
        remote: {
          ...normalized.sync.remote,
          ...remotePatch,
          groupMultiplier,
          groups: selectedGroups
        }
      },
      updatedAt: at
    });
  }

  const selectedGroups = markRemoteGroupsSelected(groupSource, normalized.sync.remote);
  const selectedGroup = findMatchingRemoteGroup(normalized.sync.remote, selectedGroups);
  const nextGroupMultiplier = selectedGroup?.multiplier ?? normalized.sync.remote.groupMultiplier;
  return normalizeSite({
    ...normalized,
    ...(!normalized.multiplierLocked && Number.isFinite(selectedGroup?.multiplier)
      ? { multiplier: selectedGroup.multiplier }
      : {}),
    sync: {
      ...normalized.sync,
      lastSyncAt: at,
      lastSyncStatus: 'success',
      lastSyncError: null,
      remote: {
        ...normalized.sync.remote,
        groupMultiplier: nextGroupMultiplier,
        groups: selectedGroups
      }
    },
    updatedAt: at
  });
}

function markRemoteGroupsSelected(groups, remote = {}) {
  const selectedGroup = findMatchingRemoteGroup(remote, groups);
  const selectedId = String(selectedGroup?.id ?? '').trim();
  const selectedName = String(selectedGroup?.name ?? '').trim();

  return groups.map((group) => ({
    ...group,
    selected: Boolean(
      (selectedId && String(group.id ?? '').trim() === selectedId) ||
        (selectedName && group.name === selectedName)
    )
  }));
}

function findMatchingRemoteGroup(remote = {}, groups = []) {
  const groupId = String(remote.groupId ?? '').trim();
  const keyGroup = String(remote.keyGroup ?? '').trim();
  return groups.find((group) =>
    (groupId && String(group.id ?? '').trim() === groupId) ||
      (keyGroup && group.name === keyGroup)
  ) ?? null;
}

function normalizePreheatCandidateLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return DEFAULT_SITE_SYNC_PREHEAT_CANDIDATE_LIMIT;
  }
  return Math.min(number, MAX_SITE_SYNC_PREHEAT_CANDIDATE_LIMIT);
}

function isAuthenticationSyncFailure(sync = {}) {
  if (sync.lastSyncStatus !== 'failure' || !sync.lastSyncError) {
    return false;
  }
  return /login|password|auth|token|credential|unauthorized|forbidden|401|403|登录|登陆|认证|鉴权|授权|密码|令牌/i
    .test(String(sync.lastSyncError));
}

function validateSite(site, proxy = DEFAULT_STATE.proxy) {
  if (!site.name?.trim()) {
    throw new Error('site name is required');
  }
  if (!site.apiKey?.trim()) {
    throw new Error('site apiKey is required');
  }
  let parsed = null;
  try {
    parsed = new URL(site.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error('site baseUrl must be a valid HTTP(S) URL');
  }
  if (isLocalProxyUrl(parsed, proxy)) {
    throw new Error('site baseUrl must not point to the local proxy');
  }
}

function isLocalProxyUrl(parsed, proxy) {
  const proxyPort = Number(proxy?.port);
  if (!Number.isInteger(proxyPort) || proxyPort <= 0) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));

  return (
    port === proxyPort &&
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
  );
}

function disableLocalProxySite(site, proxy, now = new Date()) {
  const normalized = normalizeSite(site);
  let parsed = null;
  try {
    parsed = new URL(normalized.baseUrl);
  } catch {
    return normalized;
  }

  if (!isLocalProxyUrl(parsed, proxy)) {
    return normalized;
  }
  if (normalized.failureDisabled && normalized.lastError?.message === 'Site baseUrl points to the local proxy') {
    return {
      ...normalized,
      enabled: false
    };
  }

  const at = nowIso(now);
  const failure = {
    at,
    statusCode: null,
    message: 'Site baseUrl points to the local proxy',
    detail: `${normalized.baseUrl} matches local proxy port ${proxy.port}`
  };

  return {
    ...normalized,
    status: 'error',
    failureDisabled: true,
    enabled: false,
    consecutiveErrors: normalized.consecutiveErrors + 1,
    errorCount: normalized.errorCount + 1,
    lastErrorAt: at,
    lastError: failure,
    errorLog: [failure, ...normalized.errorLog].slice(0, MAX_ERROR_LOG_SIZE),
    updatedAt: at
  };
}

function prepareAutoRecoverySchedule(site, { previousEnabled, autoRecoveryPatch, now }) {
  const normalized = normalizeSite(site);

  if (!normalized.manualEnabled || !normalized.failureDisabled || !normalized.autoRecovery.enabled) {
    return {
      ...normalized,
      autoRecoveryState: {
        ...normalized.autoRecoveryState,
        nextCheckAt: null
      }
    };
  }

  const becameDisabled = Boolean(previousEnabled) && !normalized.enabled;
  const shouldSchedule =
    becameDisabled || autoRecoveryPatch || !normalized.autoRecoveryState.nextCheckAt;

  if (!shouldSchedule) {
    return normalized;
  }

  return {
    ...normalized,
    autoRecoveryState: {
      ...normalized.autoRecoveryState,
      nextCheckAt: getNextAutoRecoveryCheckAt(normalized, now)
    }
  };
}
