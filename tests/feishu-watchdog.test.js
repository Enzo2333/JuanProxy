import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildFeishuCard,
  collectAlertConditions,
  normalizeWatchdogState,
  reconcileAlerts,
  recordAlertDelivery,
  runWatchdogCheck,
  sendFeishuWebhook
} from '../src/monitoring/feishu-watchdog.js';
import { storeRemoteCodexEvents } from '../src/monitoring/remote-codex-event-inbox.js';

function site(overrides = {}) {
  return {
    id: overrides.id ?? 'site-1',
    name: overrides.name ?? 'Primary',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    manualEnabled: overrides.manualEnabled ?? true,
    failureDisabled: overrides.failureDisabled ?? false,
    rateLimit: overrides.rateLimit ?? { enabled: false },
    rateLimitState: overrides.rateLimitState ?? { pausedUntil: null },
    multiplier: overrides.multiplier ?? 1,
    multiplierLocked: overrides.multiplierLocked ?? false,
    customMultiplier: overrides.customMultiplier ?? null,
    sync: {
      enabled: overrides.syncEnabled ?? true,
      accountId: overrides.accountId ?? 'account-1',
      username: overrides.username ?? 'owner@example.com',
      lastSyncAt: overrides.lastSyncAt ?? null,
      lastSyncStatus: overrides.lastSyncStatus ?? 'success',
      lastSyncError: overrides.lastSyncError ?? null,
      remote: {
        balance: overrides.balance ?? '¥8.50',
        groupMultiplier: overrides.groupMultiplier ?? 1
      }
    }
  };
}

function config(sites, rules, monitoring = {}) {
  return {
    monitoring: {
      enabled: true,
      feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
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
      ...monitoring,
      rules
    },
    activeSiteId: sites[0]?.id ?? null,
    sites
  };
}

test('collects global and per-account alert conditions without leaking credentials', () => {
  const first = site({ failureDisabled: true, balance: '¥8.50' });
  const muted = site({
    id: 'site-2',
    accountId: 'account-2',
    failureDisabled: true,
    balance: '$0.00'
  });
  const conditions = collectAlertConditions({
    config: config([first, muted], [
      { accountId: first.sync.accountId, enabled: true, balanceThreshold: 10 },
      { accountId: muted.sync.accountId, enabled: false, balanceThreshold: 10 }
    ]),
    healthOk: true,
    healthFailureCount: 0,
    now: new Date('2026-08-11T10:00:00.000Z')
  });

  assert.deepEqual([...conditions.keys()].sort(), [
    'low-balance:account-1',
    'no-usable-site'
  ]);
  assert.doesNotMatch(JSON.stringify([...conditions.values()]), /sk-secret/);
  assert.equal(conditions.get('low-balance:account-1').title, '余额不足：Primary');
  assert.equal(conditions.get('no-usable-site').title, '无可用站点：已持续 5 分钟');
  assert.match(conditions.get('low-balance:account-1').message, /8\.50/);
  assert.match(conditions.get('low-balance:account-1').message, /10/);
  assert.equal(conditions.get('no-usable-site').notifyAfterMs, 5 * 60 * 1000);
});

test('waits for consecutive health failures and suppresses stale site conditions while down', () => {
  const monitored = site({ failureDisabled: true, balance: '$0.00' });
  const input = {
    config: config([monitored], [{
      accountId: monitored.sync.accountId,
      enabled: true,
      balanceThreshold: 10
    }]),
    healthOk: false,
    now: new Date('2026-08-11T10:00:00.000Z')
  };

  assert.equal(collectAlertConditions({ ...input, healthFailureCount: 2 }).size, 0);
  assert.deepEqual(
    [...collectAlertConditions({ ...input, healthFailureCount: 3 }).keys()],
    ['proxy-unreachable']
  );
  assert.equal(
    collectAlertConditions({ ...input, healthFailureCount: 3 }).get('proxy-unreachable').title,
    '程序异常：本地代理未响应'
  );
  input.config.monitoring.notifications.programIssues = false;
  assert.equal(collectAlertConditions({ ...input, healthFailureCount: 3 }).size, 0);
});

test('one account rule controls low-balance alerts across all linked sites', () => {
  const monitored = site({ balance: '$0.00', lastSyncAt: '2026-08-11T09:00:00.000Z' });
  const linked = site({ id: 'site-2', balance: '$0.00', lastSyncAt: '2026-08-11T09:01:00.000Z' });
  const base = {
    config: config([monitored, linked], [{
      accountId: monitored.sync.accountId,
      enabled: true,
      balanceThreshold: 10
    }]),
    healthOk: true,
    healthFailureCount: 0,
    now: new Date('2026-08-11T10:00:00.000Z')
  };
  assert.deepEqual([...collectAlertConditions(base).keys()], ['low-balance:account-1']);

  linked.sync.remote.balance = '$100.00';
  assert.equal(collectAlertConditions(base).size, 0);

  base.config.monitoring.rules = [{
    accountId: monitored.sync.accountId,
    enabled: false,
    balanceThreshold: null
  }];
  assert.equal(collectAlertConditions(base).size, 0);
});

test('migrates persisted site-account balance alert keys to account keys', () => {
  const state = normalizeWatchdogState({
    alerts: {
      'low-balance:site-1:account-1': {
        condition: {
          key: 'low-balance:site-1:account-1',
          kind: 'low-balance',
          title: '站点余额不足',
          message: '余额不足'
        },
        active: true,
        notifiedActive: true
      }
    }
  });
  assert.deepEqual(Object.keys(state.alerts), ['low-balance:account-1']);
  assert.equal(state.alerts['low-balance:account-1'].condition.key, 'low-balance:account-1');
});

test('does not report balances when synchronization has no current value', () => {
  const monitored = site({
    lastSyncStatus: 'failure',
    lastSyncError: 'session expired',
    balance: '$100.00'
  });
  const conditions = collectAlertConditions({
    config: config([monitored], [{
      accountId: monitored.sync.accountId,
      enabled: true,
      balanceThreshold: 10
    }]),
    healthOk: true,
    healthFailureCount: 0,
    now: new Date('2026-08-11T10:00:00.000Z')
  });

  assert.equal(conditions.size, 0);
});

test('waits for the configured no-usable-site duration before alerting', () => {
  const condition = {
    key: 'no-usable-site',
    kind: 'no-usable-site',
    title: '没有可用站点',
    message: '当前不存在可转发请求的站点',
    notifyAfterMs: 5 * 60 * 1000
  };
  let result = reconcileAlerts({
    conditions: new Map([[condition.key, condition]]),
    now: new Date('2026-08-11T10:00:00.000Z')
  });
  assert.equal(result.events.length, 0);
  result = reconcileAlerts({
    conditions: new Map([[condition.key, condition]]),
    state: result.state,
    now: new Date('2026-08-11T10:04:59.000Z')
  });
  assert.equal(result.events.length, 0);
  result = reconcileAlerts({
    conditions: new Map([[condition.key, condition]]),
    state: result.state,
    now: new Date('2026-08-11T10:05:00.000Z')
  });
  assert.equal(result.events[0].type, 'alert');
});

test('uses the proxy selection policy for no-usable-site alerts and recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-no-selectable-site-watchdog-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'watchdog-state.json');
  const input = {
    proxy: {
      port: 8787,
      smartSwitching: true,
      priorityMode: 'multiplier',
      samePriorityStrategy: 'round-robin',
      autoSwitchMultiplierLimit: { enabled: true, maxMultiplier: 0.08 }
    },
    ...config([site({ groupMultiplier: 0.1 })], [], {
      noUsableSiteDelayMinutes: 1,
      notifications: {
        multiplierChanged: false,
        lowBalance: false,
        noUsableSite: true,
        programIssues: false,
        answerCompleted: false,
        goalStatusChanged: false
      }
    })
  };
  const cards = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/__proxy/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    cards.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  };

  try {
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-20T03:30:00.000Z') });
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-20T03:31:00.000Z') });
    assert.equal(cards[0].card.header.title.content, '无可用站点：已持续 1 分钟');

    input.sites[0].sync.remote.groupMultiplier = 0.05;
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-20T03:31:30.000Z') });
    assert.equal(cards[1].card.header.title.content, '无可用站点：已持续 1 分钟（已恢复）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deduplicates active alerts, reminds after 30 minutes, and notifies recovery once', () => {
  const condition = {
    key: 'proxy-unreachable',
    kind: 'proxy-unreachable',
    title: 'JuanProxy 本地代理未响应',
    message: '连续 3 次健康检查失败'
  };
  let state = { version: 1, healthFailureCount: 3, alerts: {} };

  let result = reconcileAlerts({
    conditions: new Map([[condition.key, condition]]),
    state,
    now: new Date('2026-08-11T10:00:00.000Z'),
    repeatIntervalMinutes: 30
  });
  assert.equal(result.events[0].type, 'alert');
  state = recordAlertDelivery(result.state, result.events[0], new Date('2026-08-11T10:00:00.000Z'));

  result = reconcileAlerts({
    conditions: new Map([[condition.key, condition]]),
    state,
    now: new Date('2026-08-11T10:29:59.000Z'),
    repeatIntervalMinutes: 30
  });
  assert.equal(result.events.length, 0);

  result = reconcileAlerts({
    conditions: new Map([[condition.key, condition]]),
    state,
    now: new Date('2026-08-11T10:30:00.000Z'),
    repeatIntervalMinutes: 30
  });
  assert.equal(result.events[0].type, 'reminder');
  state = recordAlertDelivery(result.state, result.events[0], new Date('2026-08-11T10:30:00.000Z'));

  result = reconcileAlerts({
    conditions: new Map(),
    state,
    now: new Date('2026-08-11T10:31:00.000Z'),
    repeatIntervalMinutes: 30
  });
  assert.equal(result.events[0].type, 'recovery');
  const reappeared = reconcileAlerts({
    conditions: new Map([[condition.key, condition]]),
    state: result.state,
    now: new Date('2026-08-11T10:32:00.000Z'),
    repeatIntervalMinutes: 30
  });
  assert.equal(reappeared.events[0].type, 'alert');
  state = recordAlertDelivery(result.state, result.events[0], new Date('2026-08-11T10:31:00.000Z'));
  assert.deepEqual(state.alerts, {});
});

test('sends a Feishu card and rejects unsuccessful webhook responses', async () => {
  const requests = [];
  const event = {
    type: 'alert',
    condition: {
      key: 'low-balance:account-1',
      kind: 'low-balance',
      title: '站点余额不足',
      message: 'Primary / o***r@example.com：当前余额 8.50，阈值 10'
    },
    firstSeenAt: '2026-08-11T10:00:00.000Z'
  };

  await sendFeishuWebhook({
    webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    event,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://open.feishu.cn/open-apis/bot/v2/hook/test');
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.card.header.title.content, '站点余额不足');
  assert.equal(payload.card.elements[0].text.tag, 'plain_text');
  assert.doesNotMatch(payload.card.elements[0].text.content, /\*\*站点余额不足\*\*/);
  assert.match(JSON.stringify(payload), /站点余额不足/);

  await assert.rejects(() => sendFeishuWebhook({
    webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    event,
    fetchImpl: async () => new Response(JSON.stringify({ code: 19001, msg: 'bad hook' }), {
      status: 200
    })
  }), /bad hook/);
});

test('adds concise status text to reminder and recovery card titles', () => {
  const event = {
    condition: {
      key: 'proxy-unreachable',
      kind: 'proxy-unreachable',
      title: 'JuanProxy 本地代理未响应',
      message: '连续 3 次健康检查失败'
    }
  };

  assert.equal(
    buildFeishuCard({ ...event, type: 'reminder' }).card.header.title.content,
    'JuanProxy 本地代理未响应（持续）'
  );
  assert.equal(
    buildFeishuCard({ ...event, type: 'recovery' }).card.header.title.content,
    'JuanProxy 本地代理未响应（已恢复）'
  );
});

test('splits ordinary answer and goal status notifications without notifying goal turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-codex-completion-watchdog-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'watchdog-state.json');
  const ordinaryCompletion = {
    type: 'completion',
    key: 'thread-12345678:ordinary-turn',
    threadId: 'thread-12345678',
    turnId: 'ordinary-turn',
    rolloutPath: join(dir, 'rollout.jsonl'),
    cwd: 'E:\\Commercial_Project\\JuanProxy',
    startedAt: '2026-08-11T10:00:45.000Z',
    completedAt: '2026-08-11T10:00:50.000Z',
    durationMs: 5_000
  };
  let discoveryCount = 0;
  const cards = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/__proxy/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    cards.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  };
  const input = {
    proxy: { port: 8787 },
    ...config([site()], [], {
      notifications: {
        multiplierChanged: false,
        lowBalance: false,
        noUsableSite: false,
        programIssues: false,
        answerCompleted: true,
        goalStatusChanged: true
      }
    })
  };

  try {
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    const options = {
      configPath,
      statePath,
      sessionsDir: join(dir, 'sessions'),
      fetchImpl,
      findCodexEvents: async () => {
        discoveryCount += 1;
        if (discoveryCount === 1) {
          return [];
        }
        if (discoveryCount > 2) {
          return [];
        }
        return [
          {
            type: 'goal',
            key: 'thread-12345678:goal-1:active',
            threadId: 'thread-12345678',
            cwd: ordinaryCompletion.cwd,
            status: 'active',
            createdAt: '2026-08-11T10:00:10.000Z',
            updatedAt: '2026-08-11T10:00:10.000Z'
          },
          {
            type: 'completion',
            key: 'thread-12345678:goal-turn-1',
            threadId: 'thread-12345678',
            turnId: 'goal-turn-1',
            cwd: ordinaryCompletion.cwd,
            completedAt: '2026-08-11T10:00:20.000Z',
            durationMs: 10_000
          },
          {
            type: 'goal',
            key: 'thread-12345678:goal-1:paused',
            threadId: 'thread-12345678',
            cwd: ordinaryCompletion.cwd,
            status: 'paused',
            createdAt: '2026-08-11T10:00:10.000Z',
            updatedAt: '2026-08-11T10:00:21.000Z'
          },
          {
            type: 'goal',
            key: 'thread-12345678:goal-1:active-2',
            threadId: 'thread-12345678',
            cwd: ordinaryCompletion.cwd,
            status: 'active',
            createdAt: '2026-08-11T10:00:10.000Z',
            updatedAt: '2026-08-11T10:00:30.000Z'
          },
          {
            type: 'completion',
            key: 'thread-12345678:goal-turn-2',
            threadId: 'thread-12345678',
            turnId: 'goal-turn-2',
            cwd: ordinaryCompletion.cwd,
            completedAt: '2026-08-11T10:00:40.000Z',
            durationMs: 10_000
          },
          {
            type: 'goal',
            key: 'thread-12345678:goal-1:complete',
            threadId: 'thread-12345678',
            cwd: ordinaryCompletion.cwd,
            status: 'complete',
            createdAt: '2026-08-11T10:00:10.000Z',
            updatedAt: '2026-08-11T10:00:41.000Z'
          },
          ordinaryCompletion
        ];
      },
      resolveCodexThreadNames: async () => new Map([
        [ordinaryCompletion.threadId, '实现飞书完成通知']
      ]),
      logger: { error() {} }
    };

    const initial = await runWatchdogCheck({
      ...options,
      now: new Date('2026-08-11T10:00:00.000Z')
    });
    assert.equal(initial.intervalMs, 10_000);
    assert.equal(cards.length, 0);

    await runWatchdogCheck({ ...options, now: new Date('2026-08-11T10:01:00.000Z') });
    let state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(state.codexCompletions.pending, {});
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map((card) => card.card.header.title.content), [
      '目标暂停：实现飞书完成通知',
      '目标完成：实现飞书完成通知',
      '回答完成：实现飞书完成通知'
    ]);
    assert.doesNotMatch(JSON.stringify(cards), /goal-turn/);
    assert.equal(state.codexCompletions.goalStates['thread-12345678'].status, 'complete');

    await runWatchdogCheck({ ...options, now: new Date('2026-08-11T10:01:30.000Z') });
    assert.equal(cards.length, 3);

    input.monitoring.enabled = false;
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ ...options, now: new Date('2026-08-11T10:02:00.000Z') });
    state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.codexCompletions.answerEnabledAt, null);
    assert.equal(state.codexCompletions.goalEnabledAt, null);
    assert.deepEqual(state.codexCompletions.delivered, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delivers remote answer completions through its independent switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-remote-completion-watchdog-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'watchdog-state.json');
  const remoteEventsDir = join(dir, 'remote-codex-events');
  const cards = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/__proxy/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    cards.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  };
  const input = {
    proxy: { port: 8787 },
    ...config([site()], [], {
      notifications: {
        multiplierChanged: false,
        lowBalance: false,
        noUsableSite: false,
        programIssues: false,
        answerCompleted: false,
        goalStatusChanged: false,
        remoteCompletion: true
      }
    })
  };
  try {
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({
      configPath,
      statePath,
      remoteEventsDir,
      fetchImpl,
      now: new Date('2026-08-20T10:00:00.000Z')
    });
    await storeRemoteCodexEvents({
      inboxDir: remoteEventsDir,
      source: { id: 'remote-pc', name: 'REMOTE-PC' },
      events: [
        {
          threadId: 'thread-remote',
          turnId: 'turn-remote',
          cwd: 'E:\\RemoteProject',
          completedAt: '2026-08-20T10:01:00.000Z',
          receivedAt: '2026-08-20T10:01:01.000Z',
          durationMs: 12_000
        },
        {
          type: 'goal',
          threadId: 'thread-goal',
          cwd: 'E:\\GoalProject',
          status: 'complete',
          createdAt: '2026-08-20T10:00:10.000Z',
          updatedAt: '2026-08-20T10:01:02.000Z',
          receivedAt: '2026-08-20T10:01:03.000Z'
        }
      ]
    });

    const result = await runWatchdogCheck({
      configPath,
      statePath,
      remoteEventsDir,
      fetchImpl,
      now: new Date('2026-08-20T10:01:05.000Z')
    });
    assert.equal(result.delivered, 2);
    assert.deepEqual(cards.map((card) => card.card.header.title.content), [
      '回答完成：REMOTE-PC / RemoteProject',
      '目标完成：REMOTE-PC / GoalProject'
    ]);
    assert.deepEqual(await readdir(remoteEventsDir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps remote completion events queued until Feishu delivery succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-remote-completion-retry-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'watchdog-state.json');
  const remoteEventsDir = join(dir, 'remote-codex-events');
  let fail = true;
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/__proxy/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (fail) {
      throw new Error('Feishu offline');
    }
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  };
  const input = {
    proxy: { port: 8787 },
    ...config([site()], [], {
      notifications: {
        multiplierChanged: false,
        lowBalance: false,
        noUsableSite: false,
        programIssues: false,
        answerCompleted: false,
        goalStatusChanged: false,
        remoteCompletion: true
      }
    })
  };
  try {
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, remoteEventsDir, fetchImpl, now: new Date('2026-08-20T11:00:00.000Z') });
    await storeRemoteCodexEvents({
      inboxDir: remoteEventsDir,
      source: { id: 'remote-pc', name: 'REMOTE-PC' },
      events: [{
        threadId: 'thread-retry',
        turnId: 'turn-retry',
        cwd: 'E:\\RetryProject',
        completedAt: '2026-08-20T11:01:00.000Z',
        receivedAt: '2026-08-20T11:01:01.000Z'
      }]
    });
    const failed = await runWatchdogCheck({ configPath, statePath, remoteEventsDir, fetchImpl, now: new Date('2026-08-20T11:01:05.000Z') });
    assert.equal(failed.delivered, 0);
    assert.equal(Object.keys(failed.state.codexCompletions.pending).length, 1);
    fail = false;
    const retried = await runWatchdogCheck({ configPath, statePath, remoteEventsDir, fetchImpl, now: new Date('2026-08-20T11:01:10.000Z') });
    assert.equal(retried.delivered, 1);
    assert.deepEqual(await readdir(remoteEventsDir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tracks the active effective multiplier, retries delivery, and respects its switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-multiplier-watchdog-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'watchdog-state.json');
  const first = site({ id: 'site-1', name: 'Primary', groupMultiplier: 1 });
  const second = site({ id: 'site-2', name: 'Backup', accountId: 'account-2', groupMultiplier: 1 });
  const input = {
    proxy: { port: 8787 },
    ...config([first, second], []),
    activeSiteId: first.id
  };
  const cards = [];
  let rejectWebhook = false;
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/__proxy/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (rejectWebhook) {
      return new Response(JSON.stringify({ code: 1, msg: 'temporary error' }), { status: 200 });
    }
    cards.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  };

  try {
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-11T10:00:00Z') });
    assert.equal(cards.length, 0);

    input.activeSiteId = second.id;
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-11T10:00:30Z') });
    assert.equal(cards.length, 0);

    second.sync.remote.groupMultiplier = 2;
    rejectWebhook = true;
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({
      configPath,
      statePath,
      fetchImpl,
      now: new Date('2026-08-11T10:01:00Z'),
      logger: { error() {} }
    });
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).activeMultiplier.value, 1);

    rejectWebhook = false;
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-11T10:01:30Z') });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].card.header.title.content, '倍率切换：1x → 2x');
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-11T10:02:00Z') });
    assert.equal(cards.length, 1);

    input.monitoring.notifications.multiplierChanged = false;
    second.sync.remote.groupMultiplier = 3;
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-11T10:02:30Z') });
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).activeMultiplier, null);
    input.monitoring.notifications.multiplierChanged = true;
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl, now: new Date('2026-08-11T10:03:00Z') });
    assert.equal(cards.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('turning off an alert type clears its active state without a recovery message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-notification-switch-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'watchdog-state.json');
  const monitored = site({ balance: '$0.00' });
  const input = {
    proxy: { port: 8787 },
    ...config([monitored], [{
      accountId: monitored.sync.accountId,
      enabled: true,
      balanceThreshold: 10
    }])
  };
  const cards = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/__proxy/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    cards.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  };

  try {
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl });
    assert.equal(cards.length, 1);
    input.monitoring.notifications.lowBalance = false;
    await writeFile(configPath, JSON.stringify(input), 'utf8');
    await runWatchdogCheck({ configPath, statePath, fetchImpl });
    assert.equal(cards.length, 1);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).alerts, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists health failure counts across checks and sends recovery after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'juanproxy-feishu-watchdog-'));
  const configPath = join(dir, 'config.json');
  const statePath = join(dir, 'watchdog-state.json');
  let healthOk = false;
  const cards = [];

  try {
    await writeFile(configPath, JSON.stringify({
      proxy: { port: 8787 },
      monitoring: {
        enabled: true,
        feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
        failureThreshold: 3,
        repeatIntervalMinutes: 30,
        notifications: { noUsableSite: false },
        rules: []
      },
      sites: [site()]
    }), 'utf8');
    const fetchImpl = async (url, options) => {
      if (String(url).includes('/__proxy/health')) {
        if (!healthOk) {
          throw new Error('connection refused');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      cards.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
    };

    for (let index = 0; index < 3; index += 1) {
      await runWatchdogCheck({
        configPath,
        statePath,
        fetchImpl,
        now: new Date(`2026-08-11T10:00:0${index}.000Z`)
      });
    }
    assert.equal(cards.length, 1);
    assert.match(JSON.stringify(cards[0]), /本地代理未响应/);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).healthFailureCount, 3);

    healthOk = true;
    await runWatchdogCheck({
      configPath,
      statePath,
      fetchImpl,
      now: new Date('2026-08-11T10:00:03.000Z')
    });
    assert.equal(cards.length, 2);
    assert.match(JSON.stringify(cards[1]), /已恢复/);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).alerts, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
