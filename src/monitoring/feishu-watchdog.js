import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { readCodexThreadNames } from '../codex/codex-app-server-client.js';
import { findRecentCodexEvents } from '../codex/codex-session-failure-detector.js';
import {
  readRemoteCodexEvents,
  removeRemoteCodexEventFiles
} from './remote-codex-event-inbox.js';

import {
  calculateEffectiveMultiplier,
  chooseBestSite,
  isRateLimitPaused,
  isUsableSite
} from '../proxy/switching-policy.js';

export async function runWatchdogCheck({
  configPath,
  statePath,
  fetchImpl = fetch,
  now = new Date(),
  logger = console,
  sessionsDir = null,
  remoteEventsDir = null,
  findCodexEvents = findRecentCodexEvents,
  findCodexCompletions = null,
  resolveCodexThreadNames = readCodexThreadNames
} = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  remoteEventsDir ??= join(dirname(configPath), 'remote-codex-events');
  let state = await readWatchdogState(statePath);
  const monitoring = config.monitoring ?? {};
  if (!monitoring.enabled) {
    await clearRemoteEventInbox(remoteEventsDir, logger);
    if (
      state.healthFailureCount ||
      state.activeMultiplier ||
      Object.keys(state.alerts).length ||
      hasCodexCompletionState(state.codexCompletions)
    ) {
      state = normalizeWatchdogState();
      await writeJsonAtomically(statePath, state);
    }
    return {
      healthOk: null,
      events: [],
      delivered: 0,
      intervalMs: monitoringIntervalMs(monitoring),
      state
    };
  }

  state = clearDisabledNotificationState(state, monitoring);
  if (!notificationSettings(monitoring).remoteCompletion) {
    await clearRemoteEventInbox(remoteEventsDir, logger);
  }
  const healthOk = await checkProxyHealth(config.proxy?.port, fetchImpl);
  state.healthFailureCount = notificationSettings(monitoring).programIssues
    ? healthOk ? 0 : state.healthFailureCount + 1
    : 0;
  const conditions = collectAlertConditions({
    config,
    healthOk,
    healthFailureCount: state.healthFailureCount,
    now
  });
  const alertResult = reconcileAlerts({
    conditions,
    state,
    now,
    repeatIntervalMinutes: monitoring.repeatIntervalMinutes
  });
  state = alertResult.state;
  const multiplierResult = healthOk
    ? reconcileMultiplierChange({ config, state, now })
    : { events: [], state };
  state = multiplierResult.state;
  const completionResult = await reconcileCodexNotifications({
    monitoring,
    state,
    sessionsDir,
    findCodexEvents,
    findCodexCompletions,
    resolveCodexThreadNames,
    remoteEventsDir,
    now,
    logger
  });
  state = completionResult.state;
  const events = [
    ...alertResult.events,
    ...multiplierResult.events,
    ...completionResult.events
  ];
  let delivered = 0;
  for (const event of events) {
    try {
      await sendFeishuWebhook({
        webhook: monitoring.feishuWebhook,
        event,
        fetchImpl
      });
      state = recordAlertDelivery(state, event, now);
      if (event.remoteInboxPath) {
        await removeRemoteCodexEventFiles([event.remoteInboxPath]);
      }
      delivered += 1;
    } catch (error) {
      logger?.error?.(`[feishu-watchdog] ${error?.message ?? error}`);
    }
  }
  await writeJsonAtomically(statePath, state);
  return {
    healthOk,
    events,
    delivered,
    intervalMs: monitoringIntervalMs(monitoring),
    state
  };
}

export function collectAlertConditions({
  config = {},
  healthOk,
  healthFailureCount = 0,
  now = new Date()
} = {}) {
  const conditions = new Map();
  const monitoring = config.monitoring ?? {};
  if (!monitoring.enabled) {
    return conditions;
  }
  const notifications = notificationSettings(monitoring);

  if (!healthOk) {
    if (
      notifications.programIssues &&
      healthFailureCount >= (Number(monitoring.failureThreshold) || 3)
    ) {
      addCondition(conditions, {
        key: 'proxy-unreachable',
        kind: 'proxy-unreachable',
        title: '程序异常：本地代理未响应',
        message: `连续 ${healthFailureCount} 次健康检查失败`
      });
    }
    return conditions;
  }

  const sites = Array.isArray(config.sites) ? config.sites : [];
  if (
    notifications.noUsableSite &&
    !hasSelectableSite(config, now)
  ) {
    addCondition(conditions, {
      key: 'no-usable-site',
      kind: 'no-usable-site',
      title: `无可用站点：已持续 ${Math.max(1, Number(monitoring.noUsableSiteDelayMinutes) || 5)} 分钟`,
      message: '当前不存在可转发请求的站点',
      notifyAfterMs: Math.max(1, Number(monitoring.noUsableSiteDelayMinutes) || 5) * 60 * 1000
    });
  }

  if (!notifications.lowBalance) {
    return conditions;
  }
  const rules = new Map((Array.isArray(monitoring.rules) ? monitoring.rules : []).map((rule) => [
    String(rule.accountId ?? ''),
    rule
  ]));
  const latestSitesByAccount = new Map();
  for (const site of sites) {
    const accountId = String(site.sync?.accountId ?? '');
    const previous = latestSitesByAccount.get(accountId);
    if (accountId && (!previous || dateMs(site.sync?.lastSyncAt) >= dateMs(previous.sync?.lastSyncAt))) {
      latestSitesByAccount.set(accountId, site);
    }
  }
  for (const [accountId, site] of latestSitesByAccount) {
    const rule = rules.get(accountId) ?? {
      accountId,
      enabled: true,
      balanceThreshold: null
    };
    if (!rule?.enabled) {
      continue;
    }
    const target = formatTarget(site);

    if (rule.balanceThreshold === null || rule.balanceThreshold === undefined || !rule.accountId) {
      continue;
    }
    const threshold = Number(rule.balanceThreshold);
    if (!Number.isFinite(threshold)) {
      continue;
    }
    const sync = site.sync ?? {};
    if (!sync.enabled) {
      continue;
    }
    const balance = parseBalanceAmount(sync.remote?.balance);
    if (sync.lastSyncStatus === 'success' && balance !== null && balance <= threshold) {
      addCondition(conditions, {
        key: `low-balance:${accountId}`,
        kind: 'low-balance',
        title: `余额不足：${site.name}`,
        message: `${target}：当前余额 ${balance.toFixed(2)}，阈值 ${threshold}`
      });
    }
  }

  return conditions;
}

function hasSelectableSite(config, now) {
  const sites = Array.isArray(config.sites) ? config.sites : [];
  if (!config.proxy?.smartSwitching) {
    const active = sites.find((site) => site.id === config.activeSiteId);
    return Boolean(active && isUsableSite(active) && !isRateLimitPaused(active, now));
  }
  return Boolean(chooseBestSite(sites, {
    samePriorityStrategy: config.proxy?.samePriorityStrategy,
    priorityMode: config.proxy?.priorityMode,
    lastSelectedSiteId: config.proxy?.lastSelectedSiteId,
    autoSwitchMultiplierLimit: config.proxy?.autoSwitchMultiplierLimit,
    now
  }));
}

export function reconcileAlerts({
  conditions = new Map(),
  state = {},
  now = new Date(),
  repeatIntervalMinutes = 30
} = {}) {
  const nowIso = new Date(now).toISOString();
  const repeatMs = Math.max(1, Number(repeatIntervalMinutes) || 30) * 60 * 1000;
  const next = normalizeWatchdogState(state);
  const events = [];

  for (const [key, condition] of conditions) {
    const previous = next.alerts[key];
    const entry = {
      condition: sanitizeCondition(condition),
      active: true,
      notifiedActive: previous?.active ? Boolean(previous.notifiedActive) : false,
      firstSeenAt: previous?.active ? previous.firstSeenAt : nowIso,
      lastSentAt: previous?.lastSentAt ?? null
    };
    next.alerts[key] = entry;
    const notifyAfterMs = Math.max(0, Number(entry.condition.notifyAfterMs) || 0);
    if (!entry.notifiedActive && dateMs(nowIso) - dateMs(entry.firstSeenAt) >= notifyAfterMs) {
      events.push(createEvent('alert', entry));
    } else if (
      entry.notifiedActive &&
      new Date(now).getTime() - dateMs(entry.lastSentAt) >= repeatMs
    ) {
      events.push(createEvent('reminder', entry));
    }
  }

  for (const [key, previous] of Object.entries(next.alerts)) {
    if (conditions.has(key)) {
      continue;
    }
    if (!previous.notifiedActive) {
      delete next.alerts[key];
      continue;
    }
    previous.active = false;
    events.push(createEvent('recovery', previous));
  }

  return { events, state: next };
}

export function recordAlertDelivery(state, event, now = new Date()) {
  const next = normalizeWatchdogState(state);
  if (event?.completionKey) {
    delete next.codexCompletions.pending[event.completionKey];
    next.codexCompletions.delivered = [
      ...next.codexCompletions.delivered.filter((key) => key !== event.completionKey),
      event.completionKey
    ].slice(-500);
    return next;
  }
  if (event?.condition?.kind === 'multiplier-changed' && event.multiplierSnapshot) {
    next.activeMultiplier = normalizeMultiplierSnapshot(event.multiplierSnapshot);
    return next;
  }
  const key = event?.condition?.key;
  const entry = next.alerts[key];
  if (!entry) {
    return next;
  }
  if (event.type === 'recovery') {
    delete next.alerts[key];
    return next;
  }
  entry.notifiedActive = true;
  entry.lastSentAt = new Date(now).toISOString();
  return next;
}

export async function sendFeishuWebhook({ webhook, event, fetchImpl = fetch } = {}) {
  const url = validateFeishuWebhook(webhook);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildFeishuCard(event)),
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const accepted = Number(payload?.code) === 0 || Number(payload?.StatusCode) === 0;
  if (!response.ok || !accepted) {
    throw new Error(
      payload?.msg || payload?.StatusMessage || `Feishu webhook returned HTTP ${response.status}`
    );
  }
  return payload;
}

export function buildFeishuCard(event = {}) {
  const condition = sanitizeCondition(event.condition);
  const template = event.type === 'recovery'
    ? 'green'
    : event.type === 'reminder'
      ? 'orange'
      : event.type === 'completion'
        ? 'blue'
        : 'red';
  const title = event.type === 'recovery'
    ? `${condition.title}（已恢复）`
    : event.type === 'reminder'
      ? `${condition.title}（持续）`
      : condition.title;
  return {
    msg_type: 'interactive',
    card: {
      header: {
        template,
        title: { tag: 'plain_text', content: title }
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: condition.message
          }
        },
        {
          tag: 'note',
          elements: [{
            tag: 'plain_text',
            content: `${event.type === 'completion' ? '完成时间' : '首次发现'}：${event.firstSeenAt ?? new Date().toISOString()}`
          }]
        }
      ]
    }
  };
}

export function parseBalanceAmount(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const match = String(value).replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

export function normalizeWatchdogState(state = {}) {
  return {
    version: 3,
    healthFailureCount: Math.max(0, Number(state.healthFailureCount) || 0),
    activeMultiplier: normalizeMultiplierSnapshot(state.activeMultiplier),
    alerts: normalizeAlertState(state.alerts),
    codexCompletions: normalizeCodexCompletionState(state.codexCompletions)
  };
}

async function reconcileCodexNotifications({
  monitoring,
  state,
  sessionsDir,
  findCodexEvents,
  findCodexCompletions,
  resolveCodexThreadNames,
  remoteEventsDir,
  now,
  logger
}) {
  const next = normalizeWatchdogState(state);
  const completionState = next.codexCompletions;
  const notifications = notificationSettings(monitoring);
  if (!notifications.answerCompleted && !notifications.goalStatusChanged && !notifications.remoteCompletion) {
    return { events: [], state: next };
  }

  const nowIso = new Date(now).toISOString();
  if (notifications.answerCompleted && !completionState.answerEnabledAt) {
    completionState.answerEnabledAt = nowIso;
  }
  if (notifications.goalStatusChanged && !completionState.goalEnabledAt) {
    completionState.goalEnabledAt = nowIso;
  }
  const known = new Set([
    ...completionState.delivered,
    ...Object.keys(completionState.pending)
  ]);
  const unseen = [];

  if (sessionsDir) {
    let found;
    try {
      const enabledAtMs = Math.min(...[
        completionState.answerEnabledAt,
        completionState.goalEnabledAt
      ].filter(Boolean).map(dateMs));
      found = typeof findCodexCompletions === 'function'
        ? (await findCodexCompletions({ sessionsDir, sinceMs: enabledAtMs }))
            .map((completion) => ({ type: 'completion', ...completion }))
        : await findCodexEvents({
            sessionsDir,
            eventSinceMs: enabledAtMs,
            modifiedSinceMs: Math.max(0, dateMs(completionState.scanAfter ?? nowIso) - 60_000),
            includeGoalContext: true
          });
      completionState.scanAfter = nowIso;
    } catch (error) {
      logger?.error?.(`[feishu-watchdog] ${error?.message ?? error}`);
      found = [];
    }

    for (const value of [...found].sort((left, right) =>
      codexNotificationTimeMs(left) - codexNotificationTimeMs(right)
    )) {
      const item = normalizeCodexNotification(value);
      if (!item) {
        continue;
      }
      if (item.type === 'goal') {
        completionState.goalStates[item.threadId] = {
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        };
        if (
          notifications.goalStatusChanged &&
          ['paused', 'complete'].includes(item.status) &&
          dateMs(item.updatedAt) >= dateMs(completionState.goalEnabledAt) &&
          !known.has(item.key)
        ) {
          unseen.push(item);
          known.add(item.key);
        }
        continue;
      }
      if (
        !notifications.answerCompleted ||
        dateMs(item.completedAt) < dateMs(completionState.answerEnabledAt) ||
        ['active', 'paused', 'blocked'].includes(
          completionState.goalStates[item.threadId]?.status
        ) ||
        known.has(item.key)
      ) {
        continue;
      }
      unseen.push(item);
      known.add(item.key);
    }

  }

  if (notifications.remoteCompletion && remoteEventsDir) {
    try {
      const stalePaths = [];
      for (const value of await readRemoteCodexEvents(remoteEventsDir)) {
        const item = normalizeCodexNotification(value);
        if (!item || item.source !== 'remote') {
          continue;
        }
        if (
          known.has(item.key)
        ) {
          stalePaths.push(item.remoteInboxPath);
          continue;
        }
        unseen.push(item);
        known.add(item.key);
      }
      await removeRemoteCodexEventFiles(stalePaths);
    } catch (error) {
      logger?.error?.(`[feishu-watchdog] ${error?.message ?? error}`);
    }
  }

  let names = new Map();
  const localUnseen = unseen.filter((item) => item.source !== 'remote');
  if (localUnseen.length > 0) {
    try {
      names = await resolveCodexThreadNames({
        threadIds: [...new Set(localUnseen.map((item) => item.threadId))],
        requestTimeoutMs: 3_000
      });
    } catch (error) {
      logger?.error?.(`[feishu-watchdog] ${error?.message ?? error}`);
    }
  }
  for (const item of unseen) {
    if (item.source !== 'remote') {
      item.threadName = String(names.get(item.threadId) ?? '').trim();
    }
    completionState.pending[item.key] = item;
  }

  return {
    events: Object.values(completionState.pending)
      .sort((left, right) => codexNotificationTimeMs(left) - codexNotificationTimeMs(right))
      .map(createCodexNotificationEvent),
    state: next
  };
}

async function clearRemoteEventInbox(remoteEventsDir, logger) {
  try {
    const events = await readRemoteCodexEvents(remoteEventsDir);
    await removeRemoteCodexEventFiles(events.map((event) => event.inboxPath));
  } catch (error) {
    logger?.error?.(`[feishu-watchdog] ${error?.message ?? error}`);
  }
}

function normalizeCodexCompletionState(value = {}) {
  const pending = {};
  for (const item of Object.values(
    value?.pending && typeof value.pending === 'object' ? value.pending : {}
  )) {
    const normalized = normalizeCodexNotification(item);
    if (normalized) {
      pending[normalized.key] = normalized;
    }
  }
  const goalStates = {};
  for (const [threadId, goal] of Object.entries(
    value?.goalStates && typeof value.goalStates === 'object' ? value.goalStates : {}
  )) {
    const status = String(goal?.status ?? '').trim().toLowerCase();
    const createdAt = normalizeIso(goal?.createdAt);
    const updatedAt = normalizeIso(goal?.updatedAt);
    if (threadId && status && createdAt && updatedAt) {
      goalStates[threadId] = { status, createdAt, updatedAt };
    }
  }
  return {
    answerEnabledAt: normalizeIso(value?.answerEnabledAt ?? value?.enabledAt),
    goalEnabledAt: normalizeIso(value?.goalEnabledAt),
    scanAfter: normalizeIso(value?.scanAfter),
    pending,
    delivered: [...new Set(
      (Array.isArray(value?.delivered) ? value.delivered : [])
        .map((key) => String(key ?? '').trim())
        .filter(Boolean)
    )].slice(-500),
    goalStates
  };
}

function hasCodexCompletionState(value = {}) {
  return Boolean(
    value.answerEnabledAt ||
    value.goalEnabledAt ||
    value.scanAfter ||
    Object.keys(value.pending ?? {}).length ||
    value.delivered?.length ||
    Object.keys(value.goalStates ?? {}).length
  );
}

function normalizeCodexNotification(value = {}) {
  const threadId = String(value.threadId ?? '').trim();
  if ((value.type === 'goal' || value.status) && threadId) {
    const status = String(value.status ?? '').trim().toLowerCase();
    const createdAt = normalizeIso(value.createdAt);
    const updatedAt = normalizeIso(value.updatedAt);
    if (!status || !createdAt || !updatedAt) {
      return null;
    }
    return {
      type: 'goal',
      key: String(value.key ?? `${threadId}:${createdAt}:${updatedAt}:${status}`),
      source: value.source === 'remote' ? 'remote' : 'local',
      sourceId: String(value.sourceId ?? '').trim(),
      machineName: String(value.machineName ?? '').trim(),
      remoteInboxPath: String(value.inboxPath ?? value.remoteInboxPath ?? '').trim() || null,
      threadId,
      cwd: String(value.cwd ?? '').trim(),
      threadName: String(value.threadName ?? '').trim(),
      receivedAt: normalizeIso(value.receivedAt),
      status,
      createdAt,
      updatedAt
    };
  }
  const turnId = String(value.turnId ?? '').trim();
  const completedAt = normalizeIso(value.completedAt);
  if (!threadId || !turnId || !completedAt) {
    return null;
  }
  return {
    type: 'completion',
    key: String(value.key ?? `${threadId}:${turnId}`),
    source: value.source === 'remote' ? 'remote' : 'local',
    sourceId: String(value.sourceId ?? '').trim(),
    machineName: String(value.machineName ?? '').trim(),
    remoteInboxPath: String(value.inboxPath ?? value.remoteInboxPath ?? '').trim() || null,
    threadId,
    turnId,
    cwd: String(value.cwd ?? '').trim(),
    threadName: String(value.threadName ?? '').trim(),
    receivedAt: normalizeIso(value.receivedAt),
    startedAt: normalizeIso(value.startedAt),
    completedAt,
    durationMs: Number.isFinite(Number(value.durationMs)) && Number(value.durationMs) >= 0
      ? Number(value.durationMs)
      : null
  };
}

function createCodexNotificationEvent(item) {
  const target = item.source === 'remote'
    ? `${item.machineName || '远程电脑'} / ${item.threadName || basename(item.cwd) || item.threadId.slice(0, 8)}`
    : item.threadName || basename(item.cwd) ||
    `会话 ${item.threadId.slice(0, 8)}`;
  const shortTarget = target.length > 60 ? `${target.slice(0, 59)}…` : target;
  const details = [`会话：${target}`];
  if (item.type === 'completion' && item.durationMs !== null) {
    details.push(`耗时：${formatDuration(item.durationMs)}`);
  }
  const notificationType = item.type === 'goal'
    ? item.status === 'paused' ? '目标暂停' : '目标完成'
    : '回答完成';
  return {
    type: 'completion',
    completionKey: item.key,
    remoteInboxPath: item.remoteInboxPath ?? null,
    condition: {
      key: `codex-completion:${item.key}`,
      kind: item.type === 'goal' ? `codex-goal-${item.status}` : 'codex-answer-completed',
      title: `${notificationType}：${shortTarget}`,
      message: details.join('\n')
    },
    firstSeenAt: item.type === 'goal' ? item.updatedAt : item.completedAt
  };
}

function codexNotificationTimeMs(item) {
  return dateMs(item?.type === 'goal' || item?.status ? item.updatedAt : item.completedAt);
}

function normalizeAlertState(alerts) {
  const normalized = {};
  for (const [key, value] of Object.entries(
    alerts && typeof alerts === 'object' ? structuredClone(alerts) : {}
  )) {
    let normalizedKey = key;
    if (value?.condition?.kind === 'low-balance' && key.startsWith('low-balance:')) {
      const suffix = key.slice('low-balance:'.length);
      const separator = suffix.lastIndexOf(':');
      if (separator >= 0) {
        normalizedKey = `low-balance:${suffix.slice(separator + 1)}`;
        value.condition.key = normalizedKey;
      }
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

function clearDisabledNotificationState(state, monitoring) {
  const next = normalizeWatchdogState(state);
  const notifications = notificationSettings(monitoring);
  if (!notifications.programIssues) {
    next.healthFailureCount = 0;
  }
  if (!notifications.multiplierChanged) {
    next.activeMultiplier = null;
  }
  if (!notifications.answerCompleted && !notifications.goalStatusChanged && !notifications.remoteCompletion) {
    next.codexCompletions = normalizeCodexCompletionState();
  } else {
    if (!notifications.answerCompleted) {
      next.codexCompletions.answerEnabledAt = null;
      removePendingCodexNotifications(next.codexCompletions, 'completion');
    }
    if (!notifications.goalStatusChanged) {
      next.codexCompletions.goalEnabledAt = null;
      removePendingCodexNotifications(next.codexCompletions, 'goal');
    }
    if (!notifications.remoteCompletion) {
      removePendingCodexNotifications(next.codexCompletions, 'remote');
    }
  }
  const enabledByKind = {
    'proxy-unreachable': notifications.programIssues,
    'no-usable-site': notifications.noUsableSite,
    'low-balance': notifications.lowBalance
  };
  for (const [key, alert] of Object.entries(next.alerts)) {
    if (!enabledByKind[alert?.condition?.kind]) {
      delete next.alerts[key];
    }
  }
  return next;
}

function reconcileMultiplierChange({ config = {}, state = {}, now = new Date() } = {}) {
  const next = normalizeWatchdogState(state);
  if (!notificationSettings(config.monitoring).multiplierChanged) {
    next.activeMultiplier = null;
    return { events: [], state: next };
  }
  const site = (Array.isArray(config.sites) ? config.sites : [])
    .find((candidate) => candidate.id === config.activeSiteId);
  const current = site ? normalizeMultiplierSnapshot({
    siteId: site.id,
    siteName: site.name,
    value: calculateEffectiveMultiplier(site)
  }) : null;
  const previous = next.activeMultiplier;
  if (!current || !previous || current.value === previous.value) {
    next.activeMultiplier = current;
    return { events: [], state: next };
  }
  return {
    events: [{
      type: 'alert',
      condition: {
        key: 'multiplier-changed',
        kind: 'multiplier-changed',
        title: `倍率切换：${formatMultiplier(previous.value)}x → ${formatMultiplier(current.value)}x`,
        message: `${previous.siteName} ${formatMultiplier(previous.value)}x → ${current.siteName} ${formatMultiplier(current.value)}x`
      },
      firstSeenAt: new Date(now).toISOString(),
      multiplierSnapshot: current
    }],
    state: next
  };
}

function normalizeMultiplierSnapshot(snapshot) {
  const value = Number(snapshot?.value);
  if (!snapshot || !Number.isFinite(value)) {
    return null;
  }
  return {
    siteId: String(snapshot.siteId ?? ''),
    siteName: String(snapshot.siteName ?? ''),
    value
  };
}

function notificationSettings(monitoring = {}) {
  return {
    multiplierChanged: monitoring.notifications?.multiplierChanged ?? true,
    lowBalance: monitoring.notifications?.lowBalance ?? true,
    noUsableSite: monitoring.notifications?.noUsableSite ?? true,
    programIssues: monitoring.notifications?.programIssues ?? true,
    answerCompleted: monitoring.notifications?.answerCompleted ?? false,
    goalStatusChanged: monitoring.notifications?.goalStatusChanged ?? false,
    remoteCompletion: monitoring.notifications?.remoteCompletion ?? false
  };
}

function removePendingCodexNotifications(state, type) {
  for (const [key, item] of Object.entries(state.pending)) {
    if (type === 'remote' ? item.source === 'remote' : item.type === type && item.source !== 'remote') {
      delete state.pending[key];
    }
  }
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function formatMultiplier(value) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}

function addCondition(conditions, condition) {
  conditions.set(condition.key, sanitizeCondition(condition));
}

function sanitizeCondition(condition = {}) {
  const sanitized = {
    key: String(condition.key ?? ''),
    kind: String(condition.kind ?? ''),
    title: String(condition.title ?? ''),
    message: String(condition.message ?? '')
  };
  if (Number(condition.notifyAfterMs) > 0) {
    sanitized.notifyAfterMs = Number(condition.notifyAfterMs);
  }
  return sanitized;
}

function createEvent(type, entry) {
  return {
    type,
    condition: structuredClone(entry.condition),
    firstSeenAt: entry.firstSeenAt
  };
}

function formatTarget(site) {
  const account = maskAccount(site.sync?.username);
  return account ? `${site.name} / ${account}` : site.name;
}

function maskAccount(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  const [name, domain] = text.split('@');
  const masked = name.length > 1 ? `${name[0]}***${name.at(-1)}` : `${name[0]}***`;
  return domain ? `${masked}@${domain}` : masked;
}

function validateFeishuWebhook(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Feishu webhook URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) ||
    !url.pathname.startsWith('/open-apis/bot/v2/hook/')
  ) {
    throw new Error('Feishu webhook URL is invalid');
  }
  return url.toString();
}

function dateMs(value) {
  const time = new Date(value ?? 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeIso(value) {
  const time = new Date(value ?? NaN).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function monitoringIntervalMs(monitoring) {
  const configured = Math.max(10, Number(monitoring?.checkIntervalSeconds) || 30) * 1000;
  const notifications = notificationSettings(monitoring);
  return notifications.answerCompleted || notifications.goalStatusChanged
    || notifications.remoteCompletion
    ? Math.min(configured, 10_000)
    : configured;
}

async function checkProxyHealth(port, fetchImpl) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    return false;
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${normalizedPort}/__proxy/health`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return payload?.ok === true;
  } catch {
    return false;
  }
}

async function readWatchdogState(filePath) {
  try {
    return normalizeWatchdogState(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return normalizeWatchdogState();
    }
    throw error;
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}
