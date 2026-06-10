export async function loginAndFetchSiteSync({
  sync,
  apiKey = '',
  fetch: fetchImpl = globalThis.fetch,
  now = new Date(),
  timeoutMs = 30000
} = {}) {
  if (!fetchImpl) {
    throw new Error('fetch is required');
  }

  const startedAt = nowIso(now);
  try {
    const normalized = normalizeSyncInput(sync);
    const providerType = await resolveProviderType({
      sync: normalized,
      fetchImpl,
      timeoutMs
    });
    const result = await syncByProviderType({
      providerType,
      sync: normalized,
      apiKey,
      fetchImpl,
      timeoutMs
    });

    return {
      ok: true,
      multiplier: result.remote.groupMultiplier,
      syncPatch: {
        lastSyncAt: startedAt,
        lastSyncStatus: 'success',
        lastSyncError: null,
        remote: result.remote
      }
    };
  } catch (error) {
    return {
      ok: false,
      multiplier: null,
      syncPatch: {
        lastSyncAt: startedAt,
        lastSyncStatus: 'failure',
        lastSyncError: error.message || String(error)
      },
      error
    };
  }
}

export async function loginAndSwitchSiteGroup({
  sync,
  apiKey = '',
  group,
  fetch: fetchImpl = globalThis.fetch,
  now = new Date(),
  timeoutMs = 30000
} = {}) {
  if (!fetchImpl) {
    throw new Error('fetch is required');
  }

  const startedAt = nowIso(now);
  try {
    const normalized = normalizeSyncInput(sync);
    const selectedGroup = normalizeSwitchGroup(group);
    const providerType = await resolveProviderType({
      sync: normalized,
      fetchImpl,
      timeoutMs
    });
    const result = providerType === 'new-api'
      ? await switchNewApiGroup({
          sync: normalized,
          originalSync: sync,
          apiKey,
          group: selectedGroup,
          fetchImpl,
          timeoutMs
        })
      : await switchModernV1Group({
          sync: normalized,
          originalSync: sync,
          apiKey,
          group: selectedGroup,
          fetchImpl,
          timeoutMs
        });

    return {
      ok: true,
      multiplier: result.remote.groupMultiplier,
      syncPatch: {
        lastSyncAt: startedAt,
        lastSyncStatus: 'success',
        lastSyncError: null,
        remote: result.remote
      }
    };
  } catch (error) {
    return {
      ok: false,
      multiplier: null,
      syncPatch: {
        lastSyncAt: startedAt,
        lastSyncStatus: 'failure',
        lastSyncError: error.message || String(error)
      },
      error
    };
  }
}

export function detectProviderType(dashboardUrl, providerType = 'auto') {
  if (providerType === 'modern-v1' || providerType === 'new-api') {
    return providerType;
  }

  const parsed = parseUrl(dashboardUrl);
  if (parsed?.pathname.startsWith('/console')) {
    return 'new-api';
  }
  if (parsed?.pathname.startsWith('/keys') || parsed?.pathname.startsWith('/profile')) {
    return 'modern-v1';
  }
  return 'auto';
}

export function parseMultiplierFromText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const match = String(value).match(/(\d+(?:\.\d+)?)\s*x/i);
  if (!match) {
    return null;
  }
  const multiplier = Number(match[1]);
  return Number.isFinite(multiplier) ? multiplier : null;
}

async function syncModernV1({ sync, apiKey = '', fetchImpl, timeoutMs }) {
  const { apiBaseUrl, settingsPayload, headers } = await loginModernV1({
    sync,
    fetchImpl,
    timeoutMs
  });
  const [profile, keysPayload, groupsPayload, ratesPayload] = await Promise.all([
    requestOptionalJson(fetchImpl, joinApiPath(apiBaseUrl, '/user/profile'), { headers, signal: timeoutSignal(timeoutMs) }),
    requestOptionalJson(fetchImpl, joinApiPath(apiBaseUrl, '/keys?page=1&page_size=20'), { headers, signal: timeoutSignal(timeoutMs) }),
    requestOptionalJson(fetchImpl, joinApiPath(apiBaseUrl, '/groups/available'), { headers, signal: timeoutSignal(timeoutMs) }),
    requestOptionalJson(fetchImpl, joinApiPath(apiBaseUrl, '/groups/rates'), { headers, signal: timeoutSignal(timeoutMs) })
  ]);

  const key = selectRemoteKeyForConfiguredApiKey(keysPayload, apiKey);
  const keyGroup = pickFirstGroupName(key?.group, key?.group_name, key?.groupName, key?.groups?.[0]);
  const group = keyGroup ? findGroup(groupsPayload, keyGroup) : null;
  const groupName = key ? pickFirstGroupName(group, keyGroup) : '';
  const keyId = pickRemoteKeyId(key);
  const groupId = pickFirstString(key?.group_id, key?.groupId, group?.id, group?.key, group?.value);
  const groups = buildModernRemoteGroups({
    groupsPayload,
    ratesPayload,
    selectedGroupName: groupName
  });
  const multiplier = key
    ? pickMultiplier(
        getRateMultiplier(ratesPayload, groupName),
        key?.multiplier,
        key?.rate_multiplier,
        key?.rateMultiplier,
        key?.rate,
        key?.ratio,
        key?.group?.multiplier,
        key?.group?.rate_multiplier,
        key?.group?.rateMultiplier,
        key?.group?.rate,
        key?.group?.ratio,
        group?.multiplier,
        group?.rate_multiplier,
        group?.rateMultiplier,
        group?.rate,
        group?.ratio,
        parseMultiplierFromText(groupName)
      )
    : null;

  return {
    remote: {
      providerType: 'modern-v1',
      authType: 'Bearer auth_token (/api/v1)',
      accountName: getAccountName(profile, sync.username),
      balance: getBalanceText(profile),
      apiEndpoint: pickFirstString(
        key?.endpoint,
        key?.api_endpoint,
        key?.baseUrl,
        key?.base_url,
        getModernSettingsEndpoint(settingsPayload)
      ),
      keyName: pickFirstString(key?.name, key?.key_name, key?.label),
      remoteKeyId: keyId,
      keyGroup: groupName,
      groupId,
      groupMultiplier: multiplier,
      groups
    }
  };
}

async function resolveProviderType({ sync, fetchImpl, timeoutMs }) {
  const configuredProviderType = detectProviderType(sync.dashboardUrl, sync.providerType);
  if (configuredProviderType !== 'auto') {
    return configuredProviderType;
  }

  const publicProviderType = await detectPublicProviderType({
    dashboardUrl: sync.dashboardUrl,
    fetchImpl,
    timeoutMs
  });
  return publicProviderType ?? 'modern-v1';
}

async function detectPublicProviderType({ dashboardUrl, fetchImpl, timeoutMs }) {
  const origin = getOrigin(dashboardUrl);
  const [newApiStatusPayload, modernSettingsPayload] = await Promise.all([
    requestOptionalJson(fetchImpl, `${origin}/api/status`, { signal: timeoutSignal(timeoutMs) }),
    requestOptionalJson(fetchImpl, `${origin}/api/v1/settings/public`, { signal: timeoutSignal(timeoutMs) })
  ]);

  if (isNewApiStatusPayload(newApiStatusPayload)) {
    return 'new-api';
  }
  if (isModernSettingsPayload(modernSettingsPayload)) {
    return 'modern-v1';
  }
  return null;
}

function isNewApiStatusPayload(payload) {
  const data = unwrapData(payload);
  return Boolean(
    data &&
      typeof data === 'object' &&
      (
        data.version ||
        data.server_address ||
        data.serverAddress ||
        data.api_info ||
        data.apiInfo ||
        data.quota_per_unit ||
        data.quotaPerUnit ||
        data.system_name ||
        data.systemName ||
        Object.hasOwn(data, 'password_login_enabled')
      )
  );
}

function isModernSettingsPayload(payload) {
  const data = unwrapData(payload);
  return Boolean(
    data &&
      typeof data === 'object' &&
      (
        data.api_base_url ||
        data.apiBaseUrl ||
        data.custom_endpoints ||
        data.customEndpoints
      )
  );
}

async function syncByProviderType({ providerType, sync, apiKey, fetchImpl, timeoutMs }) {
  if (providerType === 'new-api') {
    return syncNewApi({ sync, apiKey, fetchImpl, timeoutMs });
  }
  return syncModernV1({ sync, apiKey, fetchImpl, timeoutMs });
}

async function syncNewApi({ sync, apiKey = '', fetchImpl, timeoutMs }) {
  const { origin, token, headers } = await loginNewApi({
    sync,
    fetchImpl,
    timeoutMs
  });
  const [profile, tokensPayload, groupsPayload, statusPayload] = await Promise.all([
    requestOptionalJson(fetchImpl, `${origin}/api/user/self`, { headers, signal: timeoutSignal(timeoutMs) }),
    requestOptionalJson(fetchImpl, `${origin}/api/token/?p=1&size=10`, { headers, signal: timeoutSignal(timeoutMs) }),
    requestOptionalJson(fetchImpl, `${origin}/api/user/self/groups`, { headers, signal: timeoutSignal(timeoutMs) }),
    requestOptionalJson(fetchImpl, `${origin}/api/status`, { headers, signal: timeoutSignal(timeoutMs) })
  ]);

  const tokenRow = selectRemoteKeyForConfiguredApiKey(tokensPayload, apiKey);
  const keyGroup = pickFirstGroupName(tokenRow?.group, tokenRow?.group_name, tokenRow?.groupName);
  const group = keyGroup ? findGroup(groupsPayload, keyGroup) : null;
  const groupName = tokenRow ? pickFirstGroupName(group, keyGroup) : '';
  const keyId = pickRemoteKeyId(tokenRow);
  const groupId = pickFirstString(keyGroup, tokenRow?.group_id, tokenRow?.groupId, group?.id, group?.key, group?.value);
  const groups = buildRemoteGroups({
    groupsPayload,
    selectedGroupName: groupName,
    selectedGroupKey: keyGroup
  });
  const multiplier = tokenRow
    ? pickMultiplier(
        tokenRow?.multiplier,
        tokenRow?.rate_multiplier,
        tokenRow?.rateMultiplier,
        tokenRow?.rate,
        tokenRow?.ratio,
        group?.multiplier,
        group?.rate_multiplier,
        group?.rateMultiplier,
        group?.rate,
        group?.ratio,
        parseMultiplierFromText(groupName)
      )
    : null;

  return {
    remote: {
      providerType: 'new-api',
      authType: token ? 'Bearer token (/api)' : 'Cookie session + New-Api-User (/api)',
      accountName: getAccountName(profile, sync.username),
      balance: getBalanceText(profile, statusPayload),
      apiEndpoint: getNewApiEndpoint(statusPayload),
      keyName: pickFirstString(tokenRow?.name, tokenRow?.key_name, tokenRow?.label),
      remoteKeyId: keyId,
      keyGroup: groupName,
      groupId,
      groupMultiplier: multiplier,
      groups
    }
  };
}

async function switchModernV1Group({ sync, originalSync, apiKey = '', group, fetchImpl, timeoutMs }) {
  const { apiBaseUrl, headers } = await loginModernV1({
    sync,
    fetchImpl,
    timeoutMs
  });
  const keysPayload = await requestOptionalJson(fetchImpl, joinApiPath(apiBaseUrl, '/keys?page=1&page_size=20'), {
    headers,
    signal: timeoutSignal(timeoutMs)
  });
  const matchedKey = selectRemoteKeyForConfiguredApiKey(keysPayload, apiKey);
  const remoteKeyId = pickFirstString(pickRemoteKeyId(matchedKey), originalSync?.remote?.remoteKeyId);
  if (!remoteKeyId) {
    throw new Error('Remote key id is missing; sync this site before switching groups');
  }
  const groupId = pickFirstString(group.id);
  if (!groupId) {
    throw new Error('Remote group id is missing; refresh this site before switching groups');
  }

  await requestJson(fetchImpl, joinApiPath(apiBaseUrl, `/keys/${encodeURIComponent(remoteKeyId)}`), {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      group_id: coerceNumericString(groupId)
    }),
    signal: timeoutSignal(timeoutMs)
  });

  const result = await syncModernV1({ sync, apiKey, fetchImpl, timeoutMs });
  return {
    remote: markSelectedRemoteGroup(result.remote, group)
  };
}

async function switchNewApiGroup({ sync, originalSync, apiKey = '', group, fetchImpl, timeoutMs }) {
  const { origin, headers } = await loginNewApi({
    sync,
    fetchImpl,
    timeoutMs
  });
  const tokensPayload = await requestOptionalJson(fetchImpl, `${origin}/api/token/?p=1&size=10`, {
    headers,
    signal: timeoutSignal(timeoutMs)
  });
  const matchedToken = selectRemoteKeyForConfiguredApiKey(tokensPayload, apiKey);
  const remoteKeyId = pickFirstString(pickRemoteKeyId(matchedToken), originalSync?.remote?.remoteKeyId);
  if (!remoteKeyId) {
    throw new Error('Remote key id is missing; sync this site before switching groups');
  }
  const groupId = pickFirstString(group.id, group.name, originalSync?.remote?.groupId);
  if (!groupId) {
    throw new Error('Remote group id is missing; refresh this site before switching groups');
  }

  const tokenPayload = await requestJson(fetchImpl, `${origin}/api/token/${encodeURIComponent(remoteKeyId)}`, {
    headers,
    signal: timeoutSignal(timeoutMs)
  });
  const tokenRow = unwrapData(tokenPayload);
  if (!tokenRow || typeof tokenRow !== 'object') {
    throw new Error('Remote token details are unavailable');
  }

  await requestJson(fetchImpl, `${origin}/api/token/`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(buildNewApiTokenUpdatePayload(tokenRow, remoteKeyId, groupId)),
    signal: timeoutSignal(timeoutMs)
  });

  const result = await syncNewApi({ sync, apiKey, fetchImpl, timeoutMs });
  return {
    remote: markSelectedRemoteGroup(result.remote, group)
  };
}

async function loginModernV1({ sync, fetchImpl, timeoutMs }) {
  const { apiBaseUrl, settingsPayload } = await resolveModernApiContext({
    dashboardUrl: sync.dashboardUrl,
    fetchImpl,
    timeoutMs
  });
  const login = await requestJson(fetchImpl, joinApiPath(apiBaseUrl, '/auth/login'), {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      email: sync.username,
      password: sync.password
    }),
    signal: timeoutSignal(timeoutMs)
  });
  assertSuccessfulLoginPayload(login);
  const token = pickFirstString(
    login?.data?.auth_token,
    login?.data?.access_token,
    login?.data?.accessToken,
    login?.data?.token,
    login?.auth_token,
    login?.access_token,
    login?.accessToken,
    login?.token
  );
  if (!token) {
    throw new Error('Remote login did not return an auth token');
  }

  return {
    apiBaseUrl,
    settingsPayload,
    token,
    headers: authHeaders(token)
  };
}

async function loginNewApi({ sync, fetchImpl, timeoutMs }) {
  const origin = getOrigin(sync.dashboardUrl);
  const cookieJar = createCookieJar();
  const login = await requestJson(fetchImpl, `${origin}/api/user/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      username: sync.username,
      password: sync.password
    }),
    signal: timeoutSignal(timeoutMs),
    cookieJar
  });
  const token = getNewApiLoginToken(login);
  const newApiUserId = getNewApiUserId(login);
  if (!token && (cookieJar.isEmpty() || !newApiUserId)) {
    throw new Error('Remote login did not return a token or user session id');
  }

  return {
    origin,
    token,
    newApiUserId,
    headers: token ? authHeaders(token, newApiUserId) : cookieAuthHeaders(cookieJar, newApiUserId)
  };
}

function getNewApiLoginToken(payload) {
  assertSuccessfulLoginPayload(payload);
  return pickFirstString(
    payload?.data?.token,
    payload?.data?.access_token,
    payload?.data?.accessToken,
    payload?.data?.auth_token,
    payload?.data?.authToken,
    payload?.data?.user?.token,
    payload?.data?.user?.access_token,
    payload?.data?.user?.accessToken,
    payload?.data?.user?.auth_token,
    payload?.data?.user?.authToken,
    payload?.user?.token,
    payload?.user?.access_token,
    payload?.user?.accessToken,
    payload?.user?.auth_token,
    payload?.user?.authToken,
    payload?.token,
    payload?.access_token,
    payload?.accessToken,
    payload?.auth_token,
    payload?.authToken,
    findTokenByKey(payload, new Set([
      'token',
      'access_token',
      'accessToken',
      'auth_token',
      'authToken'
    ]))
  );
}

function getNewApiUserId(payload) {
  const value = pickFirstValue(
    payload?.data?.id,
    payload?.data?.user_id,
    payload?.data?.userId,
    payload?.data?.user?.id,
    payload?.data?.user?.user_id,
    payload?.data?.user?.userId,
    payload?.user?.id,
    payload?.user?.user_id,
    payload?.user?.userId,
    payload?.id,
    payload?.user_id,
    payload?.userId
  );
  if (value === null || value === undefined || value === '') {
    return '';
  }
  return String(value).trim();
}

function assertSuccessfulLoginPayload(payload) {
  if (payload?.success === false) {
    throw new Error(`Remote login failed: ${pickFirstString(payload.message, payload.error, 'unknown error')}`);
  }

  const data = unwrapData(payload);
  if (data?.require_2fa || data?.require2FA || data?.requireTwoFactor) {
    throw new Error('Remote login requires two-factor authentication');
  }
}

function findTokenByKey(value, tokenKeys, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return '';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findTokenByKey(item, tokenKeys, seen);
      if (token) {
        return token;
      }
    }
    return '';
  }

  for (const [key, entry] of Object.entries(value)) {
    if (tokenKeys.has(key) && typeof entry === 'string' && entry.trim()) {
      return entry.trim();
    }
  }

  for (const entry of Object.values(value)) {
    const token = findTokenByKey(entry, tokenKeys, seen);
    if (token) {
      return token;
    }
  }
  return '';
}

function normalizeSyncInput(sync = {}) {
  const dashboardUrl = stringValue(sync.dashboardUrl).trim();
  const username = stringValue(sync.username).trim();
  const password = stringValue(sync.password).trim();

  if (!dashboardUrl) {
    throw new Error('Remote dashboard URL is required');
  }
  if (!username || !password) {
    throw new Error('Remote username and password are required');
  }
  getOrigin(dashboardUrl);

  return {
    dashboardUrl,
    username,
    password,
    providerType: sync.providerType === 'modern-v1' || sync.providerType === 'new-api'
      ? sync.providerType
      : 'auto'
  };
}

async function requestOptionalJson(fetchImpl, url, options) {
  try {
    return await requestJson(fetchImpl, url, options);
  } catch {
    return null;
  }
}

async function requestOptionalText(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, options);
    const text = await response.text();
    return response.ok ? text : '';
  } catch {
    return '';
  }
}

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  options.cookieJar?.storeFromResponse(response);
  const text = await response.text();
  const payload = text ? parseJson(text, url) : null;
  if (!response.ok) {
    throw new Error(`Remote request failed HTTP ${response.status}: ${truncate(text, 300)}`);
  }
  return payload;
}

async function resolveModernApiContext({ dashboardUrl, fetchImpl, timeoutMs }) {
  const origin = getOrigin(dashboardUrl);
  const defaultApiBaseUrl = `${origin}/api/v1`;
  const defaultSettingsPayload = await requestOptionalJson(
    fetchImpl,
    joinApiPath(defaultApiBaseUrl, '/settings/public'),
    { signal: timeoutSignal(timeoutMs) }
  );
  if (defaultSettingsPayload) {
    return {
      apiBaseUrl: defaultApiBaseUrl,
      settingsPayload: defaultSettingsPayload
    };
  }

  const discoveredApiBaseUrl = await discoverModernApiBaseUrl({
    dashboardUrl,
    fetchImpl,
    timeoutMs
  });
  if (!discoveredApiBaseUrl) {
    return {
      apiBaseUrl: defaultApiBaseUrl,
      settingsPayload: null
    };
  }

  return {
    apiBaseUrl: discoveredApiBaseUrl,
    settingsPayload: await requestOptionalJson(
      fetchImpl,
      joinApiPath(discoveredApiBaseUrl, '/settings/public'),
      { signal: timeoutSignal(timeoutMs) }
    )
  };
}

async function discoverModernApiBaseUrl({ dashboardUrl, fetchImpl, timeoutMs }) {
  const html = await requestOptionalText(fetchImpl, dashboardUrl, {
    signal: timeoutSignal(timeoutMs)
  });
  if (!html) {
    return '';
  }

  const scriptUrls = extractScriptUrls(html, dashboardUrl).slice(0, 8);
  for (const scriptUrl of scriptUrls) {
    const script = await requestOptionalText(fetchImpl, scriptUrl, {
      signal: timeoutSignal(timeoutMs)
    });
    const apiBaseUrl = extractAbsoluteModernApiBaseUrl(script);
    if (apiBaseUrl) {
      return apiBaseUrl;
    }
  }
  return '';
}

function extractScriptUrls(html, baseUrl) {
  const urls = [];
  const pattern = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match = pattern.exec(html);
  while (match) {
    try {
      urls.push(new URL(match[1], baseUrl).href);
    } catch {
      // Ignore malformed script URLs from remote pages.
    }
    match = pattern.exec(html);
  }
  return [...new Set(urls)];
}

function extractAbsoluteModernApiBaseUrl(script) {
  const match = stringValue(script).match(/https?:\/\/[^"'`\s)]+\/api\/v1\b/);
  return match ? stripTrailingSlash(match[0]) : '';
}

function parseJson(text, url) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Remote response is not JSON: ${url}`);
  }
}

function firstItem(payload) {
  const data = unwrapData(payload);
  if (Array.isArray(data)) {
    return data[0] ?? null;
  }
  if (Array.isArray(data?.items)) {
    return data.items[0] ?? null;
  }
  if (Array.isArray(data?.list)) {
    return data.list[0] ?? null;
  }
  if (Array.isArray(data?.records)) {
    return data.records[0] ?? null;
  }
  if (Array.isArray(data?.tokens)) {
    return data.tokens[0] ?? null;
  }
  return null;
}

function selectRemoteKeyForConfiguredApiKey(payload, apiKey) {
  const configuredApiKey = stringValue(apiKey).trim();
  if (!configuredApiKey) {
    return firstItem(payload);
  }

  const rows = toArray(unwrapData(payload));
  if (rows.length === 0) {
    throw new Error('Configured API key was not found in the remote account');
  }

  const matched = rows.find((row) => remoteKeyMatchesConfiguredApiKey(row, configuredApiKey));
  if (!matched) {
    throw new Error('Configured API key was not found in the remote account');
  }
  return matched;
}

function remoteKeyMatchesConfiguredApiKey(row, configuredApiKey) {
  return getRemoteKeyCandidateValues(row)
    .some((candidate) => apiKeyMatchesCandidate(configuredApiKey, candidate));
}

function getRemoteKeyCandidateValues(row = {}) {
  if (!row || typeof row !== 'object') {
    return [];
  }

  return [
    row.key,
    row.apiKey,
    row.api_key,
    row.token,
    row.tokenKey,
    row.token_key,
    row.keyValue,
    row.key_value,
    row.maskedKey,
    row.masked_key,
    row.keyPreview,
    row.key_preview,
    row.tokenPreview,
    row.token_preview
  ].map(stringValue).map((value) => value.trim()).filter(Boolean);
}

function apiKeyMatchesCandidate(configuredApiKey, candidate) {
  const expected = stringValue(configuredApiKey).trim();
  const remote = stringValue(candidate).trim();
  if (!expected || !remote) {
    return false;
  }
  if (remote === expected) {
    return true;
  }

  const normalizedMask = remote.replace(/\u2026/g, '...');
  if (!normalizedMask.includes('...') && !normalizedMask.includes('*')) {
    return false;
  }

  const [prefix, suffix] = normalizedMask
    .split(/(?:\.\.\.|[*]+)/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (maskedKeyMatches(expected, prefix, suffix)) {
    return true;
  }

  return maskedKeyMatches(stripApiKeySchemePrefix(expected), prefix, suffix);
}

function maskedKeyMatches(expected, prefix, suffix) {
  return Boolean(
    expected &&
    prefix &&
    suffix &&
    expected.startsWith(prefix) &&
    expected.endsWith(suffix)
  );
}

function stripApiKeySchemePrefix(value) {
  return stringValue(value).replace(/^sk[-_]/i, '');
}

function findGroup(payload, name) {
  const groups = toArray(unwrapData(payload));
  if (groups.length === 0) {
    return null;
  }
  const expected = stringValue(name);
  if (!expected) {
    return null;
  }
  return groups.find((group) => {
    const names = [
      group?.key,
      group?.id,
      group?.value,
      group?.name,
      group?.group_name,
      group?.groupName,
      group?.group,
      group?.desc,
      group?.label,
      group?.title,
      pickFirstGroupName(group)
    ].map(stringValue).map((value) => value.trim()).filter(Boolean);
    return names.includes(expected);
  }) ?? null;
}

function getRateMultiplier(payload, groupName) {
  const data = unwrapData(payload);
  if (!data || !groupName) {
    return null;
  }
  if (!Array.isArray(data) && typeof data === 'object' && Object.hasOwn(data, groupName)) {
    return data[groupName];
  }
  const group = findGroup(payload, groupName);
  return pickFirstValue(group?.multiplier, group?.rate_multiplier, group?.rateMultiplier, group?.rate, group?.ratio);
}

function buildModernRemoteGroups({ groupsPayload, ratesPayload, selectedGroupName }) {
  return buildRemoteGroups({
    groupsPayload,
    selectedGroupName,
    getMultiplier: (group, name) => pickMultiplier(
      getRateMultiplier(ratesPayload, name),
      group?.multiplier,
      group?.rate_multiplier,
      group?.rateMultiplier,
      group?.rate,
      group?.ratio,
      parseMultiplierFromText(name)
    )
  });
}

function normalizeSwitchGroup(group = {}) {
  if (!group || typeof group !== 'object') {
    throw new Error('group is required');
  }
  const name = pickFirstString(group.name);
  if (!name) {
    throw new Error('group name is required');
  }
  return {
    id: pickFirstString(group.id),
    name,
    multiplier: pickMultiplier(group.multiplier),
    selected: true
  };
}

function markSelectedRemoteGroup(remote, selectedGroup) {
  const selectedId = pickFirstString(selectedGroup.id);
  const selectedName = pickFirstString(selectedGroup.name);
  const groups = Array.isArray(remote?.groups) ? remote.groups : [];
  const nextGroups = groups.map((group) => ({
    ...group,
    selected: Boolean(
      (selectedId && group.id === selectedId) ||
        group.name === selectedName
    )
  }));
  const selected = nextGroups.find((group) => group.selected);
  return {
    ...remote,
    keyGroup: pickFirstString(selected?.name, selectedGroup.name, remote?.keyGroup),
    groupId: pickFirstString(selected?.id, selectedGroup.id, remote?.groupId),
    groupMultiplier: pickMultiplier(selected?.multiplier, selectedGroup.multiplier, remote?.groupMultiplier),
    groups: nextGroups
  };
}

function buildNewApiTokenUpdatePayload(tokenRow, remoteKeyId, groupId) {
  return {
    id: Number.isFinite(Number(tokenRow.id)) ? Number(tokenRow.id) : Number(remoteKeyId),
    name: pickFirstString(tokenRow.name, tokenRow.key_name, tokenRow.label),
    status: normalizeNewApiTokenStatus(tokenRow.status),
    expired_time: normalizeNewApiTokenExpiredTime(tokenRow.expired_time, tokenRow.expiredTime),
    remain_quota: normalizeInteger(tokenRow.remain_quota, tokenRow.remainQuota, tokenRow.quota),
    unlimited_quota: Boolean(tokenRow.unlimited_quota ?? tokenRow.unlimitedQuota),
    model_limits_enabled: Boolean(tokenRow.model_limits_enabled ?? tokenRow.modelLimitsEnabled),
    model_limits: pickFirstString(tokenRow.model_limits, tokenRow.modelLimits),
    allow_ips: normalizeAllowIps(tokenRow.allow_ips, tokenRow.allowIps),
    group: groupId,
    cross_group_retry: Boolean(tokenRow.cross_group_retry ?? tokenRow.crossGroupRetry)
  };
}

function normalizeNewApiTokenStatus(...values) {
  const number = normalizeInteger(...values);
  return number > 0 ? number : 1;
}

function normalizeNewApiTokenExpiredTime(...values) {
  const value = pickFirstValue(...values);
  if (value === null || value === undefined || value === '') {
    return -1;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}

function normalizeInteger(...values) {
  const value = pickFirstValue(...values);
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function normalizeAllowIps(...values) {
  const value = pickFirstValue(...values);
  return Array.isArray(value) ? value.join('\n') : pickFirstString(value);
}

function coerceNumericString(value) {
  const text = pickFirstString(value);
  if (!/^\d+$/.test(text)) {
    return text;
  }
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : text;
}

function pickRemoteKeyId(key) {
  return pickFirstString(key?.id, key?.key_id, key?.keyId, key?.token_id, key?.tokenId);
}

function buildRemoteGroups({
  groupsPayload,
  selectedGroupName,
  selectedGroupKey,
  getMultiplier = (group, name) => pickMultiplier(
    group?.multiplier,
    group?.rate_multiplier,
    group?.rateMultiplier,
    group?.rate,
    group?.ratio,
    parseMultiplierFromText(name)
  )
}) {
  const selectedName = stringValue(selectedGroupName).trim();
  const selectedKey = stringValue(selectedGroupKey).trim();
  const seen = new Set();
  const groups = [];

  for (const group of toArray(unwrapData(groupsPayload))) {
    const name = pickFirstGroupName(group);
    if (!name) {
      continue;
    }
    const multiplier = getMultiplier(group, name);
    const dedupeKey = `${name}\n${multiplier ?? ''}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    groups.push({
      id: pickFirstString(group?.id, group?.key, group?.value),
      name,
      multiplier,
      selected: isSelectedRemoteGroup(group, name, selectedName, selectedKey)
    });
  }

  return groups;
}

function isSelectedRemoteGroup(group, name, selectedName, selectedKey) {
  if (selectedName && name === selectedName) {
    return true;
  }
  if (!selectedKey) {
    return false;
  }
  return [
    group?.id,
    group?.key,
    group?.value,
    group?.name,
    group?.group_name,
    group?.groupName,
    group?.group
  ].map(stringValue).map((value) => value.trim()).includes(selectedKey);
}

function getAccountName(profile, fallback) {
  const data = unwrapData(profile);
  return pickFirstString(
    data?.email,
    data?.username,
    data?.display_name,
    data?.name,
    fallback
  );
}

function getBalanceText(profile, statusPayload = null) {
  const data = unwrapData(profile);
  const direct = pickFirstValue(data?.balance, data?.amount, data?.money);
  if (direct !== null && direct !== undefined && direct !== '') {
    return typeof direct === 'number' ? `$${direct.toFixed(2)}` : String(direct);
  }

  const raw = pickFirstValue(data?.quota, data?.remaining_quota, data?.remain_quota);
  if (raw === null || raw === undefined || raw === '') {
    return '';
  }
  if (typeof raw !== 'number') {
    return String(raw);
  }

  const status = unwrapData(statusPayload);
  const quotaPerUnit = Number(status?.quota_per_unit);
  const balance = Number.isFinite(quotaPerUnit) && quotaPerUnit > 0
    ? raw / quotaPerUnit
    : raw;
  return `${getBalanceSymbol(status)}${balance.toFixed(2)}`;
}

function getBalanceSymbol(status) {
  if (status?.quota_display_type === 'CNY') {
    return '\u00a5';
  }
  if (status?.quota_display_type === 'CUSTOM') {
    return status?.custom_currency_symbol || '\u00a4';
  }
  return '$';
}

function getModernSettingsEndpoint(settingsPayload) {
  const data = unwrapData(settingsPayload);
  return pickFirstString(
    data?.api_base_url,
    data?.apiBaseUrl,
    firstEndpoint(data?.custom_endpoints),
    firstEndpoint(data?.customEndpoints)
  );
}

function getNewApiEndpoint(statusPayload) {
  const data = unwrapData(statusPayload);
  return pickFirstString(
    firstEndpoint(data?.api_info),
    firstEndpoint(data?.apiInfo),
    data?.server_address,
    data?.serverAddress
  );
}

function firstEndpoint(value) {
  const endpoints = toArray(value);
  for (const endpoint of endpoints) {
    const url = pickFirstString(endpoint?.endpoint, endpoint?.url, endpoint?.baseUrl, endpoint?.base_url);
    if (url) {
      return url;
    }
  }
  return '';
}

function pickMultiplier(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    const multiplier = typeof value === 'string' && /x/i.test(value)
      ? parseMultiplierFromText(value)
      : Number(value);
    if (Number.isFinite(multiplier) && multiplier >= 0) {
      return multiplier;
    }
  }
  return null;
}

function pickFirstGroupName(...values) {
  for (const value of values) {
    const name = groupNameFromValue(value);
    if (name) {
      return name;
    }
  }
  return '';
}

function groupNameFromValue(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  if (typeof value !== 'object') {
    return String(value).trim();
  }
  return pickFirstGroupName(
    value.name,
    value.group_name,
    value.groupName,
    value.group,
    value.desc,
    value.label,
    value.title
  );
}

function unwrapData(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  return payload.data ?? payload.result ?? payload;
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.items)) {
    return value.items;
  }
  if (Array.isArray(value?.list)) {
    return value.list;
  }
  if (Array.isArray(value?.records)) {
    return value.records;
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, entry]) => {
      if (entry && typeof entry === 'object') {
        const name = pickFirstString(
          entry.name,
          entry.group_name,
          entry.groupName,
          entry.desc,
          entry.label,
          entry.title,
          key
        );
        return {
          key,
          ...entry,
          name
        };
      }
      return {
        key,
        name: key,
        value: entry
      };
    });
  }
  return [];
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json'
  };
}

function authHeaders(token, newApiUserId = '') {
  return {
    ...jsonHeaders(),
    Authorization: `Bearer ${token}`,
    ...(newApiUserId ? { 'New-Api-User': newApiUserId } : {})
  };
}

function cookieAuthHeaders(cookieJar, newApiUserId = '') {
  const cookie = cookieJar.getCookieHeader();
  return {
    ...jsonHeaders(),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(newApiUserId ? { 'New-Api-User': newApiUserId } : {})
  };
}

function createCookieJar() {
  const cookies = new Map();
  return {
    storeFromResponse(response) {
      for (const entry of getSetCookieHeaders(response)) {
        const cookie = parseSetCookie(entry);
        if (cookie) {
          cookies.set(cookie.name, cookie.value);
        }
      }
    },
    getCookieHeader() {
      return [...cookies.entries()]
        .filter(([, value]) => value)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    },
    isEmpty() {
      return cookies.size === 0;
    }
  };
}

function getSetCookieHeaders(response) {
  if (!response?.headers) {
    return [];
  }
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const value = typeof response.headers.get === 'function'
    ? response.headers.get('set-cookie')
    : null;
  return value ? splitSetCookieHeader(value) : [];
}

function splitSetCookieHeader(value) {
  return stringValue(value).split(/,(?=\s*[^;,=\s]+=[^;,]+)/).map((entry) => entry.trim()).filter(Boolean);
}

function parseSetCookie(value) {
  const [pair] = stringValue(value).split(';');
  const separator = pair.indexOf('=');
  if (separator <= 0) {
    return null;
  }
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim()
  };
}

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && Number.isFinite(timeoutMs)
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function getOrigin(url) {
  const parsed = parseUrl(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Remote dashboard URL must be a valid HTTP(S) URL');
  }
  return parsed.origin;
}

function joinApiPath(apiBaseUrl, path) {
  const base = stripTrailingSlash(apiBaseUrl);
  const suffix = stringValue(path).startsWith('/') ? stringValue(path) : `/${path}`;
  return `${base}${suffix}`;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function pickFirstString(...values) {
  const value = pickFirstValue(...values);
  return value === null || value === undefined ? '' : String(value).trim();
}

function pickFirstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function truncate(value, maxLength) {
  const text = stringValue(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function stripTrailingSlash(value) {
  return stringValue(value).replace(/\/+$/, '');
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}
