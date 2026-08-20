import { randomUUID } from 'node:crypto';

const MAX_SESSION_VALUE_LENGTH = 16 * 1024;

export function getRemoteAccountIdentity(input = {}) {
  const dashboardUrl = normalizeText(input.dashboardUrl);
  const username = normalizeText(input.username).toLocaleLowerCase();
  if (!dashboardUrl || !username) {
    return '';
  }

  let website = dashboardUrl.toLocaleLowerCase();
  try {
    const parsed = new URL(dashboardUrl);
    website = `${parsed.protocol}//${parsed.host}`.toLocaleLowerCase();
  } catch {
    // Validation remains owned by the site sync service.
  }
  return `${website}\n${username}`;
}

export function normalizeRemoteAccount(account = {}, now = new Date()) {
  const source = account && typeof account === 'object' ? account : {};
  const createdAt = normalizeIso(source.createdAt) ?? nowIso(now);
  return {
    id: normalizeText(source.id) || randomUUID(),
    dashboardUrl: normalizeText(source.dashboardUrl),
    username: normalizeText(source.username),
    password: normalizeText(source.password),
    providerType: normalizeProviderType(source.providerType),
    session: normalizeRemoteAccountSession(source.session),
    lastLoginAt: normalizeIso(source.lastLoginAt),
    lastLogoutAt: normalizeIso(source.lastLogoutAt),
    createdAt,
    updatedAt: normalizeIso(source.updatedAt) ?? createdAt
  };
}

export function normalizeRemoteAccountSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return null;
  }
  const providerType = normalizeProviderType(session.providerType);
  if (providerType === 'auto') {
    return null;
  }
  const token = normalizeSessionValue(session.token);
  const cookie = normalizeSessionValue(session.cookie);
  if (!token && !cookie) {
    return null;
  }
  return {
    providerType,
    origin: normalizeSessionValue(session.origin),
    apiBaseUrl: normalizeSessionValue(session.apiBaseUrl),
    token,
    cookie,
    userId: normalizeSessionValue(session.userId),
    createdAt: normalizeIso(session.createdAt) ?? nowIso()
  };
}

export function reconcileRemoteAccounts({ accounts = [], sites = [], now = new Date() } = {}) {
  const normalizedAccounts = [];
  const accountById = new Map();
  const accountByIdentity = new Map();

  for (const rawAccount of Array.isArray(accounts) ? accounts : []) {
    const account = normalizeRemoteAccount(rawAccount, now);
    const identity = getRemoteAccountIdentity(account);
    const existing = identity ? accountByIdentity.get(identity) : null;
    if (existing) {
      mergeMissingAccountFields(existing, account);
      accountById.set(account.id, existing);
      continue;
    }
    if (accountById.has(account.id)) {
      account.id = randomUUID();
    }
    normalizedAccounts.push(account);
    accountById.set(account.id, account);
    if (identity) {
      accountByIdentity.set(identity, account);
    }
  }

  const normalizedSites = sites.map((site) => {
    const sync = site?.sync && typeof site.sync === 'object' ? site.sync : {};
    let account = accountById.get(normalizeText(sync.accountId));
    const identity = getRemoteAccountIdentity(sync);
    if (!account && identity) {
      account = accountByIdentity.get(identity);
    }
    if (!account && identity) {
      account = normalizeRemoteAccount({
        dashboardUrl: sync.dashboardUrl,
        username: sync.username,
        password: sync.password,
        providerType: sync.providerType
      }, now);
      normalizedAccounts.push(account);
      accountById.set(account.id, account);
      accountByIdentity.set(identity, account);
    }
    if (!account) {
      return site;
    }
    mergeMissingAccountFields(account, sync);
    return hydrateSiteWithRemoteAccount(site, account);
  });

  return {
    accounts: normalizedAccounts,
    sites: normalizedSites
  };
}

export function hydrateSiteWithRemoteAccount(site, account) {
  if (!account) {
    return site;
  }
  return {
    ...site,
    sync: {
      ...(site?.sync ?? {}),
      accountId: account.id,
      dashboardUrl: account.dashboardUrl,
      username: account.username,
      password: account.password,
      providerType: account.providerType
    }
  };
}

export function remoteAccountPublicView(account, linkedSiteCount = 0) {
  const normalized = normalizeRemoteAccount(account);
  return {
    id: normalized.id,
    dashboardUrl: normalized.dashboardUrl,
    username: normalized.username,
    providerType: normalized.providerType,
    hasSession: Boolean(normalized.session),
    lastLoginAt: normalized.lastLoginAt,
    lastLogoutAt: normalized.lastLogoutAt,
    linkedSiteCount: Math.max(0, Number(linkedSiteCount) || 0),
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt
  };
}

function mergeMissingAccountFields(target, source = {}) {
  for (const field of ['dashboardUrl', 'username', 'password']) {
    if (!target[field] && normalizeText(source[field])) {
      target[field] = normalizeText(source[field]);
    }
  }
  if (target.providerType === 'auto' && normalizeProviderType(source.providerType) !== 'auto') {
    target.providerType = normalizeProviderType(source.providerType);
  }
  if (!target.session && source.session) {
    target.session = normalizeRemoteAccountSession(source.session);
  }
}

function normalizeProviderType(value) {
  return value === 'modern-v1' || value === 'new-api' ? value : 'auto';
}

function normalizeSessionValue(value) {
  return normalizeText(value).slice(0, MAX_SESSION_VALUE_LENGTH);
}

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeIso(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nowIso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}
