export const DEFAULT_FAILURE_THRESHOLD = 3;
export const MAX_ERROR_LOG_SIZE = 20;
export const MAX_ERROR_DETAIL_LENGTH = 1000;
export const DEFAULT_TEST_MODEL = 'example-chat-model';
export const DEFAULT_SITE_MULTIPLIER = 1;
export const DEFAULT_PRIORITY_MODE = 'priority';
export const DEFAULT_RATE_LIMIT = {
  enabled: false,
  limit: 60,
  windowValue: 1,
  windowUnit: 'minute'
};
export const DEFAULT_RATE_LIMIT_STATE = {
  windowStartedAt: null,
  used: 0,
  pausedUntil: null
};
export const DEFAULT_AUTO_RECOVERY = {
  enabled: false,
  intervalValue: 30,
  intervalUnit: 'minute'
};
export const DEFAULT_AUTO_RECOVERY_STATE = {
  lastCheckedAt: null,
  nextCheckAt: null,
  lastResult: null,
  lastMessage: null
};
export const DEFAULT_SITE_SYNC_REMOTE = {
  providerType: null,
  authType: null,
  accountName: '',
  balance: '',
  apiEndpoint: '',
  keyName: '',
  remoteKeyId: '',
  keyGroup: '',
  groupId: '',
  groupMultiplier: null,
  groups: []
};
export const DEFAULT_SITE_SYNC_SETTINGS = {
  intervalValue: 30,
  intervalUnit: 'minute',
  intelligentScheduling: true
};
export const DEFAULT_GROUP_SYNC_SETTINGS = {
  intervalValue: 30,
  intervalUnit: 'minute',
  websites: []
};
export const DEFAULT_MODEL_MAPPING = {
  enabled: false,
  mappings: []
};
export const SITE_CAPABILITY_KEYS = [
  'textGeneration',
  'imageGeneration',
  'embeddings',
  'audioTranscription',
  'audioSpeech',
  'vision',
  'reasoning',
  'toolCalling',
  'moderation',
  'rerank'
];
export const DEFAULT_SITE_CAPABILITIES = {
  models: [],
  features: Object.fromEntries(SITE_CAPABILITY_KEYS.map((key) => [key, false])),
  featureModels: Object.fromEntries(SITE_CAPABILITY_KEYS.map((key) => [key, []])),
  checkedAt: null,
  lastStatus: null,
  lastError: null,
  source: null
};
export const DEFAULT_SITE_SYNC = {
  enabled: false,
  dashboardUrl: '',
  username: '',
  password: '',
  providerType: 'auto',
  intervalMode: 'global',
  intervalValue: DEFAULT_SITE_SYNC_SETTINGS.intervalValue,
  intervalUnit: DEFAULT_SITE_SYNC_SETTINGS.intervalUnit,
  lastSyncAt: null,
  lastSyncStatus: null,
  lastSyncError: null,
  remote: DEFAULT_SITE_SYNC_REMOTE
};
export const REQUEST_STATS_PERIODS = ['hour', 'day', 'week', 'month'];
export const MAX_REQUEST_STATS_BUCKETS = {
  hour: 48,
  day: 60,
  week: 26,
  month: 24
};

export function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

export function normalizeSite(site = {}) {
  const lastRequestAt = latestIso(site.lastRequestAt, site.lastSuccessAt, site.lastErrorAt);
  const manualEnabled = site.manualEnabled !== undefined
    ? Boolean(site.manualEnabled)
    : Boolean(site.enabled ?? true);
  const failureDisabled = Boolean(site.failureDisabled);

  return {
    id: site.id ?? '',
    name: site.name ?? '',
    remark: typeof site.remark === 'string' ? site.remark : '',
    baseUrl: site.baseUrl ?? '',
    apiKey: site.apiKey ?? '',
    testModel: site.testModel?.trim() || DEFAULT_TEST_MODEL,
    priority: Number.isFinite(Number(site.priority)) ? Number(site.priority) : 100,
    multiplier: normalizeSiteMultiplier(site.multiplier),
    modelMapping: normalizeModelMapping(site.modelMapping),
    capabilities: normalizeSiteCapabilities(site.capabilities),
    sync: normalizeSiteSync(site.sync),
    rateLimit: normalizeRateLimit(site.rateLimit),
    rateLimitState: normalizeRateLimitState(site.rateLimitState),
    autoRecovery: normalizeAutoRecovery(site.autoRecovery),
    autoRecoveryState: normalizeAutoRecoveryState(site.autoRecoveryState),
    manualEnabled,
    failureDisabled,
    enabled: manualEnabled && !failureDisabled,
    status: site.status ?? 'idle',
    consecutiveErrors: Number.isFinite(site.consecutiveErrors) ? site.consecutiveErrors : 0,
    requestCount: Number.isFinite(site.requestCount) ? site.requestCount : 0,
    successCount: Number.isFinite(site.successCount) ? site.successCount : 0,
    errorCount: Number.isFinite(site.errorCount) ? site.errorCount : 0,
    requestStats: normalizeRequestStats(site.requestStats),
    lastRequestAt,
    lastSuccessAt: site.lastSuccessAt ?? null,
    lastErrorAt: site.lastErrorAt ?? null,
    lastSuccess: site.lastSuccess ?? null,
    lastError: normalizeErrorEntry(site.lastError),
    errorLog: normalizeErrorLog(site.errorLog),
    createdAt: site.createdAt ?? nowIso(),
    updatedAt: site.updatedAt ?? nowIso()
  };
}

function normalizeSiteMultiplier(value) {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_SITE_MULTIPLIER;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : DEFAULT_SITE_MULTIPLIER;
}

export function normalizeSiteSync(sync = {}) {
  const source = sync && typeof sync === 'object' ? sync : {};

  return {
    enabled: Boolean(source.enabled),
    dashboardUrl: normalizeTrimmedString(source.dashboardUrl),
    username: normalizeTrimmedString(source.username),
    password: normalizeTrimmedString(source.password),
    providerType: normalizeSiteSyncProviderType(source.providerType),
    intervalMode: normalizeSiteSyncIntervalMode(source),
    intervalValue: normalizeSiteSyncIntervalValue(source.intervalValue),
    intervalUnit: normalizeSiteSyncIntervalUnit(source.intervalUnit),
    lastSyncAt: normalizeOptionalIso(source.lastSyncAt),
    lastSyncStatus: normalizeSiteSyncStatus(source.lastSyncStatus),
    lastSyncError: source.lastSyncError ? String(source.lastSyncError) : null,
    remote: normalizeSiteSyncRemote(source.remote)
  };
}

export function normalizeSiteSyncSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};

  return {
    intervalValue: normalizeSiteSyncIntervalValue(source.intervalValue),
    intervalUnit: normalizeSiteSyncIntervalUnit(source.intervalUnit),
    intelligentScheduling: source.intelligentScheduling === undefined
      ? DEFAULT_SITE_SYNC_SETTINGS.intelligentScheduling
      : Boolean(source.intelligentScheduling)
  };
}

export function normalizeGroupSyncSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};

  return {
    intervalValue: normalizeSiteSyncIntervalValue(source.intervalValue),
    intervalUnit: normalizeSiteSyncIntervalUnit(source.intervalUnit),
    websites: normalizeGroupSyncWebsites(source.websites)
  };
}

export function normalizeModelMapping(modelMapping = {}) {
  const source = modelMapping && typeof modelMapping === 'object' ? modelMapping : {};

  return {
    enabled: Boolean(source.enabled),
    mappings: normalizeModelMappingEntries(source.mappings)
  };
}

export function normalizeSiteCapabilities(capabilities = {}) {
  const source = capabilities && typeof capabilities === 'object' ? capabilities : {};
  return {
    models: normalizeUniqueStringList(source.models),
    features: normalizeCapabilityFlags(source.features),
    featureModels: normalizeCapabilityModelBuckets(source.featureModels),
    checkedAt: normalizeOptionalIso(source.checkedAt),
    lastStatus: normalizeCapabilityStatus(source.lastStatus),
    lastError: source.lastError ? String(source.lastError).slice(0, MAX_ERROR_DETAIL_LENGTH) : null,
    source: source.source ? String(source.source).slice(0, 120) : null
  };
}

function normalizeCapabilityFlags(features = {}) {
  const source = features && typeof features === 'object' ? features : {};
  return Object.fromEntries(
    SITE_CAPABILITY_KEYS.map((key) => [key, Boolean(source[key])])
  );
}

function normalizeCapabilityModelBuckets(featureModels = {}) {
  const source = featureModels && typeof featureModels === 'object' ? featureModels : {};
  return Object.fromEntries(
    SITE_CAPABILITY_KEYS.map((key) => [key, normalizeUniqueStringList(source[key])])
  );
}

function normalizeCapabilityStatus(value) {
  return value === 'success' || value === 'failure' ? value : null;
}

function normalizeModelMappingEntries(entries = []) {
  const normalizedEntries = Array.isArray(entries)
    ? entries.map(normalizeModelMappingEntry)
    : normalizeModelMappingRecord(entries);
  const seen = new Set();
  const uniqueEntries = [];

  for (const entry of normalizedEntries) {
    if (!entry || seen.has(entry.from)) {
      continue;
    }
    seen.add(entry.from);
    uniqueEntries.push(entry);
  }

  return uniqueEntries;
}

function normalizeModelMappingRecord(record = {}) {
  if (!record || typeof record !== 'object') {
    return [];
  }
  return Object.entries(record).map(([from, to]) => normalizeModelMappingEntry({ from, to }));
}

function normalizeModelMappingEntry(entry = {}) {
  const source = Array.isArray(entry)
    ? { from: entry[0], to: entry[1] }
    : entry && typeof entry === 'object'
      ? entry
      : {};
  const from = normalizeTrimmedString(source.from);
  const to = normalizeTrimmedString(source.to);

  if (!from || !to) {
    return null;
  }

  return { from, to };
}

function normalizeUniqueStringList(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const text = normalizeTrimmedString(value);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeSiteSyncRemote(remote = {}) {
  const source = remote && typeof remote === 'object' ? remote : {};

  return {
    providerType: normalizeNullableProviderType(source.providerType),
    authType: source.authType ? String(source.authType) : null,
    accountName: normalizeTrimmedString(source.accountName),
    balance: normalizeTrimmedString(source.balance),
    apiEndpoint: normalizeTrimmedString(source.apiEndpoint),
    keyName: normalizeTrimmedString(source.keyName),
    remoteKeyId: normalizeRemoteId(source.remoteKeyId),
    keyGroup: normalizeTrimmedString(source.keyGroup),
    groupId: normalizeRemoteId(source.groupId),
    groupMultiplier: normalizeOptionalMultiplier(source.groupMultiplier),
    groups: normalizeSiteSyncRemoteGroups(source.groups)
  };
}

function normalizeSiteSyncRemoteGroups(groups = []) {
  if (!Array.isArray(groups)) {
    return [];
  }

  const seen = new Set();
  const normalizedGroups = [];
  for (const group of groups) {
    const normalized = normalizeSiteSyncRemoteGroup(group);
    if (!normalized) {
      continue;
    }
    const key = `${normalized.name}\n${normalized.multiplier ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalizedGroups.push(normalized);
  }
  return normalizedGroups;
}

function normalizeGroupSyncWebsites(websites = []) {
  if (!Array.isArray(websites)) {
    return [];
  }

  const seen = new Set();
  const normalizedWebsites = [];
  for (const website of websites) {
    const normalized = normalizeGroupSyncWebsite(website);
    if (!normalized || seen.has(normalized.key)) {
      continue;
    }
    seen.add(normalized.key);
    normalizedWebsites.push(normalized);
  }
  return normalizedWebsites;
}

function normalizeGroupSyncWebsite(website = {}) {
  if (!website || typeof website !== 'object') {
    return null;
  }
  const key = normalizeTrimmedString(website.key).toLowerCase();
  if (!key) {
    return null;
  }

  return {
    key,
    dashboardUrl: normalizeTrimmedString(website.dashboardUrl),
    providerType: normalizeSiteSyncProviderType(website.providerType),
    username: normalizeTrimmedString(website.username),
    lastRefreshAt: normalizeOptionalIso(website.lastRefreshAt),
    lastRefreshStatus: normalizeSiteSyncStatus(website.lastRefreshStatus),
    lastRefreshError: website.lastRefreshError ? String(website.lastRefreshError) : null,
    groups: normalizeSiteSyncRemoteGroups(website.groups)
  };
}

function normalizeSiteSyncRemoteGroup(group = {}) {
  if (!group || typeof group !== 'object') {
    return null;
  }

  const name = normalizeTrimmedString(group.name);
  if (!name) {
    return null;
  }

  return {
    id: group.id === null || group.id === undefined ? '' : String(group.id).trim(),
    name,
    multiplier: normalizeOptionalMultiplier(group.multiplier),
    selected: Boolean(group.selected)
  };
}

function normalizeRemoteId(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return '';
  }
  return String(value).trim();
}

function normalizeSiteSyncProviderType(value) {
  return value === 'modern-v1' || value === 'new-api' ? value : 'auto';
}

function normalizeNullableProviderType(value) {
  return value === 'modern-v1' || value === 'new-api' ? value : null;
}

function normalizeSiteSyncStatus(value) {
  return value === 'success' || value === 'failure' ? value : null;
}

function normalizeSiteSyncIntervalMode(source = {}) {
  if (source.intervalMode === 'custom') {
    return 'custom';
  }
  if (source.intervalMode === 'global') {
    return 'global';
  }
  return hasOwnInterval(source) ? 'custom' : DEFAULT_SITE_SYNC.intervalMode;
}

function hasOwnInterval(source) {
  return Object.hasOwn(source, 'intervalValue') || Object.hasOwn(source, 'intervalUnit');
}

function normalizeSiteSyncIntervalValue(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : DEFAULT_SITE_SYNC.intervalValue;
}

function normalizeSiteSyncIntervalUnit(value) {
  return value === 'hour' ? 'hour' : DEFAULT_SITE_SYNC.intervalUnit;
}

function normalizeTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalMultiplier(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    const match = value.match(/(\d+(?:\.\d+)?)\s*x/i);
    if (match) {
      return Number(match[1]);
    }
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function latestIso(...values) {
  return values
    .filter(Boolean)
    .map((value) => ({
      value,
      time: new Date(value).getTime()
    }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => b.time - a.time)[0]?.value ?? null;
}

export function normalizeRateLimit(rateLimit = {}) {
  const limit = Number(rateLimit.limit);
  const windowValue = Number(rateLimit.windowValue);
  const windowUnit = rateLimit.windowUnit === 'hour' ? 'hour' : 'minute';

  return {
    enabled: Boolean(rateLimit.enabled),
    limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RATE_LIMIT.limit,
    windowValue:
      Number.isInteger(windowValue) && windowValue > 0
        ? windowValue
        : DEFAULT_RATE_LIMIT.windowValue,
    windowUnit
  };
}

export function normalizeRateLimitState(rateLimitState = {}) {
  const used = Number(rateLimitState.used);
  return {
    windowStartedAt: rateLimitState.windowStartedAt ?? null,
    used: Number.isInteger(used) && used > 0 ? used : 0,
    pausedUntil: rateLimitState.pausedUntil ?? null
  };
}

export function normalizeAutoRecovery(autoRecovery = {}) {
  const intervalValue = Number(autoRecovery.intervalValue);
  const intervalUnit = autoRecovery.intervalUnit === 'hour' ? 'hour' : 'minute';

  return {
    enabled: Boolean(autoRecovery.enabled),
    intervalValue:
      Number.isInteger(intervalValue) && intervalValue > 0
        ? intervalValue
        : DEFAULT_AUTO_RECOVERY.intervalValue,
    intervalUnit
  };
}

export function normalizeAutoRecoveryState(autoRecoveryState = {}) {
  const lastResult =
    autoRecoveryState.lastResult === 'success' || autoRecoveryState.lastResult === 'failure'
      ? autoRecoveryState.lastResult
      : null;

  return {
    lastCheckedAt: normalizeOptionalIso(autoRecoveryState.lastCheckedAt),
    nextCheckAt: normalizeOptionalIso(autoRecoveryState.nextCheckAt),
    lastResult,
    lastMessage: autoRecoveryState.lastMessage ?? null
  };
}

export function normalizeRequestStats(requestStats = {}) {
  return Object.fromEntries(
    REQUEST_STATS_PERIODS.map((period) => [
      period,
      normalizeRequestStatBuckets(requestStats?.[period], period)
    ])
  );
}

export function recordRequestStats(requestStats, outcome, now = new Date()) {
  const normalized = normalizeRequestStats(requestStats);
  return Object.fromEntries(
    REQUEST_STATS_PERIODS.map((period) => [
      period,
      recordRequestStatsBucket(normalized[period], period, outcome, now)
    ])
  );
}

export function getAutoRecoveryIntervalMs(autoRecovery = {}) {
  const normalized = normalizeAutoRecovery(autoRecovery);
  const unitMs = normalized.intervalUnit === 'hour' ? 60 * 60 * 1000 : 60 * 1000;
  return normalized.intervalValue * unitMs;
}

export function getSiteSyncIntervalMs(sync = {}) {
  const normalized = normalizeSiteSync(sync);
  const unitMs = normalized.intervalUnit === 'hour' ? 60 * 60 * 1000 : 60 * 1000;
  return normalized.intervalValue * unitMs;
}

export function getSiteSyncSettingsIntervalMs(settings = {}) {
  const normalized = normalizeSiteSyncSettings(settings);
  const unitMs = normalized.intervalUnit === 'hour' ? 60 * 60 * 1000 : 60 * 1000;
  return normalized.intervalValue * unitMs;
}

export function getGroupSyncSettingsIntervalMs(settings = {}) {
  const normalized = normalizeGroupSyncSettings(settings);
  const unitMs = normalized.intervalUnit === 'hour' ? 60 * 60 * 1000 : 60 * 1000;
  return normalized.intervalValue * unitMs;
}

export function getNextAutoRecoveryCheckAt(site, now = new Date()) {
  const normalized = normalizeSite(site);
  if (!normalized.autoRecovery.enabled) {
    return null;
  }

  return new Date(new Date(now).getTime() + getAutoRecoveryIntervalMs(normalized.autoRecovery))
    .toISOString();
}

function normalizeOptionalIso(value) {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return null;
  }

  return new Date(time).toISOString();
}

export function recordSuccess(site, details = {}, now = new Date()) {
  const normalized = normalizeSite(site);
  const at = nowIso(now);
  const success = {
    at,
    statusCode: details.statusCode ?? null,
    message: details.message ?? 'Request succeeded'
  };

  return {
    ...normalized,
    status: 'success',
    consecutiveErrors: 0,
    requestCount: normalized.requestCount + 1,
    successCount: normalized.successCount + 1,
    requestStats: recordRequestStats(normalized.requestStats, 'success', now),
    lastRequestAt: at,
    lastSuccessAt: at,
    lastSuccess: success,
    updatedAt: at
  };
}

export function recordFailure(site, error = {}, now = new Date()) {
  const normalized = normalizeSite(site);
  const at = nowIso(now);
  const failure = createFailureEntry({
    ...error,
    affectsSiteHealth: error.affectsSiteHealth ?? true
  }, at);

  return {
    ...normalized,
    status: 'error',
    consecutiveErrors: normalized.consecutiveErrors + 1,
    requestCount: normalized.requestCount + 1,
    errorCount: normalized.errorCount + 1,
    requestStats: recordRequestStats(normalized.requestStats, 'failure', now),
    lastRequestAt: at,
    lastErrorAt: at,
    lastError: failure,
    errorLog: [failure, ...normalized.errorLog].slice(0, MAX_ERROR_LOG_SIZE),
    updatedAt: at
  };
}

export function recordRequestFailure(site, error = {}, now = new Date()) {
  const normalized = normalizeSite(site);
  const at = nowIso(now);
  const failure = createFailureEntry({
    ...error,
    affectsSiteHealth: false
  }, at);

  return {
    ...normalized,
    status: 'error',
    requestCount: normalized.requestCount + 1,
    errorCount: normalized.errorCount + 1,
    requestStats: recordRequestStats(normalized.requestStats, 'failure', now),
    lastRequestAt: at,
    lastErrorAt: at,
    lastError: failure,
    errorLog: [failure, ...normalized.errorLog].slice(0, MAX_ERROR_LOG_SIZE),
    updatedAt: at
  };
}

export function recordAvailabilityFailure(site, error = {}, now = new Date()) {
  const normalized = normalizeSite(site);
  const at = nowIso(now);
  const failure = createFailureEntry({
    ...error,
    affectsSiteHealth: error.affectsSiteHealth ?? false
  }, at);

  return {
    ...normalized,
    status: 'error',
    lastErrorAt: at,
    lastError: failure,
    errorLog: [failure, ...normalized.errorLog].slice(0, MAX_ERROR_LOG_SIZE),
    updatedAt: at
  };
}

function createFailureEntry(error = {}, at = nowIso()) {
  const entry = {
    at,
    statusCode: error.statusCode ?? error.status ?? null,
    message: error.message ?? 'Request failed',
    detail: trimErrorDetail(error.detail)
  };
  if (typeof error.affectsSiteHealth === 'boolean') {
    entry.affectsSiteHealth = error.affectsSiteHealth;
  }
  return entry;
}

function normalizeErrorLog(errorLog) {
  if (!Array.isArray(errorLog)) {
    return [];
  }
  return errorLog.map(normalizeErrorEntry).filter(Boolean).slice(0, MAX_ERROR_LOG_SIZE);
}

function normalizeErrorEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  return {
    at: entry.at ?? nowIso(),
    statusCode: entry.statusCode ?? null,
    message: entry.message ?? 'Request failed',
    detail: trimErrorDetail(entry.detail),
    ...(typeof entry.affectsSiteHealth === 'boolean'
      ? { affectsSiteHealth: entry.affectsSiteHealth }
      : {})
  };
}

function trimErrorDetail(detail) {
  if (detail === null || detail === undefined) {
    return null;
  }
  const text = String(detail);
  return text.length > MAX_ERROR_DETAIL_LENGTH ? text.slice(0, MAX_ERROR_DETAIL_LENGTH) : text;
}

export function shouldSwitchAfterFailure(site, threshold = DEFAULT_FAILURE_THRESHOLD) {
  const consecutiveErrors = normalizeSite(site).consecutiveErrors;
  const limit = Number(threshold);
  if (!Number.isInteger(limit) || limit <= 0) {
    return consecutiveErrors > 0;
  }
  return consecutiveErrors >= limit;
}

export function calculateSiteScore(site) {
  const normalized = normalizeSite(site);

  if (!isUsableNormalizedSite(normalized)) {
    return Number.NEGATIVE_INFINITY;
  }

  return calculateNormalizedSiteScore(normalized);
}

function calculateNormalizedSiteScore(normalized) {
  const successRate =
    normalized.requestCount === 0 ? 0 : normalized.successCount / normalized.requestCount;
  const healthStatus =
    normalized.status === 'error' && normalized.lastError?.affectsSiteHealth === false
      ? 'idle'
      : normalized.status;
  const statusBonus = healthStatus === 'success' ? 50 : healthStatus === 'idle' ? 20 : 0;
  const errorPenalty = normalized.consecutiveErrors * 20;
  const successBonus = normalized.successCount * 2 + successRate * 30;

  return statusBonus + successBonus - errorPenalty;
}

export function chooseBestSite(sites = [], options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const excludeSiteIds = new Set(options.excludeSiteIds ?? []);
  const priorityMode = normalizePriorityMode(options.priorityMode);
  let topRank = null;
  let candidateGroup = [];

  for (const candidate of sites) {
    if (excludeSiteIds.has(candidate.id)) {
      continue;
    }

    const site = normalizeSite(candidate);
    if (!isUsableNormalizedSite(site) || isRateLimitPausedNormalized(site, now)) {
      continue;
    }

    const rank = getSelectionRank(site, priorityMode);
    const rankOrder = topRank ? compareSelectionRanks(rank, topRank) : -1;
    if (rankOrder < 0) {
      topRank = rank;
      candidateGroup = [site];
    } else if (rankOrder === 0) {
      candidateGroup.push(site);
    }
  }

  if (candidateGroup.length === 0) {
    return null;
  }

  candidateGroup.sort((a, b) => a.name.localeCompare(b.name));

  if (candidateGroup.length === 1) {
    return candidateGroup[0];
  }

  if (options.samePriorityStrategy === 'random') {
    const random = options.random ?? Math.random;
    const index = Math.min(candidateGroup.length - 1, Math.floor(random() * candidateGroup.length));
    return candidateGroup[index];
  }

  if (options.samePriorityStrategy === 'round-robin' && options.lastSelectedSiteId) {
    const lastIndex = candidateGroup.findIndex((site) => site.id === options.lastSelectedSiteId);
    if (lastIndex !== -1) {
      return candidateGroup[(lastIndex + 1) % candidateGroup.length];
    }
  }

  let best = candidateGroup[0];
  let bestScore = calculateNormalizedSiteScore(best);
  for (let index = 1; index < candidateGroup.length; index += 1) {
    const candidate = candidateGroup[index];
    const score = calculateNormalizedSiteScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function normalizePriorityMode(value) {
  return value === 'multiplier' ? 'multiplier' : DEFAULT_PRIORITY_MODE;
}

function getSelectionRank(site, priorityMode) {
  return priorityMode === 'multiplier'
    ? [site.multiplier, site.priority]
    : [site.priority, site.multiplier];
}

function compareSelectionRanks(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function isRateLimitPaused(site, now = new Date()) {
  const normalized = normalizeSite(site);
  return isRateLimitPausedNormalized(normalized, now);
}

function isRateLimitPausedNormalized(normalized, now = new Date()) {
  if (!normalized.rateLimit.enabled || !normalized.rateLimitState.pausedUntil) {
    return false;
  }
  return new Date(normalized.rateLimitState.pausedUntil).getTime() > new Date(now).getTime();
}

export function chooseFailoverSite(sites = [], failedSiteId, options = {}) {
  return chooseBestSite(
    sites.filter((site) => site.id !== failedSiteId),
    options
  );
}

export function isUsableSite(site) {
  const normalized = normalizeSite(site);
  return isUsableNormalizedSite(normalized);
}

function isUsableNormalizedSite(normalized) {
  return Boolean(
    normalized.id &&
      normalized.manualEnabled &&
      !normalized.failureDisabled &&
      normalized.name.trim() &&
      normalized.baseUrl.trim() &&
      normalized.apiKey.trim()
  );
}

function normalizeRequestStatBuckets(buckets = [], period) {
  if (!Array.isArray(buckets)) {
    return [];
  }

  return trimRequestStatsBuckets(
    buckets
      .map((bucket) => normalizeRequestStatBucket(bucket, period))
      .filter(Boolean)
      .sort(compareRequestStatBuckets),
    period
  );
}

function normalizeRequestStatBucket(bucket = {}, period) {
  const key = typeof bucket.key === 'string' ? bucket.key.trim() : '';
  if (!key) {
    return null;
  }

  const successCount = normalizeNonNegativeInteger(bucket.successCount);
  const errorCount = normalizeNonNegativeInteger(bucket.errorCount);
  const startedAt = normalizeOptionalIso(bucket.startedAt) ?? inferRequestStatsStartedAt(period, key);
  if (!startedAt) {
    return null;
  }

  return {
    key,
    startedAt,
    requestCount: successCount + errorCount,
    successCount,
    errorCount
  };
}

function recordRequestStatsBucket(buckets, period, outcome, now) {
  const bucketIdentity = getRequestStatsBucketIdentity(period, now);
  const successIncrement = outcome === 'success' ? 1 : 0;
  const errorIncrement = outcome === 'success' ? 0 : 1;
  const existingIndex = buckets.findIndex((bucket) => bucket.key === bucketIdentity.key);
  const existing = existingIndex === -1 ? null : buckets[existingIndex];
  const nextBucket = {
    ...(existing ?? bucketIdentity),
    successCount: (existing?.successCount ?? 0) + successIncrement,
    errorCount: (existing?.errorCount ?? 0) + errorIncrement
  };
  nextBucket.requestCount = nextBucket.successCount + nextBucket.errorCount;

  if (existingIndex !== -1) {
    const nextBuckets = buckets.slice();
    nextBuckets[existingIndex] = nextBucket;
    return trimRequestStatsBuckets(nextBuckets, period);
  }

  const nextBuckets = [...buckets, nextBucket];
  if (
    buckets.length > 0 &&
    compareRequestStatBuckets(buckets[buckets.length - 1], nextBucket) > 0
  ) {
    nextBuckets.sort(compareRequestStatBuckets);
  }
  return trimRequestStatsBuckets(nextBuckets, period);
}

function getRequestStatsBucketIdentity(period, now = new Date()) {
  const date = new Date(now);
  const startedAt = getRequestStatsBucketStart(period, date);
  return {
    key: formatRequestStatsBucketKey(period, startedAt),
    startedAt: startedAt.toISOString(),
    requestCount: 0,
    successCount: 0,
    errorCount: 0
  };
}

function getRequestStatsBucketStart(period, date) {
  if (period === 'hour') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
  }
  if (period === 'day') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }
  if (period === 'week') {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
    return start;
  }
  if (period === 'month') {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatRequestStatsBucketKey(period, startedAt) {
  const year = startedAt.getFullYear();
  const month = padDatePart(startedAt.getMonth() + 1);
  const day = padDatePart(startedAt.getDate());
  if (period === 'hour') {
    return `${year}-${month}-${day}T${padDatePart(startedAt.getHours())}`;
  }
  if (period === 'day') {
    return `${year}-${month}-${day}`;
  }
  if (period === 'week') {
    return `${getIsoWeekYear(startedAt)}-W${padDatePart(getIsoWeekNumber(startedAt))}`;
  }
  if (period === 'month') {
    return `${year}-${month}`;
  }
  return `${year}-${month}-${day}`;
}

function inferRequestStatsStartedAt(period, key) {
  if (period === 'hour') {
    const match = key.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
    if (!match) {
      return null;
    }
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4])
    ).toISOString();
  }
  if (period === 'day') {
    const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return null;
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toISOString();
  }
  if (period === 'week') {
    const match = key.match(/^(\d{4})-W(\d{2})$/);
    if (!match) {
      return null;
    }
    return getDateFromIsoWeek(Number(match[1]), Number(match[2])).toISOString();
  }
  if (period === 'month') {
    const match = key.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      return null;
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, 1).toISOString();
  }
  return null;
}

function trimRequestStatsBuckets(buckets, period) {
  const max = MAX_REQUEST_STATS_BUCKETS[period] ?? 48;
  return buckets.slice(-max);
}

function compareRequestStatBuckets(left, right) {
  const leftTime = new Date(left.startedAt).getTime();
  const rightTime = new Date(right.startedAt).getTime();
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.key.localeCompare(right.key);
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function getIsoWeekYear(date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  target.setDate(target.getDate() + 4 - (target.getDay() || 7));
  return target.getFullYear();
}

function getIsoWeekNumber(date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  target.setDate(target.getDate() + 4 - (target.getDay() || 7));
  const yearStart = new Date(target.getFullYear(), 0, 1);
  return Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
}

function getDateFromIsoWeek(year, week) {
  const simple = new Date(year, 0, 1 + (week - 1) * 7);
  const day = simple.getDay() || 7;
  if (day <= 4) {
    simple.setDate(simple.getDate() - day + 1);
  } else {
    simple.setDate(simple.getDate() + 8 - day);
  }
  return new Date(simple.getFullYear(), simple.getMonth(), simple.getDate());
}

function padDatePart(part) {
  return String(part).padStart(2, '0');
}
