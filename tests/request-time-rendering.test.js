import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rendererHtmlPath = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url));
const floatingHtmlPath = fileURLToPath(new URL('../src/renderer/floating.html', import.meta.url));
const mainJsPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
let rendererImportCounter = 0;

function createElementStub(tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  return {
    tagName: String(tagName).toUpperCase(),
    _innerHTML: '',
    _className: '',
    children: [],
    checked: false,
    dataset: {},
    hidden: false,
    style: {},
    _textContent: '',
    title: '',
    type: '',
    value: '',
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(value) {
      this._innerHTML = value;
      this.children = [];
    },
    get textContent() {
      if (this._textContent || this.children.length === 0) {
        return this._textContent;
      }
      return this.children
        .map((child) => typeof child === 'string' ? child : child.textContent ?? '')
        .join('');
    },
    set textContent(value) {
      this._textContent = String(value ?? '');
    },
    get className() {
      return this._className;
    },
    set className(value) {
      this._className = String(value ?? '');
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    append(...children) {
      for (const child of children) {
        if (child && typeof child === 'object') {
          child.parentElement = this;
        }
      }
      this.children.push(...children);
    },
    remove() {
      if (!this.parentElement?.children) {
        return;
      }
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      this[name] = value;
    },
    getAttribute(name) {
      return attributes.get(name);
    },
    async dispatchEvent(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) {
        await listener({
          preventDefault() {},
          ...event
        });
      }
    },
    focus() {
      if (globalThis.document) {
        globalThis.document.activeElement = this;
      }
    }
  };
}

function tagNameForSelector(selector) {
  const selectSelectors = new Set([
    '#priority-mode',
    '#same-priority-strategy',
    '#site-sync-global-interval-unit',
    '#group-sync-interval-unit',
    '#config-export-mode',
    '#site-sync-provider-type',
    '#site-sync-interval-mode',
    '#site-sync-interval-unit',
    '#rate-limit-window-unit',
    '#auto-recovery-interval-unit',
    '#site-status-filter',
    '#site-sort'
  ]);
  const textareaSelectors = new Set([
    '#global-model-mapping',
    '#site-model-mapping',
    '#site-remark'
  ]);
  const inputSelectors = new Set([
    '#proxy-port',
    '#proxy-timeout-seconds',
    '#proxy-replay-buffer-mb',
    '#failure-threshold',
    '#smart-switching',
    '#auto-switch-multiplier-limit-enabled',
    '#auto-switch-max-multiplier',
    '#global-model-mapping-enabled',
    '#site-sync-global-interval-value',
    '#site-sync-intelligent-scheduling',
    '#group-sync-interval-value',
    '#config-export-global-settings',
    '#config-import-global-settings',
    '#floating-always-on-top',
    '#smart-switch',
    '#site-id',
    '#site-name',
    '#site-base-url',
    '#site-api-key',
    '#site-test-model',
    '#site-model-mapping-enabled',
    '#site-priority',
    '#site-multiplier',
    '#site-multiplier-locked',
    '#site-sync-enabled',
    '#site-sync-dashboard-url',
    '#site-sync-username',
    '#site-sync-password',
    '#site-sync-interval-value',
    '#site-sync-group-id',
    '#rate-limit-enabled',
    '#rate-limit-count',
    '#rate-limit-window-value',
    '#auto-recovery-enabled',
    '#auto-recovery-interval-value',
    '#site-enabled'
  ]);

  if (selectSelectors.has(selector)) {
    return 'select';
  }
  if (textareaSelectors.has(selector)) {
    return 'textarea';
  }
  if (inputSelectors.has(selector)) {
    return 'input';
  }
  return 'div';
}

async function setupRendererApp({
  sites = [],
  activeSiteId = null,
  proxy = {
    port: 8787,
    timeoutMs: 120000,
    maxReplayableRequestBodyBytes: 16 * 1024 * 1024,
    failureThreshold: 3,
    smartSwitching: false,
    priorityMode: 'priority',
    samePriorityStrategy: 'round-robin'
  },
  proxyStatus = {
    running: false,
    port: null,
    error: null
  },
  siteSync = {
    intervalValue: 30,
    intervalUnit: 'minute',
    intelligentScheduling: true
  },
  groupSync = {
    intervalValue: 30,
    intervalUnit: 'minute',
    websites: []
  },
  modelMapping = {
    enabled: false,
    mappings: []
  },
  appSettings = {
    floatingWindow: {
      alwaysOnTop: false
    }
  },
  importPreviewResult = {
    canceled: false,
    importId: 'test-import',
    preview: {
      hasGlobalSettings: true,
      sites: [
        {
          sourceId: 'import-a',
          name: 'Imported A',
          baseUrl: 'https://import-a.example/v1',
          manualEnabled: true,
          priority: 100,
          multiplier: 1
        },
        {
          sourceId: 'import-b',
          name: 'Imported B',
          baseUrl: 'https://import-b.example/v1',
          manualEnabled: true,
          priority: 20,
          multiplier: 0.5
        }
      ]
    }
  },
  copyTextError = null
} = {}) {
  const elements = new Map();
  const windowListeners = new Map();
  const proxyUpdates = [];
  const siteSyncUpdates = [];
  const groupSyncUpdates = [];
  const modelMappingUpdates = [];
  const appSettingsUpdates = [];
  const appState = {
    configPath: 'test-config.json',
    appSettings,
    proxy,
    modelMapping,
    siteSync,
    groupSync,
    proxyStatus,
    activeSiteId,
    sites
  };
  const siteTestCalls = [];
  const capabilityDetectionCalls = [];
  const siteSyncCalls = [];
  const siteCreateKeyCalls = [];
  const refreshAllSiteSyncCalls = [];
  const siteAdds = [];
  const siteUpdates = [];
  const setActiveSiteCalls = [];
  const siteEnabledUpdates = [];
  const smartSwitchCalls = [];
  const copyTextCalls = [];
  const configExportCalls = [];
  const configImportPreviewCalls = [];
  const configImportCalls = [];
  const runtimeLogCalls = [];
  const confirmMessages = [];
  const stateChangedListeners = [];
  const siteChangedListeners = [];

  globalThis.window = {
    innerWidth: 900,
    innerHeight: 700,
    openApiProxy: {
      async getState() {
        return appState;
      },
      async addSite(input) {
        siteAdds.push(input);
        const id = `site-${appState.sites.length + 1}`;
        appState.sites = [
          ...appState.sites,
          {
            id,
            ...input,
            enabled: input.manualEnabled ?? input.enabled ?? true,
            errorLog: []
          }
        ];
        appState.activeSiteId ??= id;
        return appState;
      },
      async updateSite(id, patch) {
        siteUpdates.push({ id, patch });
        appState.sites = appState.sites.map((site) =>
          site.id === id
            ? {
                ...site,
                ...patch,
                enabled: patch.manualEnabled ?? patch.enabled ?? site.enabled
              }
            : site
        );
        return appState;
      },
      async setActiveSite(id) {
        setActiveSiteCalls.push(id);
        appState.activeSiteId = id;
        return appState;
      },
      async updateProxy(patch) {
        proxyUpdates.push(patch);
        appState.proxy = {
          ...appState.proxy,
          ...patch
        };
        return appState;
      },
      async updateSiteSyncSettings(patch) {
        siteSyncUpdates.push(patch);
        appState.siteSync = {
          ...appState.siteSync,
          ...patch
        };
        return appState;
      },
      async updateGroupSyncSettings(patch) {
        groupSyncUpdates.push(patch);
        appState.groupSync = {
          ...appState.groupSync,
          ...patch
        };
        return appState;
      },
      async updateModelMapping(patch) {
        modelMappingUpdates.push(patch);
        appState.modelMapping = {
          ...appState.modelMapping,
          ...patch
        };
        return appState;
      },
      async updateAppSettings(patch) {
        appSettingsUpdates.push(patch);
        appState.appSettings = {
          ...appState.appSettings,
          ...patch,
          floatingWindow: {
            ...appState.appSettings.floatingWindow,
            ...(patch?.floatingWindow ?? {})
          }
        };
        return appState;
      },
      async setSiteEnabled(id, enabled) {
        siteEnabledUpdates.push({ id, enabled });
        appState.sites = appState.sites.map((site) =>
          site.id === id
            ? {
                ...site,
                manualEnabled: enabled,
                failureDisabled: false,
                enabled
              }
            : site
        );
        return appState;
      },
      async testSite(id) {
        siteTestCalls.push(id);
        appState.sites = appState.sites.map((site) =>
          site.id === id
            ? {
                ...site,
                status: 'success',
                requestCount: (site.requestCount ?? 0) + 1,
                successCount: (site.successCount ?? 0) + 1,
                lastRequestAt: '2026-06-10T08:00:00.000Z',
                lastSuccessAt: '2026-06-10T08:00:00.000Z',
                lastSuccess: {
                  at: '2026-06-10T08:00:00.000Z',
                  statusCode: 200,
                  message: 'ok'
                }
              }
            : site
        );
        return {
          ...appState,
          testResult: {
            ok: true,
            statusCode: 200,
            message: 'ok'
          }
        };
      },
      async detectSiteCapabilities(id) {
        capabilityDetectionCalls.push(id);
        appState.sites = appState.sites.map((site) =>
          site.id === id
            ? {
                ...site,
                capabilities: {
                  models: ['dall-e-3', 'gpt-5-mini'],
                  features: {
                    textGeneration: true,
                    imageGeneration: true,
                    embeddings: false,
                    audioTranscription: false,
                    audioSpeech: false,
                    vision: true,
                    reasoning: false,
                    toolCalling: true,
                    moderation: false,
                    rerank: false
                  },
                  featureModels: {
                    textGeneration: ['gpt-5-mini'],
                    imageGeneration: ['dall-e-3'],
                    embeddings: [],
                    audioTranscription: [],
                    audioSpeech: [],
                    vision: ['gpt-5-mini'],
                    reasoning: [],
                    toolCalling: ['gpt-5-mini'],
                    moderation: [],
                    rerank: []
                  },
                  checkedAt: '2026-06-10T08:00:00.000Z',
                  lastStatus: 'success',
                  lastError: null,
                  source: '/v1/models'
                }
              }
            : site
        );
        return {
          ...appState,
          capabilityResult: {
            ok: true,
            statusCode: 200,
            message: 'Discovered 2 models',
            durationMs: 12,
            modelCount: 2,
            error: null
          }
        };
      },
      async syncSite(id) {
        siteSyncCalls.push(id);
        appState.sites = appState.sites.map((site) =>
          site.id === id
            ? {
                ...site,
                multiplier: 0.003,
                sync: {
                  ...site.sync,
                  lastSyncAt: '2026-06-09T08:00:00.000Z',
                  lastSyncStatus: 'success',
                  lastSyncError: null,
                remote: {
                  providerType: 'new-api',
                  authType: 'Bearer token (/api)',
                  accountName: site.sync?.username ?? '',
                  balance: '$0.00',
                  apiEndpoint: '',
                  keyName: 'qa',
                  keyGroup: 'AAA.限时白嫖GPT 0.003x',
                  groupMultiplier: 0.003,
                  groups: [
                    {
                      id: 'aaa',
                      name: 'AAA.限时白嫖GPT 0.003x',
                      multiplier: 0.003,
                      selected: true
                    },
                    {
                      id: 'plus',
                      name: 'GPT Plus 0.045x',
                      multiplier: 0.045,
                      selected: false
                    }
                  ]
                }
              }
            }
            : site
        );
        return {
          ...appState,
          syncResult: {
            ok: true,
            multiplier: 0.003
          }
        };
      },
      async createSiteKey(id) {
        siteCreateKeyCalls.push(id);
        appState.sites = appState.sites.map((site) =>
          site.id === id
            ? {
                ...site,
                apiKey: 'sk-created',
                multiplier: 0.001,
                sync: {
                  ...site.sync,
                  lastSyncAt: '2026-06-09T08:00:00.000Z',
                  lastSyncStatus: 'success',
                  lastSyncError: null,
                  remote: {
                    ...site.sync?.remote,
                    providerType: site.sync?.providerType ?? 'modern-v1',
                    keyName: site.name,
                    remoteKeyId: '37',
                    keyGroup: 'Example Team',
                    groupId: '18',
                    groupMultiplier: 0.001
                  }
                }
              }
            : site
        );
        return {
          ...appState,
          createKeyResult: {
            ok: true,
            multiplier: 0.001,
            keyName: 'site'
          }
        };
      },
      async smartSwitchSite() {
        smartSwitchCalls.push(true);
        const chosen = appState.sites.find((site) =>
          (site.manualEnabled ?? site.enabled ?? true) &&
            !site.failureDisabled &&
            site.enabled !== false
        );
        appState.activeSiteId = chosen?.id ?? null;
        return appState;
      },
      async switchSiteGroup(id, group) {
        const groupName = typeof group === 'object' ? group.groupName : group;
        const groupId = typeof group === 'object' ? group.groupId : '';
        siteUpdates.push({
          id,
          switchGroupName: groupName,
          ...(groupId ? { switchGroupId: groupId } : {})
        });
        appState.sites = appState.sites.map((site) => {
          if (site.id !== id) {
            return site;
          }
          const groups = site.sync?.remote?.groups ?? [];
          const selectedGroup = groups.find((candidate) =>
            (groupId && candidate.id === groupId) ||
            candidate.name === groupName
          );
          return {
            ...site,
            multiplier: selectedGroup?.multiplier ?? site.multiplier,
            sync: {
              ...site.sync,
              remote: {
                ...site.sync?.remote,
                keyGroup: selectedGroup?.name ?? site.sync?.remote?.keyGroup ?? '',
                groupId: selectedGroup?.id ?? site.sync?.remote?.groupId ?? '',
                groupMultiplier: selectedGroup?.multiplier ?? site.sync?.remote?.groupMultiplier ?? null,
                groups: groups.map((group) => ({
                  ...group,
                  selected: (groupId && group.id === groupId) || group.name === groupName
                }))
              }
            }
          };
        });
        return appState;
      },
      async refreshAllSiteSync() {
        refreshAllSiteSyncCalls.push(true);
        return {
          ...appState,
          refreshResult: {
            checkedCount: appState.sites.length,
            syncedCount: appState.sites.length,
            failedCount: 0,
            checkedWebsiteCount: appState.groupSync.websites.length || appState.sites.length,
            syncedWebsiteCount: appState.groupSync.websites.length || appState.sites.length,
            failedWebsiteCount: 0
          }
        };
      },
      async exportConfig(options) {
        configExportCalls.push(options);
        return {
          canceled: false,
          filePath: 'JuanProxy-config.json',
          exportedSiteCount: options?.siteIds?.length ?? appState.sites.length,
          exportedGlobalSettings: options?.includeGlobalSettings !== false
        };
      },
      async previewImportConfig() {
        configImportPreviewCalls.push(true);
        return importPreviewResult;
      },
      async importConfig(options) {
        configImportCalls.push(options);
        const selectedIds = options?.siteIds ?? importPreviewResult.preview?.sites?.map((site) => site.sourceId) ?? [];
        appState.sites = [
          ...appState.sites,
          ...selectedIds.map((sourceId, index) => ({
            id: `imported-${index + 1}`,
            name: `Imported ${sourceId}`,
            baseUrl: `https://${sourceId}.example/v1`,
            apiKey: 'example-imported-key',
            manualEnabled: true,
            failureDisabled: false,
            enabled: true,
            status: 'idle',
            priority: 100,
            multiplier: 1,
            requestCount: 0,
            successCount: 0,
            errorCount: 0,
            consecutiveErrors: 0,
            errorLog: []
          }))
        ];
        return {
          ...appState,
          importResult: {
            importedSiteCount: selectedIds.length,
            importedGlobalSettings: Boolean(options?.includeGlobalSettings),
            importedSiteIds: selectedIds,
            importedSiteNames: selectedIds
          }
        };
      },
      async copyText(text) {
        copyTextCalls.push(text);
        if (copyTextError) {
          throw copyTextError;
        }
      },
      async logRuntimeError(input) {
        runtimeLogCalls.push(input);
        return { ok: true, filePath: 'test-runtime-errors.jsonl' };
      },
      onStateChanged(callback) {
        stateChangedListeners.push(callback);
        return () => {};
      },
      onSiteChanged(callback) {
        siteChangedListeners.push(callback);
        return () => {};
      }
    },
    addEventListener(type, listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((candidate) => candidate !== listener)
      );
    },
    dispatchEvent(event) {
      for (const listener of windowListeners.get(event.type) ?? []) {
        listener(event);
      }
    }
  };
  globalThis.document = {
    activeElement: null,
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, createElementStub(tagNameForSelector(selector)));
      }
      return elements.get(selector);
    },
    createElement(tagName) {
      return createElementStub(tagName);
    }
  };
  globalThis.confirm = (message) => {
    confirmMessages.push(message);
    return true;
  };
  globalThis.setInterval = () => 1;

  rendererImportCounter += 1;
  const module = await import(`../src/renderer/app.js?request-time-rendering=${rendererImportCounter}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    module,
    elements,
    proxyUpdates,
    siteSyncUpdates,
    groupSyncUpdates,
    modelMappingUpdates,
    appSettingsUpdates,
    siteTestCalls,
    capabilityDetectionCalls,
    siteSyncCalls,
    siteCreateKeyCalls,
    refreshAllSiteSyncCalls,
    siteAdds,
    siteUpdates,
    setActiveSiteCalls,
    siteEnabledUpdates,
    smartSwitchCalls,
    copyTextCalls,
    configExportCalls,
    configImportPreviewCalls,
    configImportCalls,
    runtimeLogCalls,
    confirmMessages,
    setConfirmHandler(handler) {
      globalThis.confirm = (message) => {
        confirmMessages.push(message);
        return handler(message);
      };
    },
    windowListeners,
    dispatchStateChanged(nextState) {
      Object.assign(appState, nextState);
      for (const listener of stateChangedListeners) {
        listener(appState);
      }
    },
    dispatchSiteChanged(patch) {
      appState.sites = appState.sites.map((site) =>
        site.id === patch.site.id ? patch.site : site
      );
      appState.activeSiteId = patch.activeSiteId ?? appState.activeSiteId;
      for (const listener of siteChangedListeners) {
        listener(patch);
      }
    }
  };
}

async function importRendererApp() {
  return (await setupRendererApp()).module;
}

function formatExpectedLocalDateTime(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + ` ${[
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':')}`;
}

function getMappingRowField(row, field) {
  return row.children.find((child) => child.dataset?.field === field);
}

test('renderer preserves a focused site editor when background state updates arrive', async () => {
  const site = {
    id: 'site-1',
    name: 'Saved Site',
    baseUrl: 'https://site.example/v1',
    apiKey: 'sk-site',
    manualEnabled: true,
    failureDisabled: false,
    enabled: true,
    status: 'idle',
    priority: 20,
    multiplier: 1,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    errorLog: []
  };
  const { elements, dispatchStateChanged } = await setupRendererApp({
    activeSiteId: site.id,
    sites: [site]
  });

  const nameInput = elements.get('#site-name');
  nameInput.focus();
  nameInput.value = 'Draft Site Name';

  dispatchStateChanged({
    activeSiteId: site.id,
    sites: [
      {
        ...site,
        requestCount: 1,
        lastRequestAt: '2026-06-03T08:00:00.000Z'
      }
    ]
  });

  assert.equal(nameInput.value, 'Draft Site Name');
});

test('renderer preserves focused proxy settings while still updating proxy status', async () => {
  const { elements, dispatchStateChanged } = await setupRendererApp();
  const portInput = elements.get('#proxy-port');

  portInput.focus();
  portInput.value = '9999';

  dispatchStateChanged({
    proxy: {
      port: 8788,
      timeoutMs: 120000,
      failureThreshold: 3,
      smartSwitching: false,
      priorityMode: 'priority',
      samePriorityStrategy: 'round-robin'
    },
    proxyStatus: {
      running: true,
      port: 8788,
      error: null
    }
  });

  assert.equal(portInput.value, '9999');
  assert.equal(elements.get('#proxy-url').textContent, 'http://127.0.0.1:8788/v1');
});

test('formats last request time as relative elapsed text', async () => {
  const { formatLastRequestText } = await importRendererApp();

  assert.equal(typeof formatLastRequestText, 'function');
  assert.equal(
    formatLastRequestText('2026-06-03T08:00:00.000Z', new Date('2026-06-03T08:01:20.000Z')),
    '1分钟之前'
  );
  assert.equal(
    formatLastRequestText('2026-06-03T06:01:20.000Z', new Date('2026-06-03T08:01:20.000Z')),
    '2小时之前'
  );
  assert.equal(
    formatLastRequestText('2026-05-31T08:01:20.000Z', new Date('2026-06-03T08:01:20.000Z')),
    '3天之前'
  );
  assert.equal(formatLastRequestText(null, new Date('2026-06-03T08:01:20.000Z')), '尚无请求');
  assert.equal(formatLastRequestText('not-a-date', new Date('2026-06-03T08:01:20.000Z')), '尚无请求');
});

test('formats disabled-site auto recovery summary text', async () => {
  const { formatAutoRecoverySummary } = await importRendererApp();

  assert.equal(typeof formatAutoRecoverySummary, 'function');
  assert.equal(
    formatAutoRecoverySummary({ autoRecovery: { enabled: false } }),
    '错误停用后自检关闭'
  );
  assert.equal(
    formatAutoRecoverySummary({
      manualEnabled: false,
      enabled: false,
      autoRecovery: {
        enabled: true,
        intervalValue: 2,
        intervalUnit: 'hour'
      },
      autoRecoveryState: {
        nextCheckAt: null
      }
    }),
    '人工停用不自检'
  );
  assert.equal(
    formatAutoRecoverySummary({
      manualEnabled: true,
      failureDisabled: true,
      enabled: false,
      autoRecovery: {
        enabled: true,
        intervalValue: 2,
        intervalUnit: 'hour'
      },
      autoRecoveryState: {
        nextCheckAt: '2026-06-03T10:00:00.000Z'
      }
    }),
    `错误停用后每2小时自检 · 下次 ${formatExpectedLocalDateTime('2026-06-03T10:00:00.000Z')}`
  );
});

test('formats rate-limit pause time using local date time text', async () => {
  const { formatRateLimitSummary } = await importRendererApp();

  assert.equal(typeof formatRateLimitSummary, 'function');
  assert.equal(
    formatRateLimitSummary({
      rateLimit: {
        enabled: true,
        limit: 10,
        windowValue: 1,
        windowUnit: 'minute'
      },
      rateLimitState: {
        pausedUntil: '2026-06-03T08:05:06.000Z',
        used: 10
      }
    }),
    `限速 10 次/1分钟 · 已暂停到 ${formatExpectedLocalDateTime('2026-06-03T08:05:06.000Z')}`
  );
});

test('formats availability labels from manual, failure and rate-limit states', async () => {
  const { formatAvailabilityLabel, getAvailabilityState } = await importRendererApp();
  const now = new Date('2026-06-03T08:00:00.000Z');

  assert.equal(typeof formatAvailabilityLabel, 'function');
  assert.equal(
    getAvailabilityState({ manualEnabled: false, enabled: false }, now),
    'manual-disabled'
  );
  assert.equal(formatAvailabilityLabel({ manualEnabled: false, enabled: false }, now), '人工停用');
  assert.equal(
    formatAvailabilityLabel({ manualEnabled: true, failureDisabled: true, enabled: false }, now),
    '错误停用'
  );
  assert.equal(
    formatAvailabilityLabel({
      manualEnabled: true,
      failureDisabled: false,
      enabled: true,
      rateLimit: { enabled: true },
      rateLimitState: { pausedUntil: '2026-06-03T08:01:00.000Z' }
    }, now),
    '限速暂停'
  );
  assert.equal(
    formatAvailabilityLabel({ manualEnabled: true, failureDisabled: false, enabled: true }, now),
    '启用中'
  );
});

test('filters sites by availability status', async () => {
  const { filterSitesByAvailability } = await importRendererApp();
  const now = new Date('2026-06-03T08:00:00.000Z');
  const sites = [
    { id: 'enabled', manualEnabled: true, failureDisabled: false, enabled: true },
    { id: 'manual', manualEnabled: false, failureDisabled: false, enabled: false },
    { id: 'failure', manualEnabled: true, failureDisabled: true, enabled: false },
    {
      id: 'limited',
      manualEnabled: true,
      failureDisabled: false,
      enabled: true,
      rateLimit: { enabled: true },
      rateLimitState: { pausedUntil: '2026-06-03T08:01:00.000Z' }
    }
  ];

  assert.deepEqual(filterSitesByAvailability(sites, 'all', now).map((site) => site.id), [
    'enabled',
    'manual',
    'failure',
    'limited'
  ]);
  assert.deepEqual(filterSitesByAvailability(sites, 'enabled', now).map((site) => site.id), [
    'enabled'
  ]);
  assert.deepEqual(filterSitesByAvailability(sites, 'unavailable', now).map((site) => site.id), [
    'manual',
    'failure',
    'limited'
  ]);
  assert.deepEqual(filterSitesByAvailability(sites, 'manual-disabled', now).map((site) => site.id), [
    'manual'
  ]);
  assert.deepEqual(filterSitesByAvailability(sites, 'failure-disabled', now).map((site) => site.id), [
    'failure'
  ]);
  assert.deepEqual(filterSitesByAvailability(sites, 'rate-limited', now).map((site) => site.id), [
    'limited'
  ]);
});

test('formats site toggle action separately from availability status labels', async () => {
  const { getSiteToggleAction } = await importRendererApp();
  const now = new Date('2026-06-03T08:00:00.000Z');

  assert.equal(typeof getSiteToggleAction, 'function');
  assert.deepEqual(
    getSiteToggleAction({ manualEnabled: true, failureDisabled: false, enabled: true }, now),
    { label: '停用', nextManualEnabled: false }
  );
  assert.deepEqual(
    getSiteToggleAction({ manualEnabled: false, enabled: false }, now),
    { label: '启用', nextManualEnabled: true }
  );
  assert.deepEqual(
    getSiteToggleAction({ manualEnabled: true, failureDisabled: true, enabled: false }, now),
    { label: '启用', nextManualEnabled: true }
  );
  assert.deepEqual(
    getSiteToggleAction({
      manualEnabled: true,
      failureDisabled: false,
      enabled: true,
      rateLimit: { enabled: true },
      rateLimitState: { pausedUntil: '2026-06-03T08:01:00.000Z' }
    }, now),
    { label: '启用', nextManualEnabled: true }
  );
});

test('builds request dashboard totals and success rate by period', async () => {
  const { buildRequestDashboard, formatSuccessRate } = await importRendererApp();

  const dashboard = buildRequestDashboard([
    {
      requestStats: {
        day: [
          {
            key: '2026-06-03',
            startedAt: '2026-06-03T00:00:00.000Z',
            requestCount: 4,
            successCount: 3,
            errorCount: 1
          }
        ]
      }
    },
    {
      requestStats: {
        day: [
          {
            key: '2026-06-03',
            startedAt: '2026-06-03T00:00:00.000Z',
            requestCount: 2,
            successCount: 1,
            errorCount: 1
          },
          {
            key: '2026-06-04',
            startedAt: '2026-06-04T00:00:00.000Z',
            requestCount: 1,
            successCount: 0,
            errorCount: 1
          }
        ]
      }
    }
  ], 'day');

  assert.equal(dashboard.summary.requestCount, 7);
  assert.equal(dashboard.summary.successCount, 4);
  assert.equal(dashboard.summary.errorCount, 3);
  assert.equal(formatSuccessRate(dashboard.summary.successRate), '57.1%');
  assert.deepEqual(
    dashboard.buckets.map((bucket) => ({
      key: bucket.key,
      requestCount: bucket.requestCount,
      successCount: bucket.successCount,
      errorCount: bucket.errorCount,
      successRate: bucket.successRate
    })),
    [
      {
        key: '2026-06-03',
        requestCount: 6,
        successCount: 4,
        errorCount: 2,
        successRate: 4 / 6
      },
      {
        key: '2026-06-04',
        requestCount: 1,
        successCount: 0,
        errorCount: 1,
        successRate: 0
      }
    ]
  );
});

test('renderer renders request dashboard as a time-bucket column chart', async () => {
  const { elements } = await setupRendererApp({
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        enabled: true,
        requestStats: {
          hour: [
            {
              key: '2026-06-03T08',
              startedAt: '2026-06-03T08:00:00.000Z',
              successCount: 3,
              errorCount: 1
            },
            {
              key: '2026-06-03T09',
              startedAt: '2026-06-03T09:00:00.000Z',
              successCount: 1,
              errorCount: 2
            }
          ]
        },
        errorLog: []
      }
    ]
  });

  const html = elements.get('#dashboard-buckets').innerHTML;

  assert.match(html, /dashboard-chart/);
  assert.match(html, /dashboard-column/);
  assert.match(html, /dashboard-column-success/);
  assert.match(html, /dashboard-column-error/);
  assert.doesNotMatch(html, /dashboard-row/);
});

test('renderer renders request dashboard for the selected site only', async () => {
  const { elements } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site 1',
        baseUrl: 'https://site-1.example/v1',
        apiKey: 'sk-site-1',
        manualEnabled: true,
        enabled: true,
        requestStats: {
          hour: [
            {
              key: '2026-06-03T08',
              startedAt: '2026-06-03T08:00:00.000Z',
              successCount: 2,
              errorCount: 1
            }
          ]
        },
        errorLog: []
      },
      {
        id: 'site-2',
        name: 'site 2',
        baseUrl: 'https://site-2.example/v1',
        apiKey: 'sk-site-2',
        manualEnabled: true,
        enabled: true,
        requestStats: {
          hour: [
            {
              key: '2026-06-03T08',
              startedAt: '2026-06-03T08:00:00.000Z',
              successCount: 100,
              errorCount: 0
            }
          ]
        },
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#dashboard-requests').textContent, '3');
  assert.equal(elements.get('#dashboard-success').textContent, '2');
  assert.equal(elements.get('#dashboard-errors').textContent, '1');

  const secondSiteMain = elements.get('#site-list').children[1].children[0];
  await secondSiteMain.dispatchEvent('click');

  assert.equal(elements.get('#dashboard-requests').textContent, '100');
  assert.equal(elements.get('#dashboard-success').textContent, '100');
  assert.equal(elements.get('#dashboard-errors').textContent, '0');

  await elements.get('#new-site').dispatchEvent('click');

  assert.equal(elements.get('#site-test-model').value, 'example-chat-model');
  assert.equal(elements.get('#dashboard-requests').textContent, '0');
  assert.equal(elements.get('#dashboard-success').textContent, '0');
  assert.equal(elements.get('#dashboard-errors').textContent, '0');
});

test('renderer filters the site list by selected availability status', async () => {
  const { elements } = await setupRendererApp({
    sites: [
      {
        id: 'enabled',
        name: 'enabled',
        baseUrl: 'https://enabled.example/v1',
        apiKey: 'sk-enabled',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'manual',
        name: 'manual',
        baseUrl: 'https://manual.example/v1',
        apiKey: 'sk-manual',
        manualEnabled: false,
        failureDisabled: false,
        enabled: false,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'failure',
        name: 'failure',
        baseUrl: 'https://failure.example/v1',
        apiKey: 'sk-failure',
        manualEnabled: true,
        failureDisabled: true,
        enabled: false,
        status: 'error',
        requestCount: 0,
        successCount: 0,
        errorCount: 1,
        consecutiveErrors: 1,
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#site-list').children.length, 3);

  elements.get('#site-status-filter').value = 'manual-disabled';
  await elements.get('#site-status-filter').dispatchEvent('change');

  assert.equal(elements.get('#site-list').children.length, 1);
  assert.equal(elements.get('#site-list').children[0].dataset.id, 'manual');
  assert.match(elements.get('#site-list-summary').textContent, /1\/3 个配置 · 人工停用/);
});

test('renderer sorts the site list by request count, success rate, balance and multiplier', async () => {
  const { elements } = await setupRendererApp({
    sites: [
      {
        id: 'requests',
        name: 'requests',
        baseUrl: 'https://requests.example/v1',
        apiKey: 'sk-requests',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'success',
        multiplier: 0.2,
        sync: {
          remote: {
            balance: '$1.00'
          }
        },
        requestCount: 10,
        successCount: 8,
        errorCount: 2,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'balance',
        name: 'balance',
        baseUrl: 'https://balance.example/v1',
        apiKey: 'sk-balance',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'success',
        multiplier: 0.5,
        sync: {
          remote: {
            balance: '$9.50'
          }
        },
        requestCount: 2,
        successCount: 2,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'multiplier',
        name: 'multiplier',
        baseUrl: 'https://multiplier.example/v1',
        apiKey: 'sk-multiplier',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        multiplier: 0.001,
        sync: {
          remote: {
            balance: '$0.20'
          }
        },
        requestCount: 1,
        successCount: 0,
        errorCount: 1,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  const listIds = () =>
    elements.get('#site-list').children.map((child) => child.dataset.id);

  elements.get('#site-sort').value = 'requests';
  await elements.get('#site-sort').dispatchEvent('change');
  assert.deepEqual(listIds(), ['requests', 'balance', 'multiplier']);

  elements.get('#site-sort').value = 'success-rate';
  await elements.get('#site-sort').dispatchEvent('change');
  assert.deepEqual(listIds(), ['balance', 'requests', 'multiplier']);

  elements.get('#site-sort').value = 'balance';
  await elements.get('#site-sort').dispatchEvent('change');
  assert.deepEqual(listIds(), ['balance', 'requests', 'multiplier']);

  elements.get('#site-sort').value = 'multiplier';
  await elements.get('#site-sort').dispatchEvent('change');
  assert.deepEqual(listIds(), ['multiplier', 'requests', 'balance']);
});

test('renderer filters the site list by a synced topbar group and can clear the filter', async () => {
  const { elements } = await setupRendererApp({
    sites: [
      {
        id: 'site-a',
        name: 'ExampleRelay',
        baseUrl: 'https://example-relay.example.com/v1',
        apiKey: 'sk-a',
        manualEnabled: true,
        enabled: true,
        sync: {
          dashboardUrl: 'https://sync.example.com/keys',
          lastSyncAt: '2026-06-09T08:00:00.000Z',
          remote: {
            apiEndpoint: 'https://example-relay-api.example.com',
            balance: '$1.44',
            keyName: 'n',
            keyGroup: 'Example Team',
            groupMultiplier: 0.001,
            groups: [
              { id: 'example-team', name: 'Example Team', multiplier: 0.001, selected: true },
              { id: 'plus', name: 'GPT Plus', multiplier: 0.045, selected: false }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        errorLog: []
      },
      {
        id: 'site-a-alt',
        name: 'ExampleRelay backup',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'sk-a-alt',
        manualEnabled: true,
        enabled: true,
        sync: {
          dashboardUrl: 'https://sync.example.com/profile',
          remote: {
            apiEndpoint: 'https://example-relay-api.example.com',
            keyGroup: 'Example Team',
            groupMultiplier: 0.002,
            groups: [
              { id: 'example-team', name: 'Example Team', multiplier: 0.002, selected: true }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        errorLog: []
      },
      {
        id: 'site-b',
        name: 'NCC',
        baseUrl: 'https://relay-b.example.com/v1',
        apiKey: 'sk-b',
        manualEnabled: true,
        enabled: true,
        sync: {
          remote: {
            keyGroup: 'AAA',
            groupMultiplier: 0.003,
            groups: [
              { id: 'aaa', name: 'AAA', multiplier: 0.003, selected: true }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        errorLog: []
      }
    ]
  });

  const listIds = () => elements.get('#site-list').children.map((child) => child.dataset.id);
  assert.deepEqual(listIds(), ['site-a', 'site-a-alt', 'site-b']);

  const groupBar = elements.get('#topbar-sync-groups');
  assert.equal(groupBar.children.length, 2);
  assert.equal(elements.get('#toggle-topbar-sync-groups').hidden, true);
  assert.equal(groupBar.children[0].dataset.siteId, 'site-a');
  assert.equal(groupBar.children[0].dataset.filterKey, 'https://sync.example.com');
  assert.match(groupBar.children[0].textContent, /Example Team/);
  assert.doesNotMatch(groupBar.children[0].textContent, /0\.001x.*0\.001x/);
  assert.match(groupBar.children[0].title, /ExampleRelay/);

  await groupBar.children[0].dispatchEvent('click');

  assert.deepEqual(listIds(), ['site-a', 'site-a-alt']);
  assert.match(elements.get('#site-list-summary').textContent, /站点筛选 ExampleRelay/);
  assert.equal(elements.get('#clear-site-group-filter').hidden, false);

  await elements.get('#clear-site-group-filter').dispatchEvent('click');

  assert.deepEqual(listIds(), ['site-a', 'site-a-alt', 'site-b']);
  assert.equal(elements.get('#clear-site-group-filter').hidden, true);
});

test('renderer ranks low multiplier groups after deduplicating by dashboard website', async () => {
  const { elements } = await setupRendererApp({
    sites: [
      {
        id: 'site-a',
        name: 'ExampleRelay primary',
        baseUrl: 'https://primary.example/v1',
        apiKey: 'sk-a',
        manualEnabled: true,
        enabled: true,
        sync: {
          dashboardUrl: 'https://sync.example.com/keys',
          remote: {
            apiEndpoint: 'https://api-a.example.com',
            keyGroup: 'Cloud standard',
            groupMultiplier: 0.01,
            groups: [
              { id: 'standard', name: 'Cloud standard', multiplier: 0.01, selected: true }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        errorLog: []
      },
      {
        id: 'site-a-alt',
        name: 'ExampleRelay backup',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'sk-a-alt',
        manualEnabled: true,
        enabled: true,
        sync: {
          dashboardUrl: 'https://sync.example.com/profile',
          remote: {
            apiEndpoint: 'https://api-b.example.com',
            keyGroup: 'Cloud low',
            groupMultiplier: 0.001,
            groups: [
              { id: 'low', name: 'Cloud low', multiplier: 0.001, selected: true }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        errorLog: []
      },
      {
        id: 'site-b',
        name: 'OtherRelay',
        baseUrl: 'https://other.example/v1',
        apiKey: 'sk-b',
        manualEnabled: true,
        enabled: true,
        sync: {
          dashboardUrl: 'https://other-sync.example.com/console/token',
          remote: {
            apiEndpoint: 'https://other-api.example.com',
            keyGroup: 'Other low',
            groupMultiplier: 0.002,
            groups: [
              { id: 'other-low', name: 'Other low', multiplier: 0.002, selected: true }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        errorLog: []
      }
    ]
  });

  const listIds = () => elements.get('#site-list').children.map((child) => child.dataset.id);
  const groupBar = elements.get('#topbar-sync-groups');

  assert.equal(groupBar.children.length, 2);
  assert.equal(groupBar.children[0].dataset.siteId, 'site-a-alt');
  assert.equal(groupBar.children[0].dataset.filterKey, 'https://sync.example.com');
  assert.match(groupBar.children[0].textContent, /Cloud low/);

  await groupBar.children[0].dispatchEvent('click');

  assert.deepEqual(listIds(), ['site-a', 'site-a-alt']);
});

test('renderer can expand the topbar low multiplier groups beyond the first three', async () => {
  const { elements } = await setupRendererApp({
    sites: Array.from({ length: 5 }, (_, index) => ({
      id: `site-${index + 1}`,
      name: `site ${index + 1}`,
      baseUrl: `https://site-${index + 1}.example/v1`,
      apiKey: `sk-${index + 1}`,
      manualEnabled: true,
      enabled: true,
      sync: {
        dashboardUrl: `https://dashboard-${index + 1}.example/keys`,
        remote: {
          apiEndpoint: `https://api-${index + 1}.example`,
          keyGroup: `long group name ${index + 1}`,
          groupMultiplier: 0.001 + index / 1000,
          groups: [
            {
              id: `group-${index + 1}`,
              name: `long group name ${index + 1}`,
              multiplier: 0.001 + index / 1000,
              selected: true
            }
          ]
        }
      },
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      errorLog: []
    }))
  });

  const groupBar = elements.get('#topbar-sync-groups');
  const toggle = elements.get('#toggle-topbar-sync-groups');

  assert.equal(groupBar.children.length, 3);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent, '展开 5 个');
  assert.doesNotMatch(groupBar.className, /expanded/);

  await toggle.dispatchEvent('click');

  assert.equal(groupBar.children.length, 5);
  assert.equal(toggle.textContent, '收起 5 个');
  assert.match(groupBar.className, /expanded/);

  await toggle.dispatchEvent('click');

  assert.equal(groupBar.children.length, 3);
  assert.equal(toggle.textContent, '展开 5 个');
  assert.doesNotMatch(groupBar.className, /expanded/);
});

test('renderer refreshes configured sync websites from the topbar', async () => {
  const { elements, refreshAllSiteSyncCalls } = await setupRendererApp({
    sites: [
      {
        id: 'site-a',
        name: 'ExampleRelay',
        baseUrl: 'https://example-relay.example.com/v1',
        apiKey: 'sk-a',
        manualEnabled: true,
        enabled: true,
        sync: {
          enabled: true,
          dashboardUrl: 'https://sync.example.com/keys',
          username: 'user@example.com',
          password: 'secret',
          remote: {
            groups: [
              { id: 'example-team', name: 'Example Team', multiplier: 0.001, selected: true }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        errorLog: []
      }
    ]
  });

  await elements.get('#refresh-site-sync-all').dispatchEvent('click');

  assert.deepEqual(refreshAllSiteSyncCalls, [true]);
  assert.match(elements.get('#toast').textContent, /网站成功 1，失败 0/);
});

test('renderer renders the active site in the top navigation bar', async () => {
  const { elements } = await setupRendererApp({
    activeSiteId: 'site-2',
    sites: [
      {
        id: 'site-1',
        name: 'selected site',
        baseUrl: 'https://selected.example/v1',
        apiKey: 'sk-selected',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 1,
        successCount: 1,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'site-2',
        name: 'active site',
        baseUrl: 'https://active.example/v1',
        apiKey: 'sk-active',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'success',
        priority: 20,
        multiplier: 0.00001,
        sync: {
          lastSyncStatus: 'success',
          lastSyncAt: '2026-06-03T08:01:00.000Z',
          remote: {
            balance: '$1.07',
            keyGroup: 'pro-group'
          }
        },
        rateLimit: {
          enabled: true,
          limit: 60,
          windowValue: 1,
          windowUnit: 'minute'
        },
        rateLimitState: {
          used: 7
        },
        autoRecoveryState: {
          nextCheckAt: '2026-06-03T08:30:00.000Z'
        },
        requestCount: 4,
        successCount: 3,
        errorCount: 1,
        consecutiveErrors: 0,
        lastRequestAt: '2026-06-03T08:00:00.000Z',
        lastError: {
          message: 'temporary upstream error'
        },
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#active-site-name').textContent, 'active site');
  assert.equal(elements.get('#active-site-status').textContent, '启用中');
  assert.equal(elements.get('#active-site-url').textContent, '');
  assert.equal(elements.get('#active-site-url').hidden, true);
  assert.match(elements.get('#active-site-meta').innerHTML, /site-balance-badge/);
  assert.match(elements.get('#active-site-meta').innerHTML, /余额 \$1\.07/);
  assert.match(elements.get('#active-site-meta').innerHTML, /site-multiplier-badge/);
  assert.match(elements.get('#active-site-meta').innerHTML, /倍率 0\.00001/);
  assert.match(elements.get('#active-site-meta').innerHTML, /优先级 20/);
  assert.match(elements.get('#active-site-meta').innerHTML, /成功率 75%/);
});

test('renderer emphasizes balance and multiplier in the site list without showing URLs', async () => {
  const { elements } = await setupRendererApp({
    activeSiteId: 'site-ok',
    sites: [
      {
        id: 'site-ok',
        name: 'ok site',
        baseUrl: 'https://ok.example/v1',
        apiKey: 'sk-ok',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'success',
        priority: 10,
        multiplier: 0.00001,
        sync: {
          lastSyncStatus: 'success',
          remote: {
            balance: '$1.07'
          }
        },
        requestCount: 4,
        successCount: 4,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'site-failed-sync',
        name: 'failed sync',
        baseUrl: 'https://failed.example/v1',
        apiKey: 'sk-failed',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 0.003,
        sync: {
          lastSyncStatus: 'failure',
          lastSyncError: 'bad password',
          remote: {
            balance: '$0.00'
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  const okHtml = elements.get('#site-list').children[0].children[0].children[0].innerHTML;
  const failedHtml = elements.get('#site-list').children[1].children[0].children[0].innerHTML;

  assert.doesNotMatch(okHtml, /https:\/\/ok\.example/);
  assert.match(okHtml, /site-balance-badge/);
  assert.match(okHtml, /余额 \$1\.07/);
  assert.match(okHtml, /site-multiplier-badge/);
  assert.match(okHtml, /倍率 0\.00001/);
  assert.doesNotMatch(okHtml, /site-url/);

  assert.match(failedHtml, /余额 \$0\.00/);
  assert.match(failedHtml, /site-multiplier-badge is-danger/);
  assert.match(failedHtml, /倍率 0\.003/);
});

test('renderer styles active-site balance and multiplier badges with color accents', async () => {
  const css = await readFile(fileURLToPath(new URL('../src/renderer/styles.css', import.meta.url)), 'utf8');

  assert.match(css, /\.active-site-meta \.site-balance-badge/);
  assert.match(css, /\.active-site-meta \.site-multiplier-badge/);
  assert.match(css, /\.active-site-meta \.site-multiplier-badge\.is-danger/);
  assert.match(css, /\.topbar-sync-groups\.expanded/);
  assert.match(css, /\.topbar-sync-group-chip/);
  assert.match(css, /\.site-sync-group-chip/);
  assert.match(css, /overflow-wrap: anywhere/);
});

test('floating window exposes a circular independent active-site surface', async () => {
  const html = await readFile(floatingHtmlPath, 'utf8');
  const css = await readFile(fileURLToPath(new URL('../src/renderer/floating.css', import.meta.url)), 'utf8');
  const js = await readFile(fileURLToPath(new URL('../src/renderer/floating.js', import.meta.url)), 'utf8');

  assert.match(html, /id="floating-handle"/);
  assert.match(html, /id="floating-always-on-top"/);
  assert.match(html, /floating\.js/);
  assert.match(css, /background: transparent/);
  assert.match(css, /\.floating-handle/);
  assert.match(css, /border-radius: 50%/);
  assert.match(css, /inset 0 1px 0/);
  assert.match(css, /\.floating-shell\.is-expanded/);
  assert.match(js, /setFloatingWindowExpanded/);
  assert.match(js, /setFloatingWindowBounds/);
  assert.match(js, /updateAppSettings/);
  assert.match(js, /return `\$\{formatMultiplier\(site\?\.multiplier\)\}x`/);
  assert.doesNotMatch(js, /return site\?\.sync\?\.remote\?\.balance \|\| `\$\{formatMultiplier/);
  assert.match(js, /pointerenter/);
  assert.match(js, /scheduleHoverExpand/);
  assert.doesNotMatch(js, /handle\.addEventListener\('click'/);
});

test('main process creates an independent always-on-top capable floating window', async () => {
  const source = await readFile(mainJsPath, 'utf8');

  assert.match(source, /let floatingWindow = null/);
  assert.match(source, /new BrowserWindow\(\{/);
  assert.match(source, /floating\.html/);
  assert.match(source, /setAlwaysOnTop/);
  assert.match(source, /floating-window:set-expanded/);
  assert.match(source, /floating-window:set-bounds/);
  assert.match(source, /getInitialFloatingWindowBounds/);
  assert.match(source, /scheduleFloatingWindowPositionSave/);
});

test('renderer exposes request dashboard controls', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="request-dashboard"/);
  assert.match(html, /id="dashboard-period-hour"/);
  assert.match(html, /id="dashboard-period-day"/);
  assert.match(html, /id="dashboard-period-week"/);
  assert.match(html, /id="dashboard-period-month"/);
  assert.match(html, /id="dashboard-success-rate"/);
});

test('renderer exposes site status filter and topbar active site panel', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="site-status-filter"/);
  assert.match(html, /id="site-sort"/);
  assert.match(html, /value="manual-disabled"/);
  assert.match(html, /value="failure-disabled"/);
  assert.match(html, /value="rate-limited"/);
  assert.match(html, /class="topbar-active-site"/);
  assert.match(html, /id="active-site-name"/);
  assert.match(html, /id="active-site-status"/);
  assert.match(html, /id="floating-always-on-top"/);
  assert.doesNotMatch(html, /id="floating-active-site"/);
  assert.doesNotMatch(html, /id="active-site-url"/);
});

test('renderer toggles the independent floating window always-on-top setting', async () => {
  const { elements, appSettingsUpdates } = await setupRendererApp({
    appSettings: {
      floatingWindow: {
        alwaysOnTop: false
      }
    }
  });

  assert.equal(elements.get('#floating-always-on-top').checked, false);

  elements.get('#floating-always-on-top').checked = true;
  await elements.get('#floating-always-on-top').dispatchEvent('change');

  assert.deepEqual(appSettingsUpdates.at(-1), {
    floatingWindow: {
      alwaysOnTop: true
    }
  });
  assert.equal(elements.get('#floating-always-on-top').checked, true);
});

test('renderer uses an auto-selection switch and manual select action labels', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="smart-switch"[^>]*type="checkbox"|type="checkbox"[^>]*id="smart-switch"/);
  assert.doesNotMatch(html, /<button[^>]+id="smart-switch"/);

  const {
    elements,
    proxyUpdates,
    setActiveSiteCalls,
    smartSwitchCalls
  } = await setupRendererApp({
    activeSiteId: 'site-1',
    proxy: {
      port: 8787,
      timeoutMs: 120000,
      failureThreshold: 3,
      smartSwitching: false,
      priorityMode: 'priority',
      samePriorityStrategy: 'round-robin'
    },
    sites: [
      {
        id: 'site-1',
        name: 'selected',
        baseUrl: 'https://selected.example/v1',
        apiKey: 'sk-selected',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'site-2',
        name: 'candidate',
        baseUrl: 'https://candidate.example/v1',
        apiKey: 'sk-candidate',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#smart-switch').checked, false);
  assert.equal(elements.get('#smart-switching').checked, false);
  assert.equal(elements.get('#set-active').textContent, '已选择');
  assert.equal(elements.get('#set-active').disabled, true);

  const firstActions = elements.get('#site-list').children[0].children.find(
    (child) => child.className === 'site-actions'
  );
  const secondActions = elements.get('#site-list').children[1].children.find(
    (child) => child.className === 'site-actions'
  );
  assert.equal(firstActions.children[1].textContent, '已选择');
  assert.equal(firstActions.children[1].disabled, true);
  assert.equal(secondActions.children[1].textContent, '选择');
  assert.equal(secondActions.children[1].disabled, false);

  await secondActions.children[1].dispatchEvent('click');

  assert.deepEqual(setActiveSiteCalls, ['site-2']);
  assert.equal(
    elements.get('#site-list').children[1].children.find(
      (child) => child.className === 'site-actions'
    ).children[1].textContent,
    '已选择'
  );
  assert.equal(elements.get('#set-active').textContent, '已选择');

  elements.get('#smart-switch').checked = true;
  await elements.get('#smart-switch').dispatchEvent('change');

  assert.equal(proxyUpdates.at(-1).smartSwitching, true);
  assert.equal(
    elements.get('#site-list').children[1].children.find(
      (child) => child.className === 'site-actions'
    ).children[1].textContent,
    '停用'
  );
  assert.deepEqual(smartSwitchCalls, []);
});

test('renderer exposes selected-site one-click test and toggle buttons', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="test-site"/);
  assert.match(html, /id="toggle-selected-site"/);
});

test('selected-site test and toggle buttons call the selected site actions', async () => {
  const { elements, siteTestCalls, siteEnabledUpdates } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#test-site').disabled, false);
  assert.equal(elements.get('#toggle-selected-site').textContent, '停用');

  await elements.get('#test-site').dispatchEvent('click');
  await elements.get('#toggle-selected-site').dispatchEvent('click');

  assert.deepEqual(siteTestCalls, ['site-1']);
  assert.deepEqual(siteEnabledUpdates, [{ id: 'site-1', enabled: false }]);
});

test('renderer can manually test a manually disabled site without enabling it first', async () => {
  const { elements, siteTestCalls } = await setupRendererApp({
    activeSiteId: null,
    sites: [
      {
        id: 'site-1',
        name: 'disabled site',
        baseUrl: 'https://disabled.example/v1',
        apiKey: 'sk-disabled',
        manualEnabled: false,
        failureDisabled: false,
        enabled: false,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#test-site').disabled, false);

  await elements.get('#test-site').dispatchEvent('click');

  assert.deepEqual(siteTestCalls, ['site-1']);
  assert.equal(elements.get('#context-site-status').textContent, '成功');
  assert.equal(elements.get('#overview-availability').textContent, '人工停用');
  assert.equal(elements.get('#site-enabled').checked, false);

  const siteItem = elements.get('#site-list').children[0];
  const actions = siteItem.children.find((child) => child.className === 'site-actions');

  await actions.children[0].dispatchEvent('click');

  assert.deepEqual(siteTestCalls, ['site-1', 'site-1']);
  assert.equal(elements.get('#context-site-status').textContent, '成功');
  assert.equal(elements.get('#overview-availability').textContent, '人工停用');
  assert.equal(elements.get('#site-enabled').checked, false);
});

test('site list exposes per-site test and toggle actions', async () => {
  const { elements } = await setupRendererApp({
    proxy: {
      port: 8787,
      timeoutMs: 120000,
      failureThreshold: 3,
      smartSwitching: true,
      priorityMode: 'priority',
      samePriorityStrategy: 'round-robin'
    },
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  const siteItem = elements.get('#site-list').children[0];
  const actions = siteItem.children.find((child) => child.className === 'site-actions');

  assert.equal(actions.children.length, 2);
  assert.equal(actions.children[0].textContent, '测试');
  assert.equal(actions.children[1].textContent, '停用');
});

test('site list marks the latest request result with success and error border classes', async () => {
  const { elements } = await setupRendererApp({
    sites: [
      {
        id: 'success-site',
        name: 'success',
        baseUrl: 'https://success.example/v1',
        apiKey: 'sk-success',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'success',
        requestCount: 1,
        successCount: 1,
        errorCount: 0,
        consecutiveErrors: 0,
        lastRequestAt: '2026-06-03T08:00:00.000Z',
        lastSuccessAt: '2026-06-03T08:00:00.000Z',
        lastErrorAt: null,
        errorLog: []
      },
      {
        id: 'error-site',
        name: 'error',
        baseUrl: 'https://error.example/v1',
        apiKey: 'sk-error',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'error',
        requestCount: 1,
        successCount: 0,
        errorCount: 1,
        consecutiveErrors: 1,
        lastRequestAt: '2026-06-03T08:01:00.000Z',
        lastSuccessAt: null,
        lastErrorAt: '2026-06-03T08:01:00.000Z',
        errorLog: []
      }
    ]
  });

  const [successItem, errorItem] = elements.get('#site-list').children;

  assert.match(successItem.className, /last-success/);
  assert.doesNotMatch(successItem.className, /last-error/);
  assert.match(errorItem.className, /last-error/);
  assert.doesNotMatch(errorItem.className, /last-success/);
});

test('site patch updates an existing site row without rebuilding the whole list', async () => {
  const { elements, dispatchSiteChanged } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'site-2',
        name: 'other',
        baseUrl: 'https://other.example/v1',
        apiKey: 'sk-other',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  const list = elements.get('#site-list');
  const firstRow = list.children[0];
  const secondRow = list.children[1];

  dispatchSiteChanged({
    activeSiteId: 'site-1',
    site: {
      id: 'site-1',
      name: 'site',
      baseUrl: 'https://site.example/v1',
      apiKey: 'sk-site',
      manualEnabled: true,
      failureDisabled: false,
      enabled: true,
      status: 'success',
      requestCount: 1,
      successCount: 1,
      errorCount: 0,
      consecutiveErrors: 0,
      lastRequestAt: '2026-06-03T08:00:00.000Z',
      lastSuccessAt: '2026-06-03T08:00:00.000Z',
      lastErrorAt: null,
      requestStats: {
        hour: [
          {
            key: '2026-06-03T08',
            startedAt: '2026-06-03T08:00:00.000Z',
            successCount: 1,
            errorCount: 0
          }
        ]
      },
      errorLog: []
    }
  });

  assert.equal(list.children[0], firstRow);
  assert.equal(list.children[1], secondRow);
  assert.match(firstRow.className, /last-success/);
  assert.equal(elements.get('#dashboard-requests').textContent, '1');
});

test('site patch changes the latest request border when success and error share a timestamp', async () => {
  const sameTimestamp = '2026-06-03T08:00:00.000Z';
  const { elements, dispatchSiteChanged } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'success',
        requestCount: 1,
        successCount: 1,
        errorCount: 0,
        consecutiveErrors: 0,
        lastRequestAt: sameTimestamp,
        lastSuccessAt: sameTimestamp,
        lastErrorAt: null,
        errorLog: []
      }
    ]
  });

  const row = elements.get('#site-list').children[0];
  assert.match(row.className, /last-success/);

  dispatchSiteChanged({
    activeSiteId: 'site-1',
    site: {
      id: 'site-1',
      name: 'site',
      baseUrl: 'https://site.example/v1',
      apiKey: 'sk-site',
      manualEnabled: true,
      failureDisabled: false,
      enabled: true,
      status: 'error',
      requestCount: 2,
      successCount: 1,
      errorCount: 1,
      consecutiveErrors: 1,
      lastRequestAt: sameTimestamp,
      lastSuccessAt: sameTimestamp,
      lastErrorAt: sameTimestamp,
      errorLog: []
    }
  });

  assert.equal(elements.get('#site-list').children[0], row);
  assert.match(row.className, /last-error/);
  assert.doesNotMatch(row.className, /last-success/);
});

test('renderer exposes and refreshes selected-site model capabilities', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="detect-site-capabilities"/);
  assert.match(html, /id="site-capability-summary"/);
  assert.match(html, /id="site-capability-features"/);
  assert.match(html, /id="site-capability-models"/);

  const { elements, capabilityDetectionCalls, siteUpdates } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 1,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.match(elements.get('#site-capability-summary').textContent, /尚未探测/);

  await elements.get('#detect-site-capabilities').dispatchEvent('click');

  assert.deepEqual(capabilityDetectionCalls, ['site-1']);
  assert.equal(siteUpdates.at(-1).id, 'site-1');
  assert.match(elements.get('#site-capability-summary').textContent, /2 个模型/);
  assert.match(elements.get('#site-capability-features').innerHTML, /生图/);
  assert.match(elements.get('#site-capability-models').innerHTML, /dall-e-3/);
  assert.match(elements.get('#site-status').innerHTML, /模型能力/);
  assert.match(elements.get('#site-status').innerHTML, /文本、?生图|生图/);
});

test('renderer form exposes failure-disabled auto recovery controls', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="auto-recovery-enabled"/);
  assert.match(html, /id="auto-recovery-interval-value"/);
  assert.match(html, /id="auto-recovery-interval-unit"/);
  assert.match(html, /错误停用后自检恢复/);
  assert.match(html, /错误停用后自动自检/);
  assert.doesNotMatch(html, /(?<!错误)停用后自动自检/);
});

test('renderer form exposes site remark field', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="site-remark"/);
  assert.match(html, /<textarea[^>]+id="site-remark"/);
});

test('renderer exposes and saves priority mode and site multiplier fields', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="priority-mode"/);
  assert.match(html, /id="site-multiplier" type="text"/);
  assert.match(html, /id="site-multiplier-locked"/);
  assert.match(html, /按优先级/);
  assert.match(html, /按倍率/);

  const { elements, proxyUpdates, siteUpdates } = await setupRendererApp({
    activeSiteId: 'site-1',
    proxy: {
      port: 8787,
      timeoutMs: 120000,
      failureThreshold: 3,
      smartSwitching: true,
      priorityMode: 'multiplier',
      samePriorityStrategy: 'round-robin'
    },
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 0.25,
        multiplierLocked: true,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#priority-mode').value, 'multiplier');
  assert.equal(elements.get('#site-multiplier').value, 0.25);
  assert.equal(elements.get('#site-multiplier-locked').checked, true);

  elements.get('#priority-mode').value = 'priority';
  await elements.get('#save-proxy').dispatchEvent('click');
  assert.equal(proxyUpdates.at(-1).priorityMode, 'priority');

  elements.get('#site-multiplier').value = '0.75';
  await elements.get('#site-form').dispatchEvent('submit');
  assert.equal(siteUpdates.at(-1).patch.multiplier, 0.75);

  elements.get('#site-multiplier').value = '0';
  elements.get('#site-multiplier-locked').checked = false;
  await elements.get('#site-form').dispatchEvent('submit');
  assert.equal(siteUpdates.at(-1).patch.multiplier, 0);
  assert.equal(siteUpdates.at(-1).patch.multiplierLocked, false);
});

test('renderer hides the API key input unless it is focused', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="site-api-key" type="password"/);

  const { elements } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 1,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#site-api-key').type, 'password');
  await elements.get('#site-api-key').dispatchEvent('focus');
  assert.equal(elements.get('#site-api-key').type, 'text');
  await elements.get('#site-api-key').dispatchEvent('blur');
  assert.equal(elements.get('#site-api-key').type, 'password');
});

test('renderer exposes and saves remote site sync settings', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="site-sync-global-interval-value"/);
  assert.match(html, /id="site-sync-global-interval-unit"/);
  assert.match(html, /id="site-sync-intelligent-scheduling"/);
  assert.match(html, /id="group-sync-interval-value"/);
  assert.match(html, /id="group-sync-interval-unit"/);
  assert.match(html, /id="save-site-sync-settings"/);
  assert.match(html, /id="site-sync-enabled"/);
  assert.match(html, /id="site-sync-dashboard-url"/);
  assert.match(html, /id="site-sync-username"/);
  assert.match(html, /id="site-sync-password"/);
  assert.match(html, /id="site-sync-provider-type"/);
  assert.match(html, /id="site-sync-interval-mode"/);
  assert.match(html, /id="site-sync-interval-value"/);
  assert.match(html, /id="site-sync-interval-unit"/);
  assert.match(html, /id="sync-site"/);
  assert.match(html, /id="site-sync-balance"/);
  assert.match(html, /id="site-sync-key-name"/);
  assert.match(html, /id="site-sync-key-group"/);
  assert.match(html, /id="site-sync-multiplier"/);
  assert.match(html, /id="site-sync-last-at"/);
  assert.match(html, /id="site-sync-groups"/);
  assert.match(html, /id="topbar-sync-groups"/);
  assert.match(html, /id="toggle-topbar-sync-groups"/);
  assert.match(html, /id="refresh-site-sync-all"/);
  assert.match(html, /id="clear-site-group-filter"/);

  const { elements, siteUpdates, siteSyncUpdates, groupSyncUpdates } = await setupRendererApp({
    siteSync: {
      intervalValue: 45,
      intervalUnit: 'minute',
      intelligentScheduling: true
    },
    groupSync: {
      intervalValue: 2,
      intervalUnit: 'hour',
      websites: []
    },
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 1,
        sync: {
          enabled: true,
          dashboardUrl: 'https://relay.example.com/console/token',
          username: 'sync-user',
          password: 'secret',
          providerType: 'new-api',
          intervalMode: 'global',
          intervalValue: 2,
          intervalUnit: 'hour',
          lastSyncAt: null,
          lastSyncStatus: null,
          lastSyncError: null,
          remote: {
            providerType: null,
            authType: null,
            accountName: '',
            balance: '',
            apiEndpoint: '',
            keyName: '',
            keyGroup: '',
            groupMultiplier: null,
            groups: []
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.equal(elements.get('#site-sync-global-interval-value').value, 45);
  assert.equal(elements.get('#site-sync-global-interval-unit').value, 'minute');
  assert.equal(elements.get('#site-sync-intelligent-scheduling').checked, true);
  assert.equal(elements.get('#group-sync-interval-value').value, 2);
  assert.equal(elements.get('#group-sync-interval-unit').value, 'hour');
  assert.equal(elements.get('#site-sync-enabled').checked, true);
  assert.equal(elements.get('#site-sync-dashboard-url').value, 'https://relay.example.com/console/token');
  assert.equal(elements.get('#site-sync-username').value, 'sync-user');
  assert.equal(elements.get('#site-sync-password').value, 'secret');
  assert.equal(elements.get('#site-sync-provider-type').value, 'new-api');
  assert.equal(elements.get('#site-sync-interval-mode').value, 'global');
  assert.equal(elements.get('#site-sync-interval-value').disabled, true);
  assert.equal(elements.get('#site-sync-interval-unit').disabled, true);
  assert.equal(elements.get('#site-sync-interval-value').value, 2);
  assert.equal(elements.get('#site-sync-interval-unit').value, 'hour');
  assert.equal(elements.get('#site-sync-balance').textContent, '-');
  assert.equal(elements.get('#site-sync-key-name').textContent, '-');
  assert.equal(elements.get('#site-sync-key-group').textContent, '-');
  assert.equal(elements.get('#site-sync-multiplier').textContent, '-');

  elements.get('#site-sync-global-interval-value').value = '2';
  elements.get('#site-sync-global-interval-unit').value = 'hour';
  elements.get('#site-sync-intelligent-scheduling').checked = false;
  elements.get('#group-sync-interval-value').value = '15';
  elements.get('#group-sync-interval-unit').value = 'minute';
  await elements.get('#save-site-sync-settings').dispatchEvent('click');

  assert.deepEqual(siteSyncUpdates.at(-1), {
    intervalValue: 2,
    intervalUnit: 'hour',
    intelligentScheduling: false
  });
  assert.deepEqual(groupSyncUpdates.at(-1), {
    intervalValue: 15,
    intervalUnit: 'minute'
  });

  elements.get('#site-sync-dashboard-url').value = 'https://sync.example.com/keys';
  elements.get('#site-sync-username').value = 'user@example.com';
  elements.get('#site-sync-password').value = 'secret-2';
  elements.get('#site-sync-provider-type').value = 'modern-v1';
  elements.get('#site-sync-interval-mode').value = 'custom';
  await elements.get('#site-sync-interval-mode').dispatchEvent('change');
  assert.equal(elements.get('#site-sync-interval-value').disabled, false);
  assert.equal(elements.get('#site-sync-interval-unit').disabled, false);
  elements.get('#site-sync-interval-value').value = '45';
  elements.get('#site-sync-interval-unit').value = 'minute';
  await elements.get('#site-form').dispatchEvent('submit');

  assert.equal(siteUpdates.at(-1).patch.sync.enabled, true);
  assert.equal(siteUpdates.at(-1).patch.sync.dashboardUrl, 'https://sync.example.com/keys');
  assert.equal(siteUpdates.at(-1).patch.sync.username, 'user@example.com');
  assert.equal(siteUpdates.at(-1).patch.sync.password, 'secret-2');
  assert.equal(siteUpdates.at(-1).patch.sync.providerType, 'modern-v1');
  assert.equal(siteUpdates.at(-1).patch.sync.intervalMode, 'custom');
  assert.equal(siteUpdates.at(-1).patch.sync.intervalValue, 45);
  assert.equal(siteUpdates.at(-1).patch.sync.intervalUnit, 'minute');
  assert.deepEqual(siteUpdates.at(-1).patch.sync.remote, {
    providerType: null,
    authType: null,
    accountName: '',
    balance: '',
    apiEndpoint: '',
    keyName: '',
    keyGroup: '',
    groupMultiplier: null,
    groups: []
  });

  elements.get('#site-sync-interval-mode').value = 'global';
  await elements.get('#site-form').dispatchEvent('submit');

  assert.equal(siteUpdates.at(-1).patch.sync.intervalMode, 'global');
});

test('renderer exposes and saves global and per-site model mappings', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');

  assert.match(html, /id="global-model-mapping-enabled"/);
  assert.match(html, /id="global-model-mapping-rows"/);
  assert.match(html, /id="add-global-model-mapping"/);
  assert.match(html, /id="global-model-mapping"/);
  assert.match(html, /id="site-model-mapping-enabled"/);
  assert.match(html, /id="site-model-mapping-rows"/);
  assert.match(html, /id="add-site-model-mapping"/);
  assert.match(html, /id="site-model-mapping"/);

  const { elements, modelMappingUpdates, siteUpdates, module } = await setupRendererApp({
    modelMapping: {
      enabled: true,
      mappings: [{ from: 'gpt-4o', to: 'global-target' }]
    },
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 1,
        modelMapping: {
          enabled: true,
          mappings: [{ from: 'gpt-5', to: 'site-target' }]
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  const globalRows = elements.get('#global-model-mapping-rows');
  assert.equal(elements.get('#global-model-mapping-enabled').checked, true);
  assert.equal(globalRows.children.length, 1);
  assert.equal(getMappingRowField(globalRows.children[0], 'from').value, 'gpt-4o');
  assert.equal(getMappingRowField(globalRows.children[0], 'to').value, 'global-target');

  const siteRows = elements.get('#site-model-mapping-rows');
  assert.equal(elements.get('#site-model-mapping-enabled').checked, true);
  assert.equal(siteRows.children.length, 1);
  assert.equal(getMappingRowField(siteRows.children[0], 'from').value, 'gpt-5');
  assert.equal(getMappingRowField(siteRows.children[0], 'to').value, 'site-target');
  assert.deepEqual(module.parseModelMappingText('gpt-5=gpt-5-mini\n# note\ngpt-4o -> gpt-4.1'), [
    { from: 'gpt-5', to: 'gpt-5-mini' },
    { from: 'gpt-4o', to: 'gpt-4.1' }
  ]);
  assert.deepEqual(module.parseModelMappingText('{"gpt-5":"gpt-5-mini"}'), [
    { from: 'gpt-5', to: 'gpt-5-mini' }
  ]);

  elements.get('#global-model-mapping-enabled').checked = true;
  getMappingRowField(globalRows.children[0], 'from').value = 'gpt-5';
  getMappingRowField(globalRows.children[0], 'to').value = 'gpt-5-mini';
  await elements.get('#add-global-model-mapping').dispatchEvent('click');
  getMappingRowField(globalRows.children[1], 'from').value = '';
  getMappingRowField(globalRows.children[1], 'to').value = '';
  await elements.get('#save-proxy').dispatchEvent('click');

  assert.deepEqual(modelMappingUpdates.at(-1), {
    enabled: true,
    mappings: [{ from: 'gpt-5', to: 'gpt-5-mini' }]
  });

  elements.get('#site-model-mapping-enabled').checked = true;
  getMappingRowField(siteRows.children[0], 'from').value = 'gpt-5';
  getMappingRowField(siteRows.children[0], 'to').value = 'claude-sonnet-4-5';
  await elements.get('#add-site-model-mapping').dispatchEvent('click');
  getMappingRowField(siteRows.children[1], 'from').value = 'gpt-4o';
  getMappingRowField(siteRows.children[1], 'to').value = 'gpt-4.1';
  await elements.get('#site-form').dispatchEvent('submit');

  assert.deepEqual(siteUpdates.at(-1).patch.modelMapping, {
    enabled: true,
    mappings: [
      { from: 'gpt-5', to: 'claude-sonnet-4-5' },
      { from: 'gpt-4o', to: 'gpt-4.1' }
    ]
  });
});

test('renderer exports all or selected configuration sections', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');
  assert.match(html, /id="config-export-mode"/);
  assert.match(html, /id="config-export-selected-sites"/);
  assert.match(html, /id="export-config"/);

  const { elements, configExportCalls } = await setupRendererApp({
    activeSiteId: 'site-2',
    sites: [
      {
        id: 'site-1',
        name: 'A Site',
        baseUrl: 'https://a.example/v1',
        apiKey: 'sk-a',
        manualEnabled: true,
        enabled: true,
        priority: 100,
        multiplier: 1,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      },
      {
        id: 'site-2',
        name: 'B Site',
        baseUrl: 'https://b.example/v1',
        apiKey: 'sk-b',
        manualEnabled: true,
        enabled: true,
        priority: 20,
        multiplier: 0.5,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  assert.match(elements.get('#config-export-selected-sites').textContent, /A Site/);
  assert.match(elements.get('#config-export-selected-sites').textContent, /B Site/);

  await elements.get('#export-config').dispatchEvent('click');
  assert.deepEqual(configExportCalls.at(-1), {
    includeGlobalSettings: true,
    siteIds: null
  });

  elements.get('#config-export-mode').value = 'current';
  elements.get('#config-export-global-settings').checked = false;
  await elements.get('#export-config').dispatchEvent('click');
  assert.deepEqual(configExportCalls.at(-1), {
    includeGlobalSettings: false,
    siteIds: ['site-2']
  });

  elements.get('#config-export-mode').value = 'selected';
  await elements.get('#config-export-mode').dispatchEvent('change');
  const manualCheckboxes = elements.get('#config-export-selected-sites').children;
  manualCheckboxes[0].children[0].checked = true;
  manualCheckboxes[1].children[0].checked = false;
  await elements.get('#export-config').dispatchEvent('click');
  assert.deepEqual(configExportCalls.at(-1), {
    includeGlobalSettings: false,
    siteIds: ['site-1']
  });
});

test('renderer previews an import file and imports only selected sections', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');
  assert.match(html, /id="preview-import-config"/);
  assert.match(html, /id="config-import-sites"/);
  assert.match(html, /id="apply-import-config"/);

  const {
    elements,
    configImportPreviewCalls,
    configImportCalls
  } = await setupRendererApp();

  await elements.get('#preview-import-config').dispatchEvent('click');

  assert.deepEqual(configImportPreviewCalls, [true]);
  assert.equal(elements.get('#config-import-preview').hidden, false);
  assert.match(elements.get('#config-import-summary').textContent, /2 个站点/);
  assert.match(elements.get('#config-import-sites').textContent, /Imported A/);
  assert.match(elements.get('#config-import-sites').textContent, /Imported B/);

  const importCheckboxes = elements.get('#config-import-sites').children;
  importCheckboxes[0].children[0].checked = false;
  importCheckboxes[1].children[0].checked = true;
  elements.get('#config-import-global-settings').checked = false;

  await elements.get('#apply-import-config').dispatchEvent('click');

  assert.deepEqual(configImportCalls.at(-1), {
    importId: 'test-import',
    includeGlobalSettings: false,
    siteIds: ['import-b']
  });
});

test('renderer rejects duplicate model mapping source models before saving', async () => {
  const { elements, modelMappingUpdates } = await setupRendererApp();
  const globalRows = elements.get('#global-model-mapping-rows');

  elements.get('#global-model-mapping-enabled').checked = true;
  getMappingRowField(globalRows.children[0], 'from').value = 'gpt-5';
  getMappingRowField(globalRows.children[0], 'to').value = 'target-a';
  await elements.get('#add-global-model-mapping').dispatchEvent('click');
  getMappingRowField(globalRows.children[1], 'from').value = 'gpt-5';
  getMappingRowField(globalRows.children[1], 'to').value = 'target-b';

  await elements.get('#save-proxy').dispatchEvent('click');

  assert.equal(modelMappingUpdates.length, 0);
  assert.equal(elements.get('#toast').hidden, false);
  assert.match(elements.get('#toast').textContent, /重复/);
});

test('renderer allows incomplete model mapping drafts while mapping is disabled', async () => {
  const { elements, modelMappingUpdates } = await setupRendererApp();
  const globalRows = elements.get('#global-model-mapping-rows');

  elements.get('#global-model-mapping-enabled').checked = false;
  getMappingRowField(globalRows.children[0], 'from').value = 'draft-model';
  getMappingRowField(globalRows.children[0], 'to').value = '';

  await elements.get('#save-proxy').dispatchEvent('click');

  assert.deepEqual(modelMappingUpdates.at(-1), {
    enabled: false,
    mappings: []
  });
});

test('renderer sync button calls remote sync and fills multiplier from returned state', async () => {
  const { elements, siteSyncCalls } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 1,
        sync: {
          enabled: true,
          dashboardUrl: 'https://relay.example.com/console/token',
          username: 'sync-user',
          password: 'secret',
          providerType: 'new-api',
          lastSyncAt: null,
          lastSyncStatus: null,
          lastSyncError: null,
          remote: {
            providerType: null,
            authType: null,
            accountName: '',
            balance: '',
            apiEndpoint: '',
            keyName: '',
            keyGroup: '',
            groupMultiplier: null,
            groups: []
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  await elements.get('#sync-site').dispatchEvent('click');

  assert.deepEqual(siteSyncCalls, ['site-1']);
  assert.equal(elements.get('#site-multiplier').value, 0.003);
  assert.equal(elements.get('#site-sync-balance').textContent, '$0.00');
  assert.equal(elements.get('#site-sync-key-name').textContent, 'qa');
  assert.equal(elements.get('#site-sync-key-group').textContent, 'AAA.限时白嫖GPT 0.003x');
  assert.equal(elements.get('#site-sync-multiplier').textContent, '0.003');
  assert.match(elements.get('#site-sync-summary').textContent, /AAA\.限时白嫖GPT 0\.003x/);
  assert.match(elements.get('#site-status').innerHTML, /AAA\.限时白嫖GPT 0\.003x/);
});

test('renderer creates and imports a remote key from the current panel after confirmation', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');
  assert.match(html, /id="create-site-key"/);

  const { elements, siteUpdates, siteCreateKeyCalls, confirmMessages } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-old',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 1,
        sync: {
          enabled: true,
          dashboardUrl: 'https://relay.example.com/keys',
          username: 'sync-user',
          password: 'secret',
          providerType: 'modern-v1',
          intervalMode: 'global',
          intervalValue: 30,
          intervalUnit: 'minute',
          remote: {
            keyGroup: 'Example Team',
            groupId: '18',
            groupMultiplier: 1,
            groups: []
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  elements.get('#site-sync-dashboard-url').value = 'https://sync.example.com/keys';
  elements.get('#site-sync-username').value = 'user@example.com';
  elements.get('#site-sync-password').value = 'secret-2';
  await elements.get('#create-site-key').dispatchEvent('click');

  assert.match(confirmMessages.at(-1), /确认在 site 的远端账号中新建密钥并导入本地/);
  assert.equal(siteUpdates.at(-1).id, 'site-1');
  assert.equal(siteUpdates.at(-1).patch.sync.dashboardUrl, 'https://sync.example.com/keys');
  assert.equal(siteUpdates.at(-1).patch.sync.username, 'user@example.com');
  assert.equal(siteUpdates.at(-1).patch.sync.password, 'secret-2');
  assert.deepEqual(siteCreateKeyCalls, ['site-1']);
  assert.equal(elements.get('#site-api-key').value, 'sk-created');
  assert.equal(elements.get('#site-multiplier').value, 0.001);
  assert.equal(elements.get('#site-sync-key-name').textContent, 'site');
  assert.equal(elements.get('#site-sync-key-group').textContent, 'Example Team');
  assert.equal(elements.get('#site-sync-multiplier').textContent, '0.001');
});

test('renderer switches the selected site group from the current panel after confirmation', async () => {
  const { elements, siteUpdates, confirmMessages, setConfirmHandler } = await setupRendererApp({
    activeSiteId: 'site-1',
    sites: [
      {
        id: 'site-1',
        name: 'site',
        baseUrl: 'https://site.example/v1',
        apiKey: 'sk-site',
        manualEnabled: true,
        failureDisabled: false,
        enabled: true,
        status: 'idle',
        priority: 20,
        multiplier: 0.003,
        sync: {
          enabled: true,
          dashboardUrl: 'https://relay.example.com/console/token',
          username: 'sync-user',
          password: 'secret',
          providerType: 'new-api',
          remote: {
            keyName: 'qa',
            keyGroup: 'AAA.限时白嫖GPT 0.003x',
            groupMultiplier: 0.003,
            groups: [
              {
                id: 'aaa',
                name: 'AAA.限时白嫖GPT 0.003x',
                multiplier: 0.003,
                selected: true
              },
              {
                id: 'plus',
                name: 'GPT Plus 0.045x',
                multiplier: 0.045,
                selected: false
              }
            ]
          }
        },
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        consecutiveErrors: 0,
        errorLog: []
      }
    ]
  });

  const groupButtons = elements.get('#site-sync-groups').children;
  assert.equal(groupButtons.length, 2);
  assert.match(groupButtons[1].textContent, /GPT Plus 0\.045x/);
  assert.match(groupButtons[1].className, /site-sync-group-chip/);

  setConfirmHandler(() => false);
  await groupButtons[1].dispatchEvent('click');
  assert.equal(siteUpdates.length, 0);
  assert.match(confirmMessages.at(-1), /确认将 site 的远端分组从 AAA\.限时白嫖GPT 0\.003x 切换到 GPT Plus 0\.045x/);

  setConfirmHandler(() => true);
  await groupButtons[1].dispatchEvent('click');

  assert.deepEqual(siteUpdates.at(-1), {
    id: 'site-1',
    switchGroupName: 'GPT Plus 0.045x'
  });
  assert.equal(elements.get('#site-multiplier').value, 0.045);
  assert.equal(elements.get('#site-sync-key-group').textContent, 'GPT Plus 0.045x');
  assert.equal(elements.get('#site-sync-multiplier').textContent, '0.045');
});

test('renderer proxy settings expose and save unified upstream timeout seconds', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');
  assert.match(html, /id="proxy-timeout-seconds"/);

  const { elements, proxyUpdates } = await setupRendererApp({
    proxy: {
      port: 8787,
      timeoutMs: 300000,
      failureThreshold: 3,
      smartSwitching: true,
      samePriorityStrategy: 'round-robin'
    }
  });
  const timeoutInput = elements.get('#proxy-timeout-seconds');

  assert.equal(timeoutInput.value, 300);

  timeoutInput.value = '45';
  await elements.get('#save-proxy').dispatchEvent('click');

  assert.equal(proxyUpdates.at(-1).timeoutMs, 45000);
});

test('renderer proxy settings expose and save request body replay buffer megabytes', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');
  assert.match(html, /id="proxy-replay-buffer-mb"/);

  const { elements, proxyUpdates } = await setupRendererApp({
    proxy: {
      port: 8787,
      timeoutMs: 120000,
      maxReplayableRequestBodyBytes: 32 * 1024 * 1024,
      failureThreshold: 3,
      smartSwitching: true,
      priorityMode: 'priority',
      samePriorityStrategy: 'round-robin'
    }
  });
  const bufferInput = elements.get('#proxy-replay-buffer-mb');

  assert.equal(bufferInput.value, 32);

  bufferInput.value = '64';
  await elements.get('#save-proxy').dispatchEvent('click');

  assert.equal(proxyUpdates.at(-1).maxReplayableRequestBodyBytes, 64 * 1024 * 1024);
});

test('renderer shows fixed proxy port startup errors without changing the endpoint', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');
  assert.match(html, /id="proxy-error"/);

  const { elements, module } = await setupRendererApp({
    proxy: {
      port: 8787,
      timeoutMs: 120000,
      failureThreshold: 3,
      smartSwitching: true,
      samePriorityStrategy: 'round-robin'
    },
    proxyStatus: {
      running: false,
      port: null,
      error: {
        code: 'EADDRINUSE',
        message: 'listen EADDRINUSE: address already in use 127.0.0.1:8787'
      }
    }
  });

  assert.equal(elements.get('#proxy-url').textContent, 'http://127.0.0.1:8787/v1');
  assert.equal(elements.get('#proxy-error').hidden, false);
  assert.match(elements.get('#proxy-error').textContent, /端口 8787 被占用/);
  assert.match(module.formatProxyError({ code: 'EPERM', message: 'access denied' }, 8787), /access denied/);
});

test('renderer copies the displayed proxy URL from the button and shortcut', async () => {
  const html = await readFile(rendererHtmlPath, 'utf8');
  assert.match(html, /id="copy-proxy-url"/);
  assert.match(html, /Ctrl\+Shift\+C/);

  const { elements, copyTextCalls, windowListeners } = await setupRendererApp({
    proxyStatus: {
      running: true,
      port: 15432,
      error: null
    }
  });

  const proxyUrl = 'http://127.0.0.1:15432/v1';
  assert.equal(elements.get('#proxy-url').textContent, proxyUrl);

  await elements.get('#copy-proxy-url').dispatchEvent('click');
  assert.deepEqual(copyTextCalls, [proxyUrl]);

  let prevented = false;
  for (const listener of windowListeners.get('keydown') ?? []) {
    await listener({
      key: 'C',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault() {
        prevented = true;
      }
    });
  }

  assert.equal(prevented, true);
  assert.deepEqual(copyTextCalls, [proxyUrl, proxyUrl]);
});

test('renderer logs action errors before showing toast feedback', async () => {
  const { elements, runtimeLogCalls } = await setupRendererApp({
    copyTextError: new Error('clipboard denied')
  });

  await elements.get('#copy-proxy-url').dispatchEvent('click');

  assert.equal(elements.get('#toast').hidden, false);
  assert.match(elements.get('#toast').textContent, /clipboard denied/);
  assert.equal(runtimeLogCalls.at(-1).source, 'renderer.action-error');
  assert.equal(runtimeLogCalls.at(-1).message, 'clipboard denied');
});

test('renderer shows global runtime errors in the existing toast surface', async () => {
  const { elements, runtimeLogCalls } = await setupRendererApp();

  window.dispatchEvent({
    type: 'error',
    message: 'render crashed',
    filename: 'app.js',
    lineno: 12,
    colno: 34,
    error: new Error('render crashed')
  });

  assert.equal(elements.get('#toast').hidden, false);
  assert.match(elements.get('#toast').textContent, /render crashed/);
  assert.equal(runtimeLogCalls.at(-1).source, 'renderer.global-error');
  assert.equal(runtimeLogCalls.at(-1).message, 'render crashed');
  assert.equal(runtimeLogCalls.at(-1).context.filename, 'app.js');
  assert.equal(runtimeLogCalls.at(-1).context.lineno, 12);
  assert.equal(runtimeLogCalls.at(-1).context.colno, 34);

  window.dispatchEvent({
    type: 'unhandledrejection',
    reason: new Error('async render crashed')
  });

  assert.match(elements.get('#toast').textContent, /async render crashed/);
  assert.equal(runtimeLogCalls.at(-1).source, 'renderer.unhandled-rejection');
  assert.equal(runtimeLogCalls.at(-1).message, 'async render crashed');
});
