import { calculateEffectiveMultiplier } from '../proxy/switching-policy.js';
import { shouldPreserveEditorOnStateChange } from './editor-preservation.js';

const api = window.openApiProxy;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_PROXY_REPLAY_BUFFER_MB = 16;

let state = null;
let selectedSiteId = null;
let selectedDashboardPeriod = 'hour';
let selectedSiteStatusFilter = 'all';
let selectedSiteSort = 'default';
let selectedGroupFilterKey = null;
let selectedWorkspaceView = 'sites';
let selectedSiteTab = 'overview';
let showAllTopbarSyncGroups = false;
let selectedGroupAction = null;
let groupPopoverAnchor = null;
let compactInspectorMode = window.innerWidth < 1160;
let siteInspectorOpen = !compactInspectorMode;
let formDirty = false;
let pendingEditorNavigation = null;
let pendingImportPreview = null;
let configTransferDefaultsApplied = false;
let activityLogs = [];
let selectedActivityCategory = 'all';
let selectedActivityStatus = 'all';
let monitoringTaskStatus = null;
let visibleLocalApiKey = '';

const elements = {
  navSites: document.querySelector('#nav-sites'),
  navStrategy: document.querySelector('#nav-strategy'),
  navDiagnostics: document.querySelector('#nav-diagnostics'),
  navActivity: document.querySelector('#nav-activity'),
  navSettings: document.querySelector('#nav-settings'),
  viewSites: document.querySelector('#view-sites'),
  viewStrategy: document.querySelector('#view-strategy'),
  viewDiagnostics: document.querySelector('#view-diagnostics'),
  viewActivity: document.querySelector('#view-activity'),
  viewSettings: document.querySelector('#view-settings'),
  workspace: document.querySelector('.workspace'),
  legacyOverviewSource: document.querySelector('#view-overview'),
  siteOverview: document.querySelector('#site-overview'),
  requestDashboard: document.querySelector('#request-dashboard'),
  overviewSyncGroups: document.querySelector('.overview-sync-groups'),
  sidebarGroupHost: document.querySelector('#sidebar-group-host'),
  siteTabOverview: document.querySelector('#site-tab-overview'),
  siteTabBasic: document.querySelector('#site-tab-basic'),
  siteTabSync: document.querySelector('#site-tab-sync'),
  siteTabModels: document.querySelector('#site-tab-models'),
  siteTabPolicy: document.querySelector('#site-tab-policy'),
  siteTabOverviewPanel: document.querySelector('#site-tab-overview-panel'),
  siteBasicPanel: document.querySelector('#site-basic-panel'),
  siteSyncPanel: document.querySelector('#site-sync-panel'),
  siteModelsPanel: document.querySelector('#site-models-panel'),
  sitePolicyPanel: document.querySelector('#site-policy-panel'),
  formActions: document.querySelector('.form-actions'),
  siteInspector: document.querySelector('#site-inspector'),
  toggleSiteInspector: document.querySelector('#toggle-site-inspector'),
  closeSiteInspector: document.querySelector('#close-site-inspector'),
  inspectorStatusHost: document.querySelector('#inspector-status-host'),
  statusPanel: document.querySelector('.status-panel'),
  inspectorRouteLog: document.querySelector('#inspector-route-log'),
  openRequestTraces: document.querySelector('#open-request-traces'),
  inspectorErrorHost: document.querySelector('#inspector-error-host'),
  errorLogPanel: document.querySelector('#error-log-panel'),
  proxyUrl: document.querySelector('#proxy-url'),
  proxyEndpointLabel: document.querySelector('#proxy-endpoint-label'),
  copyProxyUrl: document.querySelector('#copy-proxy-url'),
  proxyStatus: document.querySelector('#proxy-status'),
  proxyError: document.querySelector('#proxy-error'),
  proxyPort: document.querySelector('#proxy-port'),
  localApiKey: document.querySelector('#local-api-key'),
  copyLocalApiKey: document.querySelector('#copy-local-api-key'),
  generateLocalApiKey: document.querySelector('#generate-local-api-key'),
  localApiKeyNote: document.querySelector('#local-api-key-note'),
  allowLanAccess: document.querySelector('#allow-lan-access'),
  proxyTimeoutSeconds: document.querySelector('#proxy-timeout-seconds'),
  proxyReplayBufferMb: document.querySelector('#proxy-replay-buffer-mb'),
  codexRecoveryEnabled: document.querySelector('#codex-recovery-enabled'),
  failureThreshold: document.querySelector('#failure-threshold'),
  globalTestModel: document.querySelector('#global-test-model'),
  smartSwitching: document.querySelector('#smart-switching'),
  priorityMode: document.querySelector('#priority-mode'),
  samePriorityStrategy: document.querySelector('#same-priority-strategy'),
  autoSwitchMultiplierLimitEnabled: document.querySelector('#auto-switch-multiplier-limit-enabled'),
  autoSwitchMaxMultiplier: document.querySelector('#auto-switch-max-multiplier'),
  globalModelMappingEnabled: document.querySelector('#global-model-mapping-enabled'),
  globalModelMappingRows: document.querySelector('#global-model-mapping-rows'),
  addGlobalModelMapping: document.querySelector('#add-global-model-mapping'),
  globalModelMapping: document.querySelector('#global-model-mapping'),
  saveProxy: document.querySelector('#save-proxy'),
  siteSyncGlobalIntervalValue: document.querySelector('#site-sync-global-interval-value'),
  siteSyncGlobalIntervalUnit: document.querySelector('#site-sync-global-interval-unit'),
  siteSyncIntelligentScheduling: document.querySelector('#site-sync-intelligent-scheduling'),
  groupSyncIntervalValue: document.querySelector('#group-sync-interval-value'),
  groupSyncIntervalUnit: document.querySelector('#group-sync-interval-unit'),
  saveSiteSyncSettings: document.querySelector('#save-site-sync-settings'),
  monitoringEnabled: document.querySelector('#monitoring-enabled'),
  feishuWebhook: document.querySelector('#feishu-webhook'),
  monitoringMultiplierChanged: document.querySelector('#monitoring-multiplier-changed'),
  monitoringLowBalance: document.querySelector('#monitoring-low-balance'),
  monitoringNoUsableSite: document.querySelector('#monitoring-no-usable-site'),
  noUsableSiteDelayMinutes: document.querySelector('#no-usable-site-delay-minutes'),
  monitoringProgramIssues: document.querySelector('#monitoring-program-issues'),
  monitoringAnswerCompleted: document.querySelector('#monitoring-answer-completed'),
  monitoringGoalStatusChanged: document.querySelector('#monitoring-goal-status-changed'),
  monitoringSummary: document.querySelector('#monitoring-summary'),
  saveMonitoring: document.querySelector('#save-monitoring'),
  testFeishuWebhook: document.querySelector('#test-feishu-webhook'),
  installMonitoringTask: document.querySelector('#install-monitoring-task'),
  removeMonitoringTask: document.querySelector('#remove-monitoring-task'),
  configExportGlobalSettings: document.querySelector('#config-export-global-settings'),
  configExportMode: document.querySelector('#config-export-mode'),
  configExportSelectedSites: document.querySelector('#config-export-selected-sites'),
  exportConfig: document.querySelector('#export-config'),
  previewImportConfig: document.querySelector('#preview-import-config'),
  configImportPreview: document.querySelector('#config-import-preview'),
  configImportSummary: document.querySelector('#config-import-summary'),
  configImportGlobalSettings: document.querySelector('#config-import-global-settings'),
  configImportSites: document.querySelector('#config-import-sites'),
  applyImportConfig: document.querySelector('#apply-import-config'),
  quitApp: document.querySelector('#quit-app'),
  restartProxy: document.querySelector('#restart-proxy'),
  siteList: document.querySelector('#site-list'),
  siteListSummary: document.querySelector('#site-list-summary'),
  siteStatusFilter: document.querySelector('#site-status-filter'),
  siteSort: document.querySelector('#site-sort'),
  newSite: document.querySelector('#new-site'),
  editorTitle: document.querySelector('#editor-title'),
  editorSubtitle: document.querySelector('#editor-subtitle'),
  configPath: document.querySelector('#config-path'),
  toolbar: document.querySelector('.toolbar'),
  floatingAlwaysOnTop: document.querySelector('#floating-always-on-top'),
  smartSwitch: document.querySelector('#smart-switch'),
  testSite: document.querySelector('#test-site'),
  detectSiteCapabilities: document.querySelector('#detect-site-capabilities'),
  toggleSelectedSite: document.querySelector('#toggle-selected-site'),
  setActive: document.querySelector('#set-active'),
  cloneSite: document.querySelector('#clone-site'),
  deleteSite: document.querySelector('#delete-site'),
  overviewAvailability: document.querySelector('#overview-availability'),
  overviewLastRequest: document.querySelector('#overview-last-request'),
  overviewSuccessRate: document.querySelector('#overview-success-rate'),
  overviewConsecutiveErrors: document.querySelector('#overview-consecutive-errors'),
  dashboardPeriodHour: document.querySelector('#dashboard-period-hour'),
  dashboardPeriodDay: document.querySelector('#dashboard-period-day'),
  dashboardPeriodWeek: document.querySelector('#dashboard-period-week'),
  dashboardPeriodMonth: document.querySelector('#dashboard-period-month'),
  dashboardRequests: document.querySelector('#dashboard-requests'),
  dashboardSuccess: document.querySelector('#dashboard-success'),
  dashboardErrors: document.querySelector('#dashboard-errors'),
  dashboardSuccessRate: document.querySelector('#dashboard-success-rate'),
  dashboardBuckets: document.querySelector('#dashboard-buckets'),
  form: document.querySelector('#site-form'),
  siteId: document.querySelector('#site-id'),
  name: document.querySelector('#site-name'),
  baseUrl: document.querySelector('#site-base-url'),
  apiKey: document.querySelector('#site-api-key'),
  siteModelMappingEnabled: document.querySelector('#site-model-mapping-enabled'),
  siteModelMappingRows: document.querySelector('#site-model-mapping-rows'),
  addSiteModelMapping: document.querySelector('#add-site-model-mapping'),
  siteModelMapping: document.querySelector('#site-model-mapping'),
  priority: document.querySelector('#site-priority'),
  multiplier: document.querySelector('#site-multiplier'),
  customMultiplierEnabled: document.querySelector('#site-custom-multiplier-enabled'),
  customMultiplier: document.querySelector('#site-custom-multiplier'),
  accountMultiplier: document.querySelector('#site-account-multiplier'),
  effectiveMultiplier: document.querySelector('#site-effective-multiplier'),
  multiplierLocked: document.querySelector('#site-multiplier-locked'),
  remark: document.querySelector('#site-remark'),
  syncEnabled: document.querySelector('#site-sync-enabled'),
  syncAccount: document.querySelector('#site-sync-account'),
  syncAccountSummary: document.querySelector('#site-sync-account-summary'),
  syncDashboardUrl: document.querySelector('#site-sync-dashboard-url'),
  syncUsername: document.querySelector('#site-sync-username'),
  syncPassword: document.querySelector('#site-sync-password'),
  syncProviderType: document.querySelector('#site-sync-provider-type'),
  syncIntervalMode: document.querySelector('#site-sync-interval-mode'),
  syncIntervalValue: document.querySelector('#site-sync-interval-value'),
  syncIntervalUnit: document.querySelector('#site-sync-interval-unit'),
  createSiteKey: document.querySelector('#create-site-key'),
  syncSite: document.querySelector('#sync-site'),
  logoutSiteAccount: document.querySelector('#logout-site-account'),
  syncSummary: document.querySelector('#site-sync-summary'),
  syncBalance: document.querySelector('#site-sync-balance'),
  syncKeyName: document.querySelector('#site-sync-key-name'),
  syncKeyGroup: document.querySelector('#site-sync-key-group'),
  syncMultiplier: document.querySelector('#site-sync-multiplier'),
  syncLastAt: document.querySelector('#site-sync-last-at'),
  syncGroups: document.querySelector('#site-sync-groups'),
  syncGroupId: document.querySelector('#site-sync-group-id'),
  switchSyncGroupId: document.querySelector('#switch-site-sync-group-id'),
  capabilitySummary: document.querySelector('#site-capability-summary'),
  capabilityFeatures: document.querySelector('#site-capability-features'),
  capabilityModels: document.querySelector('#site-capability-models'),
  rateLimitEnabled: document.querySelector('#rate-limit-enabled'),
  rateLimitCount: document.querySelector('#rate-limit-count'),
  rateLimitWindowValue: document.querySelector('#rate-limit-window-value'),
  rateLimitWindowUnit: document.querySelector('#rate-limit-window-unit'),
  autoRecoveryEnabled: document.querySelector('#auto-recovery-enabled'),
  autoRecoveryIntervalValue: document.querySelector('#auto-recovery-interval-value'),
  autoRecoveryIntervalUnit: document.querySelector('#auto-recovery-interval-unit'),
  siteMonitoringEnabled: document.querySelector('#site-monitoring-enabled'),
  siteBalanceThreshold: document.querySelector('#site-balance-threshold'),
  siteMonitoringAccount: document.querySelector('#site-monitoring-account'),
  enabled: document.querySelector('#site-enabled'),
  resetForm: document.querySelector('#reset-form'),
  activeSiteName: document.querySelector('#active-site-name'),
  activeSiteStatus: document.querySelector('#active-site-status'),
  activeSiteUrl: document.querySelector('#active-site-url'),
  activeSiteMeta: document.querySelector('#active-site-meta'),
  topbarSyncGroups: document.querySelector('#topbar-sync-groups'),
  toggleTopbarSyncGroups: document.querySelector('#toggle-topbar-sync-groups'),
  refreshSiteSyncAll: document.querySelector('#refresh-site-sync-all'),
  clearSiteGroupFilter: document.querySelector('#clear-site-group-filter'),
  siteGroupPopover: document.querySelector('#site-group-popover'),
  siteGroupPopoverTitle: document.querySelector('#site-group-popover-title'),
  siteGroupPopoverMeta: document.querySelector('#site-group-popover-meta'),
  siteGroupPopoverClose: document.querySelector('#site-group-popover-close'),
  siteGroupPopoverViewSite: document.querySelector('#site-group-popover-view-site'),
  siteGroupPopoverFilter: document.querySelector('#site-group-popover-filter'),
  siteGroupPopoverSwitch: document.querySelector('#site-group-popover-switch'),
  unsavedChangesDialog: document.querySelector('#unsaved-changes-dialog'),
  unsavedChangesSave: document.querySelector('#unsaved-changes-save'),
  unsavedChangesDiscard: document.querySelector('#unsaved-changes-discard'),
  unsavedChangesCancel: document.querySelector('#unsaved-changes-cancel'),
  contextSiteName: document.querySelector('#context-site-name'),
  contextSiteStatus: document.querySelector('#context-site-status'),
  status: document.querySelector('#site-status'),
  errorLog: document.querySelector('#error-log'),
  errorLogSummary: document.querySelector('#error-log-summary'),
  routeTraceLog: document.querySelector('#route-trace-log'),
  routeTraceSummary: document.querySelector('#route-trace-summary'),
  activityMonitorSummary: document.querySelector('#activity-monitor-summary'),
  activityMonitorStatus: document.querySelector('#activity-monitor-status'),
  activityMonitorChecking: document.querySelector('#activity-monitor-checking'),
  activityMonitorLastCheck: document.querySelector('#activity-monitor-last-check'),
  activityMonitorNextCheck: document.querySelector('#activity-monitor-next-check'),
  activityMonitorCounts: document.querySelector('#activity-monitor-counts'),
  activityLogSummary: document.querySelector('#activity-log-summary'),
  activityCategoryFilter: document.querySelector('#activity-category-filter'),
  activityStatusFilter: document.querySelector('#activity-status-filter'),
  refreshActivityLogs: document.querySelector('#refresh-activity-logs'),
  clearActivityLogs: document.querySelector('#clear-activity-logs'),
  activityLogList: document.querySelector('#activity-log-list'),
  toast: document.querySelector('#toast')
};

const dashboardPeriodButtons = [
  ['hour', elements.dashboardPeriodHour],
  ['day', elements.dashboardPeriodDay],
  ['week', elements.dashboardPeriodWeek],
  ['month', elements.dashboardPeriodMonth]
];

const workspaceViewButtons = [
  ['sites', elements.navSites, elements.viewSites],
  ['strategy', elements.navStrategy, elements.viewStrategy],
  ['diagnostics', elements.navDiagnostics, elements.viewDiagnostics],
  ['activity', elements.navActivity, elements.viewActivity],
  ['settings', elements.navSettings, elements.viewSettings]
];

const siteTabButtons = [
  ['overview', elements.siteTabOverview, elements.siteTabOverviewPanel],
  ['basic', elements.siteTabBasic, elements.siteBasicPanel],
  ['sync', elements.siteTabSync, elements.siteSyncPanel],
  ['models', elements.siteTabModels, elements.siteModelsPanel],
  ['policy', elements.siteTabPolicy, elements.sitePolicyPanel]
];

const siteStatusFilterLabels = {
  all: '全部状态',
  enabled: '启用中',
  unavailable: '不可用',
  'manual-disabled': '人工停用',
  'failure-disabled': '错误停用',
  'rate-limited': '限速暂停'
};

const siteSortLabels = {
  default: '默认顺序',
  requests: '请求数多优先',
  'success-rate': '成功率高优先',
  balance: '余额高优先',
  multiplier: '实际倍率低优先'
};

const capabilityLabels = {
  textGeneration: '文本',
  imageGeneration: '生图',
  embeddings: '向量',
  audioTranscription: '转录',
  audioSpeech: '语音',
  vision: '视觉',
  reasoning: '推理',
  toolCalling: '工具',
  moderation: '审核',
  rerank: '重排'
};

const capabilityOrder = Object.keys(capabilityLabels);

installGlobalErrorHandlers();

async function init() {
  mountConsoleLayout();
  [state, monitoringTaskStatus, activityLogs] = await Promise.all([
    api.getState(),
    loadMonitoringTaskStatus(),
    loadActivityLogs()
  ]);
  selectedSiteId = state.activeSiteId ?? state.sites[0]?.id ?? null;
  visibleLocalApiKey = state.localApiKey ?? '';
  selectedSiteTab = 'overview';
  render();
  setInterval(() => {
    if (state) {
      renderDashboard();
      renderSiteList();
      renderActiveSite();
      renderTopbarSyncGroups();
      renderOverview(getSelectedSite());
      renderStatus(getSelectedSite());
      renderRouteTraces();
      renderActivityView();
    }
  }, 60_000);
  api.onStateChanged((nextState) => applyState(nextState, { preserveDirtyEditor: true }));
  api.onSiteChanged?.((patch) => applySitePatch(patch));
  api.onRouteTraceChanged?.((trace) => applyRouteTracePatch(trace));
  api.onActivityLogChanged?.(() => {
    refreshActivityLogs().catch(() => {});
  });
}

async function loadActivityLogs() {
  if (typeof api.listActivityLogs !== 'function') {
    return [];
  }
  const entries = await api.listActivityLogs({ limit: 200 });
  return Array.isArray(entries) ? entries : [];
}

async function loadMonitoringTaskStatus() {
  if (typeof api.getMonitoringTaskStatus !== 'function') {
    return null;
  }
  try {
    return await api.getMonitoringTaskStatus();
  } catch {
    return null;
  }
}

async function refreshActivityLogs() {
  activityLogs = await loadActivityLogs();
  renderActivityView();
}

function applyState(nextState, { preserveDirtyEditor = false } = {}) {
  const preserveEditor =
    preserveDirtyEditor &&
    shouldPreserveEditorOnStateChange({
      formDirty,
      editorHasFocus: isSiteEditorFocused(),
      selectedSiteId,
      nextSites: nextState.sites
    });
  const preserveProxyControls = isProxyControlFocused();

  state = nextState;
  if (selectedSiteId && !state.sites.some((site) => site.id === selectedSiteId) && !preserveEditor) {
    selectedSiteId = state.activeSiteId ?? state.sites[0]?.id ?? null;
  }
  render({ preserveEditor, preserveProxyControls });
}

function applySitePatch(patch = {}) {
  if (!state || !patch.site?.id) {
    return;
  }

  const index = state.sites.findIndex((site) => site.id === patch.site.id);
  if (index === -1) {
    return;
  }

  state = {
    ...state,
    ...(patch.proxyStatus ? { proxyStatus: patch.proxyStatus } : {}),
    ...(Object.hasOwn(patch, 'activeSiteId') ? { activeSiteId: patch.activeSiteId } : {}),
    sites: state.sites.map((site, siteIndex) => (siteIndex === index ? patch.site : site))
  };

  const preserveEditor = shouldPreserveEditorOnStateChange({
    formDirty,
    editorHasFocus: isSiteEditorFocused(),
    selectedSiteId,
    nextSites: state.sites
  });

  renderProxy({ preserveControls: isProxyControlFocused() });
  renderDashboard();
  renderSiteList();
  renderActiveSite();
  renderTopbarSyncGroups();
  renderSiteGroupPopover();
  renderRouteTraces();
  renderInspectorRoutes();

  const selectedSite = getSelectedSite();
  if (preserveEditor) {
    renderOverview(selectedSite);
    renderStatus(selectedSite);
    renderErrorLog(selectedSite);
  } else {
    renderEditor();
  }
}

function applyRouteTracePatch(trace) {
  if (!state || !trace?.id) {
    return;
  }

  const current = Array.isArray(state.recentRouteTraces) ? state.recentRouteTraces : [];
  state = {
    ...state,
    recentRouteTraces: [
      trace,
      ...current.filter((entry) => entry.id !== trace.id)
    ].slice(0, 50)
  };
  renderRouteTraces();
  renderInspectorRoutes();
}

function render({ preserveEditor = false, preserveProxyControls = false } = {}) {
  renderWorkspaceView();
  renderSiteTabs();
  renderSiteInspector();
  renderProxy({ preserveControls: preserveProxyControls });
  renderDashboard();
  renderSiteList();
  renderActiveSite();
  renderTopbarSyncGroups();
  renderRouteTraces();
  renderInspectorRoutes();
  renderActivityView();
  if (preserveEditor) {
    const site = getSelectedSite();
    renderOverview(site);
    renderStatus(site);
    renderErrorLog(site);
  } else {
    renderEditor();
  }
}

function setWorkspaceView(view) {
  selectedWorkspaceView = normalizeWorkspaceView(view);
}

function switchWorkspaceView(view) {
  const nextView = normalizeWorkspaceView(view);
  if (nextView === selectedWorkspaceView) {
    return;
  }
  requestEditorNavigation(() => {
    setWorkspaceView(nextView);
    renderWorkspaceView();
  });
}

function renderWorkspaceView() {
  for (const [view, button, section] of workspaceViewButtons) {
    const active = view === selectedWorkspaceView;
    button.className = active ? 'active' : '';
    button.setAttribute('aria-current', active ? 'page' : 'false');
    section.hidden = !active;
  }
}

function normalizeWorkspaceView(view) {
  return workspaceViewButtons.some(([candidate]) => candidate === view) ? view : 'sites';
}

function mountConsoleLayout() {
  elements.siteTabOverviewPanel.append(elements.siteOverview, elements.requestDashboard);
  elements.sidebarGroupHost.append(elements.overviewSyncGroups);
  document.body.append(elements.siteGroupPopover);
  elements.inspectorStatusHost.append(elements.statusPanel);
  elements.inspectorErrorHost.append(elements.errorLogPanel);
  elements.legacyOverviewSource.hidden = true;
}

function renderSiteTabs() {
  selectedSiteTab = siteTabButtons.some(([tab]) => tab === selectedSiteTab)
    ? selectedSiteTab
    : 'overview';
  for (const [tab, button, panel] of siteTabButtons) {
    const active = tab === selectedSiteTab;
    button.className = active ? 'active' : '';
    button.setAttribute('aria-selected', String(active));
    panel.hidden = !active;
  }
  elements.formActions.hidden = selectedSiteTab === 'overview';
}

function renderSiteInspector() {
  elements.siteInspector.className = [
    'context-panel',
    'site-inspector',
    siteInspectorOpen ? 'is-open' : ''
  ].filter(Boolean).join(' ');
  elements.toggleSiteInspector.setAttribute('aria-expanded', String(siteInspectorOpen));
}

function renderProxy({ preserveControls = false } = {}) {
  if (!preserveControls) {
    elements.proxyPort.value = state.proxy.port;
    elements.allowLanAccess.checked = Boolean(state.proxy.allowLanAccess);
    elements.proxyTimeoutSeconds.value = Math.round((state.proxy.timeoutMs ?? 120000) / 1000);
    elements.proxyReplayBufferMb.value = toReplayBufferMegabytes(
      state.proxy.maxReplayableRequestBodyBytes
    );
    elements.codexRecoveryEnabled.checked = Boolean(state.proxy.codexRecoveryEnabled);
    elements.failureThreshold.value = state.proxy.failureThreshold;
    elements.globalTestModel.value = state.proxy.testModel ?? 'example-chat-model';
    elements.smartSwitch.checked = Boolean(state.proxy.smartSwitching);
    elements.smartSwitching.checked = Boolean(state.proxy.smartSwitching);
    elements.priorityMode.value = state.proxy.priorityMode ?? 'priority';
    elements.samePriorityStrategy.value = state.proxy.samePriorityStrategy ?? 'round-robin';
    elements.autoSwitchMultiplierLimitEnabled.checked =
      Boolean(state.proxy.autoSwitchMultiplierLimit?.enabled);
    elements.autoSwitchMaxMultiplier.value = state.proxy.autoSwitchMultiplierLimit?.maxMultiplier ?? 1;
    elements.floatingAlwaysOnTop.checked = Boolean(state.appSettings?.floatingWindow?.alwaysOnTop);
    elements.globalModelMappingEnabled.checked = state.modelMapping?.enabled ?? false;
    renderModelMappingEditor({
      rowsElement: elements.globalModelMappingRows,
      textElement: elements.globalModelMapping,
      modelMapping: state.modelMapping
    });
    renderSiteSyncSettings();
    renderMonitoringSettings();
    renderConfigTransfer();
  }
  elements.localApiKey.value = visibleLocalApiKey || '已配置；如已遗失请重新生成';
  elements.localApiKey.type = visibleLocalApiKey ? 'text' : 'password';
  elements.copyLocalApiKey.disabled = !visibleLocalApiKey;
  elements.localApiKeyNote.textContent = visibleLocalApiKey
    ? '这是唯一一次明文显示，请立即复制保存；刷新或关闭窗口后不再展示。'
    : '密钥明文只显示一次；重新生成后，旧密钥立即失效。';
  elements.configPath.textContent = `配置文件：${state.configPath}`;

  const running = state.proxyStatus.running;
  const port = state.proxyStatus.port ?? state.proxy.port;
  const proxyError = state.proxyStatus.error;
  elements.proxyEndpointLabel.textContent = state.proxy.allowLanAccess ? '局域网代理' : '本机代理';
  elements.proxyUrl.textContent = formatProxyAccessUrl(state.proxyAccessUrls?.[0], port);
  elements.proxyStatus.textContent = running ? '运行中' : '未运行';
  elements.proxyStatus.className = `status-pill ${running ? 'success' : 'error'}`;
  elements.proxyError.textContent = proxyError ? formatProxyError(proxyError, state.proxy.port) : '';
  elements.proxyError.hidden = !proxyError;
}

function formatProxyAccessUrl(accessUrl, port) {
  if (!accessUrl) {
    return `http://127.0.0.1:${port}/v1`;
  }
  try {
    const url = new URL(accessUrl);
    url.port = String(port);
    return url.toString().replace(/\/$/, '');
  } catch {
    return `http://127.0.0.1:${port}/v1`;
  }
}

function renderSiteSyncSettings() {
  const settings = state.siteSync ?? {};
  const groupSettings = state.groupSync ?? {};
  elements.siteSyncGlobalIntervalValue.value = settings.intervalValue ?? 30;
  elements.siteSyncGlobalIntervalUnit.value = settings.intervalUnit ?? 'minute';
  elements.siteSyncIntelligentScheduling.checked = settings.intelligentScheduling ?? true;
  elements.groupSyncIntervalValue.value = groupSettings.intervalValue ?? 30;
  elements.groupSyncIntervalUnit.value = groupSettings.intervalUnit ?? 'minute';
}

function renderMonitoringSettings() {
  const monitoring = state.monitoring ?? {};
  const notifications = monitoring.notifications ?? {};
  elements.monitoringEnabled.checked = Boolean(monitoring.enabled);
  elements.feishuWebhook.value = monitoring.feishuWebhook ?? '';
  elements.monitoringMultiplierChanged.checked = notifications.multiplierChanged ?? true;
  elements.monitoringLowBalance.checked = notifications.lowBalance ?? true;
  elements.monitoringNoUsableSite.checked = notifications.noUsableSite ?? true;
  elements.monitoringProgramIssues.checked = notifications.programIssues ?? true;
  elements.monitoringAnswerCompleted.checked = notifications.answerCompleted ?? false;
  elements.monitoringGoalStatusChanged.checked = notifications.goalStatusChanged ?? false;
  elements.noUsableSiteDelayMinutes.value = monitoring.noUsableSiteDelayMinutes ?? 5;
  elements.noUsableSiteDelayMinutes.disabled = !elements.monitoringNoUsableSite.checked;
  const enabledCount = [
    elements.monitoringMultiplierChanged,
    elements.monitoringLowBalance,
    elements.monitoringNoUsableSite,
    elements.monitoringProgramIssues,
    elements.monitoringAnswerCompleted,
    elements.monitoringGoalStatusChanged
  ].filter((element) => element.checked).length;
  elements.monitoringSummary.textContent = [
    monitoring.enabled ? '监控已启用' : '监控未启用',
    monitoring.feishuWebhook ? 'Webhook 已配置' : 'Webhook 未配置',
    `已启用 ${enabledCount}/6 项通知`,
    formatMonitoringTaskStatus(),
    '持续异常每 30 分钟提醒'
  ].join(' · ');
  elements.installMonitoringTask.disabled =
    typeof api.installMonitoringTask !== 'function' || monitoringTaskStatus?.supported === false;
  elements.removeMonitoringTask.disabled =
    typeof api.removeMonitoringTask !== 'function' || !monitoringTaskStatus?.installed;
}

function readMonitoringSettingsFormPayload() {
  return {
    enabled: elements.monitoringEnabled.checked,
    feishuWebhook: elements.feishuWebhook.value.trim(),
    noUsableSiteDelayMinutes: Number(elements.noUsableSiteDelayMinutes.value || 5),
    notifications: {
      multiplierChanged: elements.monitoringMultiplierChanged.checked,
      lowBalance: elements.monitoringLowBalance.checked,
      noUsableSite: elements.monitoringNoUsableSite.checked,
      programIssues: elements.monitoringProgramIssues.checked,
      answerCompleted: elements.monitoringAnswerCompleted.checked,
      goalStatusChanged: elements.monitoringGoalStatusChanged.checked
    }
  };
}

function formatMonitoringTaskStatus() {
  if (!monitoringTaskStatus) {
    return '后台任务状态未知';
  }
  if (!monitoringTaskStatus.supported) {
    return '当前系统不支持后台任务';
  }
  if (monitoringTaskStatus.running) {
    return '后台任务运行中';
  }
  return monitoringTaskStatus.installed ? '后台任务已安装但未运行' : '后台任务未安装';
}

function renderConfigTransfer() {
  if (!configTransferDefaultsApplied) {
    elements.configExportGlobalSettings.checked = true;
    elements.configImportGlobalSettings.checked = true;
    configTransferDefaultsApplied = true;
  }
  renderExportSitePicker();
  renderImportPreview();
}

function renderExportSitePicker() {
  const exportMode = normalizeConfigExportMode(elements.configExportMode.value);
  const previousCheckedIds = new Set(readCheckedConfigSiteIds(elements.configExportSelectedSites));
  const shouldDefaultChecked = !hasConfigSiteOptions(elements.configExportSelectedSites);

  elements.configExportMode.value = exportMode;
  elements.configExportSelectedSites.hidden = exportMode !== 'selected';

  if (state.sites.length === 0) {
    elements.configExportSelectedSites.innerHTML = '<div class="empty">暂无站点可选。</div>';
    return;
  }

  replaceChildren(
    elements.configExportSelectedSites,
    state.sites.map((site) =>
      createConfigSiteOption({
        id: site.id,
        name: site.name,
        meta: `${site.baseUrl || '-'} · 优先级 ${site.priority ?? 100} · 实际倍率 ${formatEffectiveMultiplier(site)}`,
        checked: shouldDefaultChecked || previousCheckedIds.has(site.id)
      })
    )
  );
}

function renderImportPreview() {
  if (!pendingImportPreview?.preview) {
    elements.configImportPreview.hidden = true;
    elements.applyImportConfig.disabled = true;
    elements.configImportSummary.textContent = '';
    elements.configImportSites.innerHTML = '';
    return;
  }

  const preview = pendingImportPreview.preview;
  const sites = preview.sites ?? [];
  const previousCheckedIds = new Set(readCheckedConfigSiteIds(elements.configImportSites));
  const shouldDefaultChecked = !hasConfigSiteOptions(elements.configImportSites);
  const previousGlobalChecked = elements.configImportGlobalSettings.checked;

  elements.configImportPreview.hidden = false;
  elements.applyImportConfig.disabled = false;
  elements.configImportSummary.textContent = `${sites.length} 个站点 · ` +
    (preview.hasGlobalSettings ? '包含全局设置' : '不包含全局设置');
  elements.configImportGlobalSettings.disabled = !preview.hasGlobalSettings;
  elements.configImportGlobalSettings.checked = preview.hasGlobalSettings && previousGlobalChecked;

  if (sites.length === 0) {
    elements.configImportSites.innerHTML = '<div class="empty">导入文件中没有站点配置。</div>';
    return;
  }

  replaceChildren(
    elements.configImportSites,
    sites.map((site) =>
      createConfigSiteOption({
        id: site.sourceId,
        name: site.name,
        meta: `${site.baseUrl || '-'} · 优先级 ${site.priority ?? 100} · 实际倍率 ${formatEffectiveMultiplier(site)}`,
        checked: shouldDefaultChecked || previousCheckedIds.has(site.sourceId)
      })
    )
  );
}

function createConfigSiteOption({ id, name, meta, checked }) {
  const label = document.createElement('label');
  label.className = 'config-site-option';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.dataset.siteId = id;

  const content = document.createElement('span');
  content.textContent = `${name || '未命名站点'} · ${meta || '-'}`;

  label.append(input, content);
  return label;
}

function renderDashboard() {
  const selectedSite = getSelectedSite();
  const dashboard = buildRequestDashboard(
    selectedSite ? [selectedSite] : [],
    selectedDashboardPeriod
  );
  const visibleBuckets = dashboard.buckets.slice(-12);
  const maxRequestCount = Math.max(...visibleBuckets.map((bucket) => bucket.requestCount), 1);

  elements.dashboardRequests.textContent = String(dashboard.summary.requestCount);
  elements.dashboardSuccess.textContent = String(dashboard.summary.successCount);
  elements.dashboardErrors.textContent = String(dashboard.summary.errorCount);
  elements.dashboardSuccessRate.textContent = formatSuccessRate(dashboard.summary.successRate);

  for (const [period, button] of dashboardPeriodButtons) {
    button.className = period === selectedDashboardPeriod ? 'active' : '';
    button.setAttribute?.('aria-pressed', period === selectedDashboardPeriod ? 'true' : 'false');
  }

  if (dashboard.buckets.length === 0) {
    elements.dashboardBuckets.innerHTML = '<div class="empty">暂无请求统计。</div>';
    return;
  }

  const columnsHtml = visibleBuckets
    .map((bucket) => {
      const columnHeight = Math.max((bucket.requestCount / maxRequestCount) * 100, 3);
      const successHeight =
        bucket.requestCount > 0 ? (bucket.successCount / bucket.requestCount) * 100 : 0;
      const errorHeight =
        bucket.requestCount > 0 ? (bucket.errorCount / bucket.requestCount) * 100 : 0;
      const label = formatDashboardBucketLabel(bucket, selectedDashboardPeriod);
      const summary =
        `${bucket.requestCount} 次 · 成功 ${bucket.successCount} · ` +
        `失败 ${bucket.errorCount} · ${formatSuccessRate(bucket.successRate)}`;
      return `
        <div class="dashboard-column" title="${escapeHtml(label)} · ${escapeHtml(summary)}">
          <span class="dashboard-column-count">${bucket.requestCount}</span>
          <span class="dashboard-column-track" aria-hidden="true">
            <span class="dashboard-column-stack" style="height: ${columnHeight}%">
              <span class="dashboard-column-success" style="height: ${successHeight}%"></span>
              <span class="dashboard-column-error" style="height: ${errorHeight}%"></span>
            </span>
          </span>
          <span class="dashboard-column-label">${escapeHtml(label)}</span>
          <span class="dashboard-column-rate">${formatSuccessRate(bucket.successRate)}</span>
        </div>
      `;
    })
    .join('');

  elements.dashboardBuckets.innerHTML = `
    <div class="dashboard-chart" role="img" aria-label="按时间段展示请求成功和失败柱状图">
      ${columnsHtml}
    </div>
  `;
}

function renderSiteList() {
  if (selectedGroupFilterKey && !state.sites.some((site) => getSiteGroupFilterKey(site) === selectedGroupFilterKey)) {
    selectedGroupFilterKey = null;
  }

  const siteSummary = summarizeSites(state.sites);
  const siteStatusFilter = normalizeSiteStatusFilter(selectedSiteStatusFilter);
  const siteSort = normalizeSiteSort(selectedSiteSort);
  const groupFilteredSites = filterSitesByGroupSite(state.sites, selectedGroupFilterKey);
  const filteredSites = filterSitesByAvailability(groupFilteredSites, siteStatusFilter);
  const sortedSites = sortSitesForList(filteredSites, siteSort);
  const existingItems = new Map(
    getElementChildren(elements.siteList)
      .filter((child) => child.dataset?.id)
      .map((child) => [child.dataset.id, child])
  );
  elements.siteStatusFilter.value = siteStatusFilter;
  elements.siteSort.value = siteSort;
  elements.siteListSummary.textContent =
    formatSiteListSummary(state.sites, filteredSites, siteStatusFilter, siteSummary);

  if (state.sites.length === 0) {
    elements.siteList.innerHTML = '<div class="empty">还没有 API 站点配置。</div>';
    return;
  }

  if (filteredSites.length === 0) {
    elements.siteList.innerHTML = '<div class="empty">当前状态筛选下没有站点。</div>';
    return;
  }

  replaceChildren(
    elements.siteList,
    sortedSites.map((site) => renderSiteListItem(existingItems.get(site.id), site))
  );
}

function renderSiteListItem(item = document.createElement('div'), site) {
  item.className = [
    'site-item',
    site.id === selectedSiteId ? 'active' : '',
    getLastRequestBorderClass(site)
  ].filter(Boolean).join(' ');
  item.dataset.id = site.id;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'site-main';

  const text = document.createElement('div');
  const successRate = calculateSuccessRate(site.successCount, site.errorCount);
  const isCurrent = site.id === state.activeSiteId;
  text.innerHTML = `
    <div class="site-title-line">
      <h3>${escapeHtml(site.name)}</h3>
      ${isCurrent ? '<span class="current-mark">当前</span>' : ''}
    </div>
    <div class="site-highlight-row">
      ${renderBalanceBadge(site)}
      ${renderMultiplierBadge(site)}
    </div>
    <div class="site-metrics">
      <span>优先级 ${site.priority ?? 100}</span>
      <span>请求 ${site.requestCount}</span>
      <span>成功率 ${formatSuccessRate(successRate)}</span>
      <span>上次 ${formatLastRequestText(site.lastRequestAt)}</span>
    </div>
  `;

  const status = document.createElement('span');
  status.className = `status-pill ${availabilityClass(site)}`;
  status.textContent = formatAvailabilityLabel(site);

  main.append(text, status);
  main.addEventListener('click', () => {
    requestEditorNavigation(() => {
      selectedSiteId = site.id;
      setWorkspaceView('sites');
      render();
    });
  });

  const actions = document.createElement('div');
  actions.className = 'site-actions';

  const testButton = document.createElement('button');
  testButton.type = 'button';
  testButton.className = 'secondary test-site-action';
  testButton.textContent = '测试';
  testButton.title = '测试该站点';
  testButton.addEventListener('click', async (event) => {
    event.stopPropagation?.();
    await testSiteFromList(site.id);
  });

  actions.append(testButton, renderSiteListAction(site));
  replaceChildren(item, [main, actions]);
  return item;
}

function renderSiteListAction(site) {
  if (state.proxy.smartSwitching) {
    const toggleAction = getSiteToggleAction(site);
    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className =
      toggleAction.nextManualEnabled ? 'manual-toggle' : 'secondary manual-toggle';
    toggleButton.textContent = toggleAction.label;
    toggleButton.title =
      toggleAction.nextManualEnabled ? '启用该站点' : '手动停用该站点';
    toggleButton.addEventListener('click', () =>
      toggleSiteById(site.id, toggleAction.nextManualEnabled)
    );
    return toggleButton;
  }

  const selected = site.id === state.activeSiteId;
  const available = getAvailabilityState(site) === 'enabled';
  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = selected || !available ? 'secondary manual-select' : 'manual-select';
  selectButton.textContent = selected ? '已选择' : '选择';
  selectButton.disabled = selected || !available;
  selectButton.title = selected
    ? '当前手动选择的站点'
    : available
      ? '手动选择该站点用于后续请求'
      : '该站点当前不可用，不能选择';
  selectButton.addEventListener('click', () => selectSiteById(site.id));
  return selectButton;
}

function replaceChildren(element, children) {
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren(...children);
    return;
  }

  element.innerHTML = '';
  element.append(...children);
}

function getElementChildren(element) {
  return Array.from(element.children ?? []);
}

function isSiteEditorFocused() {
  const activeElement = document.activeElement;
  if (!isEditableControl(activeElement)) {
    return false;
  }

  return (
    isElementInTree(activeElement, elements.form) ||
    getSiteEditorControlRoots().some((root) => isElementInTree(activeElement, root))
  );
}

function isProxyControlFocused() {
  const activeElement = document.activeElement;
  if (!isEditableControl(activeElement)) {
    return false;
  }

  return getProxyControlRoots().some((root) => isElementInTree(activeElement, root));
}

function getSiteEditorControlRoots() {
  return [
    elements.siteId,
    elements.name,
    elements.baseUrl,
    elements.apiKey,
    elements.siteModelMappingEnabled,
    elements.siteModelMappingRows,
    elements.siteModelMapping,
    elements.priority,
    elements.multiplier,
    elements.customMultiplierEnabled,
    elements.customMultiplier,
    elements.multiplierLocked,
    elements.remark,
    elements.syncEnabled,
    elements.syncDashboardUrl,
    elements.syncUsername,
    elements.syncPassword,
    elements.syncProviderType,
    elements.syncIntervalMode,
    elements.syncIntervalValue,
    elements.syncIntervalUnit,
    elements.syncGroupId,
    elements.rateLimitEnabled,
    elements.rateLimitCount,
    elements.rateLimitWindowValue,
    elements.rateLimitWindowUnit,
    elements.autoRecoveryEnabled,
    elements.autoRecoveryIntervalValue,
    elements.autoRecoveryIntervalUnit,
    elements.siteMonitoringEnabled,
    elements.siteBalanceThreshold,
    elements.enabled
  ].filter(Boolean);
}

function getProxyControlRoots() {
  return [
    elements.proxyPort,
    elements.allowLanAccess,
    elements.proxyTimeoutSeconds,
    elements.proxyReplayBufferMb,
    elements.failureThreshold,
    elements.globalTestModel,
    elements.smartSwitching,
    elements.priorityMode,
    elements.samePriorityStrategy,
    elements.autoSwitchMultiplierLimitEnabled,
    elements.autoSwitchMaxMultiplier,
    elements.globalModelMappingEnabled,
    elements.globalModelMappingRows,
    elements.globalModelMapping,
    elements.siteSyncGlobalIntervalValue,
    elements.siteSyncGlobalIntervalUnit,
    elements.siteSyncIntelligentScheduling,
    elements.groupSyncIntervalValue,
    elements.groupSyncIntervalUnit,
    elements.monitoringEnabled,
    elements.feishuWebhook,
    elements.monitoringMultiplierChanged,
    elements.monitoringLowBalance,
    elements.monitoringNoUsableSite,
    elements.noUsableSiteDelayMinutes,
    elements.monitoringProgramIssues,
    elements.monitoringAnswerCompleted,
    elements.monitoringGoalStatusChanged,
    elements.configExportGlobalSettings,
    elements.configExportMode,
    elements.configExportSelectedSites,
    elements.configImportGlobalSettings,
    elements.configImportSites
  ].filter(Boolean);
}

function isEditableControl(element) {
  const tagName = element?.tagName?.toLowerCase?.();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    Boolean(element?.isContentEditable)
  );
}

function isElementInTree(element, root) {
  let current = element;
  while (current) {
    if (current === root) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function renderActiveSite() {
  const activeSite = getActiveSite();

  if (!activeSite) {
    elements.activeSiteName.textContent = '暂无当前站点';
    elements.activeSiteStatus.textContent = '-';
    elements.activeSiteStatus.className = 'status-pill idle';
    if (elements.activeSiteUrl) {
      elements.activeSiteUrl.textContent = '';
      elements.activeSiteUrl.hidden = true;
    }
    elements.activeSiteMeta.innerHTML = '<span>未选择可用站点</span>';
    return;
  }

  const successRate = calculateSuccessRate(activeSite.successCount, activeSite.errorCount);
  elements.activeSiteName.textContent = activeSite.name;
  elements.activeSiteStatus.textContent = formatAvailabilityLabel(activeSite);
  elements.activeSiteStatus.className = `status-pill ${availabilityClass(activeSite)}`;
  if (elements.activeSiteUrl) {
    elements.activeSiteUrl.textContent = '';
    elements.activeSiteUrl.hidden = true;
  }
  elements.activeSiteMeta.innerHTML = [
    renderBalanceBadge(activeSite),
    renderMultiplierBadge(activeSite),
    `<span>${escapeHtml(`优先级 ${activeSite.priority ?? 100}`)}</span>`,
    `<span>${escapeHtml(`请求 ${activeSite.requestCount ?? 0}`)}</span>`,
    `<span>${escapeHtml(`成功率 ${formatSuccessRate(successRate)}`)}</span>`,
    `<span>${escapeHtml(`上次 ${formatLastRequestText(activeSite.lastRequestAt)}`)}</span>`
  ].join('');
}

function renderTopbarSyncGroups() {
  const groups = buildTopSyncedGroups(state.sites, Number.POSITIVE_INFINITY);
  if (groups.length <= 3) {
    showAllTopbarSyncGroups = false;
  }
  const visibleGroups = showAllTopbarSyncGroups ? groups : groups.slice(0, 3);
  if (groups.length === 0) {
    elements.topbarSyncGroups.innerHTML = '<span class="sync-groups-empty">暂无分组</span>';
  } else {
    replaceChildren(
      elements.topbarSyncGroups,
      visibleGroups.map((entry) => renderTopbarSyncGroupButton(entry))
    );
  }
  elements.topbarSyncGroups.className = [
    'topbar-sync-groups',
    showAllTopbarSyncGroups ? 'expanded' : ''
  ].filter(Boolean).join(' ');

  elements.toggleTopbarSyncGroups.hidden = groups.length <= 3;
  elements.toggleTopbarSyncGroups.textContent = showAllTopbarSyncGroups
    ? `收起 ${groups.length} 个`
    : `展开 ${groups.length} 个`;

  const filteredSite = selectedGroupFilterKey
    ? state.sites.find((site) => getSiteGroupFilterKey(site) === selectedGroupFilterKey)
    : null;
  elements.clearSiteGroupFilter.hidden = !filteredSite;
  elements.clearSiteGroupFilter.textContent = filteredSite ? `清除 ${filteredSite.name}` : '清除筛选';
  if (selectedGroupAction) {
    groupPopoverAnchor = findGroupPopoverAnchor();
  }
}

function renderTopbarSyncGroupButton(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = [
    'sync-group-chip',
    'topbar-sync-group-chip',
    isSelectedGroupAction(entry) ? 'active' : '',
    selectedGroupFilterKey === entry.filterKey ? 'filtered' : ''
  ].filter(Boolean).join(' ');
  button.dataset.siteId = entry.site.id;
  button.dataset.filterKey = entry.filterKey;
  button.dataset.groupId = entry.group.id ?? '';
  button.dataset.groupName = entry.group.name;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', String(isSelectedGroupAction(entry)));
  button.setAttribute('aria-pressed', String(selectedGroupFilterKey === entry.filterKey));
  button.title = formatGroupTooltip(entry);
  button.textContent = formatGroupChipLabel(entry.group, entry.effectiveMultiplier);
  button.addEventListener('click', () => {
    selectedGroupAction = {
      siteId: entry.site.id,
      groupId: entry.group.id,
      groupName: entry.group.name,
      filterKey: entry.filterKey
    };
    renderTopbarSyncGroups();
    renderSiteGroupPopover();
    groupPopoverAnchor = findGroupPopoverAnchor();
    positionSiteGroupPopover(groupPopoverAnchor);
    elements.siteGroupPopoverClose.focus();
  });
  return button;
}

function findGroupPopoverAnchor() {
  if (!selectedGroupAction) {
    return null;
  }
  return [...elements.topbarSyncGroups.children].find((candidate) =>
    candidate.dataset.siteId === selectedGroupAction.siteId &&
      (
        (selectedGroupAction.groupId && candidate.dataset.groupId === selectedGroupAction.groupId) ||
        candidate.dataset.groupName === selectedGroupAction.groupName
      )
  ) ?? null;
}

function isSelectedGroupAction(entry) {
  return Boolean(
    selectedGroupAction &&
      selectedGroupAction.siteId === entry.site.id &&
      selectedGroupAction.groupName === entry.group.name
  );
}

function resolveSelectedGroupAction() {
  if (!selectedGroupAction) {
    return null;
  }
  const site = state.sites.find((candidate) => candidate.id === selectedGroupAction.siteId);
  if (!site) {
    return null;
  }
  const groups = normalizeRemoteGroups(site.sync?.remote?.groups);
  const group = groups.find((candidate) =>
    (selectedGroupAction.groupId && candidate.id === selectedGroupAction.groupId) ||
    candidate.name === selectedGroupAction.groupName
  );
  if (!group) {
    return null;
  }
  return {
    site,
    group,
    filterKey: selectedGroupAction.filterKey || getSiteGroupFilterKey(site),
    effectiveMultiplier: calculateEffectiveGroupMultiplier(site, group)
  };
}

function renderSiteGroupPopover() {
  const entry = resolveSelectedGroupAction();
  if (!entry) {
    selectedGroupAction = null;
    elements.siteGroupPopover.hidden = true;
    return;
  }

  const remote = entry.site.sync?.remote ?? {};
  elements.siteGroupPopover.hidden = false;
  elements.siteGroupPopoverTitle.textContent =
    `${entry.group.name} · ${formatGroupMultiplierText(entry.effectiveMultiplier)}`;
  elements.siteGroupPopoverMeta.innerHTML = [
    ['关联站点', entry.site.name],
    ['账户余额', remote.balance || '-'],
    ['远端倍率', formatGroupMultiplierText(entry.group.multiplier)],
    ['实际倍率', formatGroupMultiplierText(entry.effectiveMultiplier)],
    ['当前远端分组', remote.keyGroup || '-']
  ].map(([label, value]) => `
    <div class="group-popover-meta-row">
      <span>${escapeHtml(String(label))}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `).join('');
  elements.siteGroupPopoverSwitch.disabled = Boolean(entry.group.selected);
  elements.siteGroupPopoverSwitch.textContent = entry.group.selected ? '当前分组' : '切换分组';
  positionSiteGroupPopover(groupPopoverAnchor);
}

function positionSiteGroupPopover(anchor = groupPopoverAnchor) {
  if (elements.siteGroupPopover.hidden || !anchor?.getBoundingClientRect) {
    return;
  }

  const anchorRect = anchor.getBoundingClientRect();
  const viewportPadding = 14;
  const gap = 12;
  const popoverWidth = elements.siteGroupPopover.offsetWidth || 348;
  const popoverHeight = elements.siteGroupPopover.offsetHeight || 260;
  const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  let left = anchorRect.right + gap;
  let top = anchorRect.top;

  if (left + popoverWidth > viewportWidth - viewportPadding) {
    left = anchorRect.left - popoverWidth - gap;
  }
  if (left < viewportPadding) {
    left = Math.max(viewportPadding, viewportWidth - popoverWidth - viewportPadding);
  }
  if (top + popoverHeight > viewportHeight - viewportPadding) {
    top = viewportHeight - popoverHeight - viewportPadding;
  }

  elements.siteGroupPopover.style.left = `${Math.round(Math.max(viewportPadding, left))}px`;
  elements.siteGroupPopover.style.top = `${Math.round(Math.max(viewportPadding, top))}px`;
}

function closeSiteGroupPopover() {
  selectedGroupAction = null;
  groupPopoverAnchor = null;
  elements.siteGroupPopover.hidden = true;
  renderTopbarSyncGroups();
  elements.topbarSyncGroups.focus?.();
}

function requestEditorNavigation(action) {
  if (!formDirty) {
    action();
    return;
  }
  pendingEditorNavigation = action;
  elements.unsavedChangesDialog.hidden = false;
  if (typeof elements.unsavedChangesDialog.showModal === 'function' && !elements.unsavedChangesDialog.open) {
    elements.unsavedChangesDialog.showModal();
  }
}

function closeUnsavedChangesDialog() {
  if (typeof elements.unsavedChangesDialog.close === 'function' && elements.unsavedChangesDialog.open) {
    elements.unsavedChangesDialog.close();
  }
  elements.unsavedChangesDialog.hidden = true;
}

function cancelEditorNavigation() {
  pendingEditorNavigation = null;
  closeUnsavedChangesDialog();
}

function continueEditorNavigation() {
  const action = pendingEditorNavigation;
  pendingEditorNavigation = null;
  closeUnsavedChangesDialog();
  action?.();
}

async function persistSiteEditor() {
  const payload = readSiteFormPayload(getSelectedSite());
  const id = elements.siteId.value;
  state = id ? await api.updateSite(id, payload) : await api.addSite(payload);
  selectedSiteId = id || state.sites.at(-1)?.id || state.activeSiteId;
  if (typeof api.updateMonitoringRule === 'function') {
    state = await api.updateMonitoringRule(selectedSiteId, readMonitoringRuleFormPayload());
  }
  formDirty = false;
  return selectedSiteId;
}

function readMonitoringRuleFormPayload() {
  const threshold = elements.siteBalanceThreshold.value.trim();
  return {
    enabled: elements.siteMonitoringEnabled.checked,
    balanceThreshold: threshold === '' ? null : Number(threshold)
  };
}

function renderEditor() {
  const site = getSelectedSite();
  const hasSite = Boolean(site);

  elements.editorTitle.textContent = site ? site.name : '新增站点';
  elements.editorSubtitle.textContent = site
    ? `${site.baseUrl} · ${formatAvailabilityLabel(site)}`
    : '配置 OpenAI 兼容上游站点';
  elements.siteId.value = site?.id ?? '';
  elements.name.value = site?.name ?? '';
  elements.baseUrl.value = site?.baseUrl ?? '';
  elements.apiKey.value = site?.apiKey ?? '';
  elements.apiKey.type = 'password';
  elements.siteModelMappingEnabled.checked = site?.modelMapping?.enabled ?? false;
  renderModelMappingEditor({
    rowsElement: elements.siteModelMappingRows,
    textElement: elements.siteModelMapping,
    modelMapping: site?.modelMapping
  });
  elements.priority.value = site?.priority ?? 100;
  elements.multiplier.value = site?.multiplier ?? 1;
  elements.customMultiplierEnabled.checked = site?.customMultiplier !== null && site?.customMultiplier !== undefined;
  elements.customMultiplier.value = site?.customMultiplier ?? 1;
  elements.multiplierLocked.checked = site?.multiplierLocked ?? false;
  elements.remark.value = site?.remark ?? '';
  elements.syncEnabled.checked = site?.sync?.enabled ?? false;
  renderRemoteAccountSelector(site);
  elements.syncDashboardUrl.value = site?.sync?.dashboardUrl ?? '';
  elements.syncUsername.value = site?.sync?.username ?? '';
  elements.syncPassword.value = site?.sync?.password ?? '';
  elements.syncProviderType.value = site?.sync?.providerType ?? 'auto';
  elements.syncIntervalMode.value = site?.sync?.intervalMode ?? 'global';
  elements.syncIntervalValue.value = site?.sync?.intervalValue ?? 30;
  elements.syncIntervalUnit.value = site?.sync?.intervalUnit ?? 'minute';
  updateSyncIntervalModeState();
  elements.createSiteKey.disabled = !hasSite;
  elements.syncSite.disabled = !hasSite;
  renderSyncRemote(site?.sync);
  renderCapabilities(site?.capabilities);
  elements.rateLimitEnabled.checked = site?.rateLimit?.enabled ?? false;
  elements.rateLimitCount.value = site?.rateLimit?.limit ?? 60;
  elements.rateLimitWindowValue.value = site?.rateLimit?.windowValue ?? 1;
  elements.rateLimitWindowUnit.value = site?.rateLimit?.windowUnit ?? 'minute';
  elements.autoRecoveryEnabled.checked = site?.autoRecovery?.enabled ?? false;
  elements.autoRecoveryIntervalValue.value = site?.autoRecovery?.intervalValue ?? 1;
  elements.autoRecoveryIntervalUnit.value = site?.autoRecovery?.intervalUnit ?? 'minute';
  renderSiteMonitoring(site);
  elements.enabled.checked = site?.manualEnabled ?? site?.enabled ?? true;
  updateCustomMultiplierState();
  renderMultiplierPreview(site);

  renderSetActiveAction(site);
  elements.testSite.disabled = !hasSite;
  elements.detectSiteCapabilities.disabled = !hasSite;
  elements.toggleSelectedSite.disabled = !hasSite;
  if (hasSite) {
    const toggleAction = getSiteToggleAction(site);
    elements.toggleSelectedSite.textContent = toggleAction.label;
    elements.toggleSelectedSite.className =
      toggleAction.nextManualEnabled ? '' : 'secondary';
    elements.toggleSelectedSite.title =
      toggleAction.nextManualEnabled ? '启用当前站点' : '手动停用当前站点';
  } else {
    elements.toggleSelectedSite.textContent = '停用';
    elements.toggleSelectedSite.className = 'secondary';
    elements.toggleSelectedSite.title = '';
  }
  elements.cloneSite.disabled = !hasSite;
  elements.deleteSite.disabled = !hasSite;

  renderOverview(site);
  renderStatus(site);
  renderErrorLog(site);
}

function renderSiteMonitoring(site) {
  const accountId = String(site?.sync?.accountId ?? '');
  const rule = getMonitoringRule(accountId);
  const enabled = rule?.enabled ?? true;
  elements.siteMonitoringEnabled.checked = enabled;
  elements.siteMonitoringEnabled.disabled = !site || !accountId;
  elements.siteBalanceThreshold.value = rule?.balanceThreshold ?? '';
  elements.siteBalanceThreshold.disabled = !site || !accountId || !site.sync?.enabled || !enabled;
  elements.siteMonitoringAccount.textContent = !site
    ? '保存站点后可配置余额提醒'
    : accountId && site.sync?.enabled
      ? `当前账号：${site.sync?.username || accountId}（同账号关联站点共用此配置）`
      : accountId
        ? '当前站点未启用账号同步，余额提醒暂不可用'
        : '当前站点未关联远端账号，余额提醒暂不可用';
}

function getMonitoringRule(accountId) {
  return state.monitoring?.rules?.find((candidate) =>
    String(candidate.accountId ?? '') === String(accountId ?? '')
  );
}

function renderRemoteAccountSelector(site) {
  const accounts = Array.isArray(state.remoteAccounts) ? state.remoteAccounts : [];
  const options = [createSelectOption('', '新账号')];
  for (const account of accounts) {
    const label = [account.username || '未命名账号', formatAccountWebsite(account.dashboardUrl)]
      .filter(Boolean)
      .join(' · ');
    options.push(createSelectOption(account.id, label));
  }
  replaceChildren(elements.syncAccount, options);
  elements.syncAccount.value = site?.sync?.accountId ?? '';

  const account = accounts.find((candidate) => candidate.id === site?.sync?.accountId);
  if (!account) {
    elements.syncAccountSummary.textContent = site
      ? '保存后可在多个站点间共享登录配置'
      : '请先保存站点，再启用远端账号';
    elements.logoutSiteAccount.disabled = true;
    return;
  }
  elements.syncAccountSummary.textContent = [
    `关联 ${account.linkedSiteCount ?? 1} 个站点`,
    account.hasSession ? '凭证已保存' : '当前未登录',
    account.lastLoginAt ? `登录 ${formatLocalDateTime(account.lastLoginAt)}` : null
  ].filter(Boolean).join(' · ');
  elements.logoutSiteAccount.disabled = !account.hasSession;
}

function createSelectOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function formatAccountWebsite(value) {
  try {
    return new URL(value).host;
  } catch {
    return String(value ?? '').trim();
  }
}

function getRemoteAccountSync(accountId) {
  return state.sites.find((site) => site.sync?.accountId === accountId)?.sync ?? null;
}

function renderSetActiveAction(site) {
  const hasSite = Boolean(site);
  const automaticSelection = Boolean(state.proxy.smartSwitching);
  elements.setActive.className = 'secondary';

  if (!hasSite) {
    elements.setActive.textContent = '选择';
    elements.setActive.disabled = true;
    elements.setActive.title = '';
    return;
  }

  if (automaticSelection) {
    elements.setActive.textContent = '自动选择中';
    elements.setActive.disabled = true;
    elements.setActive.title = '关闭自动选择后可以手动选择当前站点';
    return;
  }

  const selected = site.id === state.activeSiteId;
  const available = getAvailabilityState(site) === 'enabled';
  elements.setActive.textContent = selected ? '已选择' : '选择';
  elements.setActive.disabled = selected || !available;
  elements.setActive.className = selected || !available ? 'secondary' : '';
  elements.setActive.title = selected
    ? '当前手动选择的站点'
    : available
      ? '手动选择该站点用于后续请求'
      : '该站点当前不可用，不能选择';
}

function renderSyncRemote(sync) {
  const remote = sync?.remote ?? {};

  elements.syncSummary.textContent = formatSyncSummary(sync);
  elements.syncBalance.textContent = remote.balance || '-';
  elements.syncKeyName.textContent = remote.keyName || '-';
  elements.syncKeyGroup.textContent = remote.keyGroup || '-';
  elements.syncMultiplier.textContent = formatOptionalMultiplier(remote.groupMultiplier);
  elements.syncLastAt.textContent = formatLocalDateTime(sync?.lastSyncAt);
  elements.switchSyncGroupId.disabled = !getSelectedSite();
  renderSiteSyncGroups(sync);
}

function renderCapabilities(capabilities) {
  const normalized = normalizeCapabilities(capabilities);
  const supportedKeys = capabilityOrder.filter((key) => normalized.features[key]);
  const checkedAt = formatLocalDateTime(normalized.checkedAt, '');

  if (!normalized.lastStatus) {
    elements.capabilitySummary.textContent = '尚未探测，点击“刷新模型”读取 /v1/models';
  } else if (normalized.lastStatus === 'failure') {
    elements.capabilitySummary.textContent =
      `探测失败${checkedAt ? ` · ${checkedAt}` : ''} · ${normalized.lastError || '未知错误'}`;
  } else {
    elements.capabilitySummary.textContent =
      `${normalized.models.length} 个模型 · ${supportedKeys.length} 类能力${checkedAt ? ` · ${checkedAt}` : ''}`;
  }

  const featureItems = capabilityOrder.map((key) => {
    const enabled = normalized.features[key];
    const models = normalized.featureModels[key] ?? [];
    const title = models.length > 0
      ? `${capabilityLabels[key]}: ${models.slice(0, 20).join(', ')}`
      : `${capabilityLabels[key]}: 未从模型列表识别`;
    return `
      <span class="capability-chip ${enabled ? 'enabled' : 'disabled'}" title="${escapeHtml(title)}">
        ${escapeHtml(capabilityLabels[key])}
      </span>
    `;
  });
  elements.capabilityFeatures.innerHTML = featureItems.join('');

  if (normalized.models.length === 0) {
    elements.capabilityModels.innerHTML = '<div class="empty">暂无模型列表</div>';
    return;
  }

  const visibleModels = normalized.models.slice(0, 80);
  const hiddenCount = Math.max(0, normalized.models.length - visibleModels.length);
  elements.capabilityModels.innerHTML = [
    ...visibleModels.map((model) => `<code>${escapeHtml(model)}</code>`),
    hiddenCount > 0 ? `<span class="capability-more">另有 ${hiddenCount} 个模型未展开</span>` : ''
  ].join('');
}

function normalizeCapabilities(capabilities = {}) {
  const features = capabilities?.features && typeof capabilities.features === 'object'
    ? capabilities.features
    : {};
  const featureModels = capabilities?.featureModels && typeof capabilities.featureModels === 'object'
    ? capabilities.featureModels
    : {};
  return {
    models: Array.isArray(capabilities?.models)
      ? capabilities.models.filter(Boolean).map(String)
      : [],
    features: Object.fromEntries(capabilityOrder.map((key) => [key, Boolean(features[key])])),
    featureModels: Object.fromEntries(
      capabilityOrder.map((key) => [
        key,
        Array.isArray(featureModels[key]) ? featureModels[key].filter(Boolean).map(String) : []
      ])
    ),
    checkedAt: capabilities?.checkedAt ?? null,
    lastStatus: capabilities?.lastStatus ?? null,
    lastError: capabilities?.lastError ?? null
  };
}

function readSiteFormPayload(existingSite = null) {
  return {
    name: elements.name.value.trim(),
    baseUrl: elements.baseUrl.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    modelMapping: readModelMappingFormPayload(
      elements.siteModelMappingEnabled,
      elements.siteModelMappingRows,
      '站点模型映射'
    ),
    priority: Number(elements.priority.value || 100),
    multiplier: readSiteMultiplier(),
    customMultiplier: readCustomMultiplier(),
    multiplierLocked: elements.multiplierLocked.checked,
    remark: elements.remark.value.trim(),
    sync: readSyncFormPayload(existingSite?.sync),
    rateLimit: {
      enabled: elements.rateLimitEnabled.checked,
      limit: Number(elements.rateLimitCount.value || 60),
      windowValue: Number(elements.rateLimitWindowValue.value || 1),
      windowUnit: elements.rateLimitWindowUnit.value
    },
    autoRecovery: {
      enabled: elements.autoRecoveryEnabled.checked,
      intervalValue: Number(elements.autoRecoveryIntervalValue.value || 1),
      intervalUnit: elements.autoRecoveryIntervalUnit.value
    },
    manualEnabled: elements.enabled.checked
  };
}

function renderSiteSyncGroups(sync) {
  const groups = normalizeRemoteGroups(sync?.remote?.groups);
  if (groups.length === 0) {
    elements.syncGroups.innerHTML = '<span class="sync-groups-empty">暂无可切换分组</span>';
    return;
  }

  replaceChildren(
    elements.syncGroups,
    groups.map((group) => renderSiteSyncGroupButton(group))
  );
}

function renderSiteSyncGroupButton(group) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = [
    'sync-group-chip',
    'site-sync-group-chip',
    group.selected ? 'active' : ''
  ].filter(Boolean).join(' ');
  button.title = `切换到 ${group.name}，倍率 ${formatGroupMultiplierText(group.multiplier)}`;
  button.textContent = formatGroupChipLabel(group);
  button.addEventListener('click', () => switchSelectedSiteGroup({ groupName: group.name }));
  return button;
}

function renderOverview(site) {
  if (!site) {
    elements.overviewAvailability.textContent = '-';
    elements.overviewLastRequest.textContent = '-';
    elements.overviewSuccessRate.textContent = '-';
    elements.overviewConsecutiveErrors.textContent = '-';
    return;
  }

  elements.overviewAvailability.textContent = formatAvailabilityLabel(site);
  elements.overviewLastRequest.textContent = formatLastRequestText(site.lastRequestAt);
  elements.overviewSuccessRate.textContent = formatSuccessRate(
    calculateSuccessRate(site.successCount, site.errorCount)
  );
  elements.overviewConsecutiveErrors.textContent = String(site.consecutiveErrors ?? 0);
}

function renderStatus(site) {
  if (!site) {
    elements.contextSiteName.textContent = '未选择站点';
    elements.contextSiteStatus.textContent = '-';
    elements.contextSiteStatus.className = 'status-pill idle';
    elements.status.innerHTML = '<dt>状态</dt><dd>未选择站点</dd>';
    return;
  }

  elements.contextSiteName.textContent = site.name;
  elements.contextSiteStatus.textContent = formatStatus(site.status);
  elements.contextSiteStatus.className = `status-pill ${statusClass(site.status)}`;

  const fields = [
    ['模型能力', formatCapabilitySummary(site.capabilities)],
    ['模型数量', normalizeCapabilities(site.capabilities).models.length],
    ['状态', formatStatus(site.status)],
    ['可用状态', formatAvailabilityLabel(site)],
    ['人工启用', (site.manualEnabled ?? site.enabled ?? true) ? '是' : '否'],
    ['错误停用', site.failureDisabled ? '是' : '否'],
    ['当前站点', site.id === state.activeSiteId ? '是' : '否'],
    ['优先级', site.priority ?? 100],
    ['真实倍率', formatMultiplier(site.multiplier)],
    ['账号倍率', formatOptionalMultiplier(site.sync?.remote?.groupMultiplier)],
    ['自定义倍数', formatOptionalMultiplier(site.customMultiplier)],
    ['实际倍率', formatEffectiveMultiplier(site)],
    ['模型映射', formatModelMappingSummary(site.modelMapping, state.modelMapping)],
    ['远端同步', formatSyncSummary(site.sync)],
    ['远端余额', site.sync?.remote?.balance || '-'],
    ['远端密钥', site.sync?.remote?.keyName || '-'],
    ['远端分组', site.sync?.remote?.keyGroup || '-'],
    ['速率限制', formatRateLimitSummary(site)],
    ['错误停用后自检', formatAutoRecoverySummary(site)],
    ['自检结果', formatAutoRecoveryResult(site)],
    ['下次自检', formatLocalDateTime(site.autoRecoveryState?.nextCheckAt)],
    ['窗口已用', site.rateLimit?.enabled ? `${site.rateLimitState?.used ?? 0}/${site.rateLimit.limit}` : '-'],
    ['暂停到', formatLocalDateTime(site.rateLimitState?.pausedUntil)],
    ['请求数', site.requestCount],
    ['最近请求', formatLastRequestText(site.lastRequestAt)],
    ['成功数', site.successCount],
    ['错误数', site.errorCount],
    ['成功率', formatSuccessRate(calculateSuccessRate(site.successCount, site.errorCount))],
    ['连续错误', site.consecutiveErrors],
    ['最近成功', formatLocalDateTime(site.lastSuccessAt)],
    ['最近错误', formatLocalDateTime(site.lastErrorAt)],
    ['最近错误信息', site.lastError?.message ?? '-']
  ];

  fields.splice(6, 0, ['备注信息', site.remark?.trim() || '-']);

  elements.status.innerHTML = fields
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join('');
}

function renderErrorLog(site) {
  if (!site) {
    elements.errorLogSummary.textContent = '0 条';
    elements.errorLog.innerHTML = '<div class="empty">未选择站点。</div>';
    return;
  }
  elements.errorLogSummary.textContent = `${site.errorLog.length} 条`;
  if (!site.errorLog.length) {
    elements.errorLog.innerHTML = '<div class="empty">暂无错误记录。</div>';
    return;
  }

  elements.errorLog.innerHTML = site.errorLog
    .map((entry) => {
      const statusCode = entry.statusCode ? `HTTP ${entry.statusCode}` : '网络错误';
      return `
        <div class="error-entry">
          <strong>${escapeHtml(statusCode)} · ${escapeHtml(formatLocalDateTime(entry.at))}</strong>
          <code>${escapeHtml(entry.message)}${entry.detail ? `\n${entry.detail}` : ''}</code>
        </div>
      `;
    })
    .join('');
}

function renderRouteTraces() {
  if (!elements.routeTraceLog || !elements.routeTraceSummary) {
    return;
  }

  const traces = Array.isArray(state?.recentRouteTraces) ? state.recentRouteTraces : [];
  elements.routeTraceSummary.textContent = `${traces.length} 条`;
  if (!traces.length) {
    elements.routeTraceLog.innerHTML = '<div class="empty">暂无请求路由。</div>';
    return;
  }

  elements.routeTraceLog.innerHTML = traces
    .slice(0, 20)
    .map(renderRouteTraceEntry)
    .join('');
}

function renderActivityView() {
  if (!elements.activityLogList) {
    return;
  }

  renderActivityMonitorStatus();
  const category = normalizeActivityCategoryFilter(selectedActivityCategory);
  const status = normalizeActivityStatusFilter(selectedActivityStatus);
  const visibleEntries = activityLogs.filter((entry) => {
    const entryCategory = getActivityCategory(entry);
    const entryStatus = getActivityStatus(entry);
    return (category === 'all' || entryCategory === category) &&
      (status === 'all' || entryStatus === status);
  });

  elements.activityCategoryFilter.value = category;
  elements.activityStatusFilter.value = status;
  elements.activityLogSummary.textContent = category === 'all' && status === 'all'
    ? `${activityLogs.length} 条`
    : `显示 ${visibleEntries.length} / ${activityLogs.length} 条`;

  if (!visibleEntries.length) {
    elements.activityLogList.innerHTML = '<div class="empty">暂无符合条件的运行记录。</div>';
    return;
  }

  elements.activityLogList.innerHTML = visibleEntries
    .map(renderActivityLogEntry)
    .join('');
}

function renderActivityMonitorStatus() {
  const status = state?.siteSyncStatus ?? {};
  const monitoring = Boolean(status.monitoring);
  const checking = Boolean(status.checking);
  const statusLabel = !monitoring ? '未启动' : checking ? '检查中' : '监控中';
  const statusClassName = !monitoring ? 'idle' : checking ? 'running' : 'success';
  elements.activityMonitorStatus.textContent = statusLabel;
  elements.activityMonitorStatus.className = `status-pill ${statusClassName}`;
  elements.activityMonitorSummary.textContent = monitoring
    ? `每 ${formatMonitorInterval(status.intervalMs)} 扫描一次，到期站点按分组刷新间隔执行`
    : '自动监控未启动';
  elements.activityMonitorChecking.textContent = checking ? '正在检查' : '空闲';
  elements.activityMonitorLastCheck.textContent = formatLocalDateTime(
    status.lastCheckCompletedAt ?? status.lastCheckStartedAt
  );
  elements.activityMonitorNextCheck.textContent = monitoring
    ? formatLocalDateTime(status.nextCheckAt)
    : '-';
  elements.activityMonitorCounts.textContent = [
    `检查 ${status.checkedWebsiteCount ?? 0}`,
    `成功 ${status.syncedWebsiteCount ?? 0}`,
    `失败 ${status.failedWebsiteCount ?? 0}`
  ].join(' · ');
}

function renderActivityLogEntry(entry = {}) {
  const context = entry.context && typeof entry.context === 'object' ? entry.context : {};
  const category = getActivityCategory(entry);
  const status = getActivityStatus(entry);
  const detail = [
    context.siteName ? `站点：${context.siteName}` : null,
    context.groupName ? `分组：${context.groupName}` : null,
    Number.isFinite(Number(context.candidateMultiplier))
      ? `候选倍率：${formatActivityMultiplier(context.candidateMultiplier)}x`
      : null,
    Number.isFinite(Number(context.currentLowestMultiplier))
      ? `当前最低：${formatActivityMultiplier(context.currentLowestMultiplier)}x`
      : null,
    context.trigger === 'scheduled' ? '来源：自动监控' : null,
    context.nextAttemptAt ? `下次重试：${formatLocalDateTime(context.nextAttemptAt)}` : null,
    context.rolledBack ? '远端密钥：已执行回滚' : null
  ].filter(Boolean);

  return `
    <article class="activity-entry ${activityStatusClass(status)}">
      <header class="activity-entry-header">
        <div>
          <strong>${escapeHtml(String(entry.message ?? formatActivityType(context.type)))}</strong>
          <span>${escapeHtml(formatLocalDateTime(entry.timestamp))}</span>
        </div>
        <mark class="activity-entry-status ${activityStatusClass(status)}">${escapeHtml(formatActivityStatus(status))}</mark>
      </header>
      <div class="activity-entry-meta">
        <span>${escapeHtml(formatActivityCategory(category))}</span>
        ${context.type ? `<span>${escapeHtml(formatActivityType(context.type))}</span>` : ''}
        ${detail.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
      </div>
    </article>
  `;
}

function getActivityCategory(entry = {}) {
  const contextCategory = entry.context?.category;
  if (contextCategory === 'sync' || contextCategory === 'auto-provision') {
    return contextCategory;
  }
  const source = String(entry.source ?? '');
  return source.includes('auto-provision') ? 'auto-provision' : source.includes('sync') ? 'sync' : 'all';
}

function getActivityStatus(entry = {}) {
  const contextStatus = entry.context?.status;
  if (['running', 'success', 'skipped', 'failure'].includes(contextStatus)) {
    return contextStatus;
  }
  if (entry.level === 'error') {
    return 'failure';
  }
  if (entry.level === 'warn') {
    return 'skipped';
  }
  return 'success';
}

function normalizeActivityCategoryFilter(value) {
  return ['all', 'sync', 'auto-provision'].includes(value) ? value : 'all';
}

function normalizeActivityStatusFilter(value) {
  return ['all', 'running', 'success', 'skipped', 'failure'].includes(value) ? value : 'all';
}

function formatActivityCategory(category) {
  return category === 'sync' ? '远端同步' : category === 'auto-provision' ? '自动导入' : '运行活动';
}

function formatActivityStatus(status) {
  return {
    running: '进行中',
    success: '成功',
    skipped: '已跳过',
    failure: '失败'
  }[status] ?? '未知';
}

function formatActivityType(type) {
  return {
    'sync-started': '开始同步',
    'sync-completed': '同步完成',
    'sync-failed': '同步失败',
    'candidate-found': '发现候选分组',
    'key-created': '密钥已创建',
    'test-passed': '模型测试通过',
    imported: '已导入配置',
    'not-beneficial': '倍率不具备优势',
    cooldown: '处于失败冷却期',
    'no-candidate': '未发现候选分组',
    'create-failed': '创建密钥失败',
    'test-failed': '模型测试失败',
    'import-failed': '导入配置失败'
  }[type] ?? '运行活动';
}

function activityStatusClass(status) {
  return status === 'success' ? 'success' : status === 'failure' ? 'failure' : status === 'running' ? 'running' : 'skipped';
}

function formatActivityMultiplier(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toPrecision(8)).toString() : '-';
}

function formatMonitorInterval(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '定时';
  }
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60} 小时`;
  }
  return `${Math.max(minutes, 1)} 分钟`;
}

function renderInspectorRoutes() {
  const traces = Array.isArray(state?.recentRouteTraces) ? state.recentRouteTraces : [];
  if (!traces.length) {
    elements.inspectorRouteLog.innerHTML = '<div class="empty compact-empty">暂无请求路由</div>';
    return;
  }

  elements.inspectorRouteLog.innerHTML = traces.slice(0, 3).map((trace) => {
    const attempts = Array.isArray(trace.attempts) ? trace.attempts : [];
    const finalAttempt = attempts.at(-1);
    const status = trace.finalStatusCode ? `HTTP ${trace.finalStatusCode}` : formatRouteTraceOutcome(trace.outcome);
    return `
      <article class="inspector-route-entry ${trace.outcome === 'success' ? 'success' : 'error'}">
        <div>
          <strong>${escapeHtml(`${trace.method ?? '-'} ${trace.path ?? '/'}`)}</strong>
          <small>${escapeHtml(`${finalAttempt?.siteName ?? finalAttempt?.siteId ?? '未路由'} · ${formatRouteTraceDuration(trace.durationMs)}`)}</small>
        </div>
        <span>${escapeHtml(status)}</span>
      </article>
    `;
  }).join('');
}

function renderRouteTraceEntry(trace = {}) {
  const attempts = Array.isArray(trace.attempts) ? trace.attempts : [];
  const statusLabel = trace.finalStatusCode ? `HTTP ${trace.finalStatusCode}` : formatRouteTraceOutcome(trace.outcome);
  const queryKeys = Array.isArray(trace.queryKeys) && trace.queryKeys.length
    ? ` ?${trace.queryKeys.join('&')}`
    : '';
  const badges = [
    trace.requestLocalFailover ? '本次请求切换' : null,
    trace.globalSelectionPreserved ? '全局选择未改变' : null,
    trace.replayable ? '可重放' : '不可重放'
  ].filter(Boolean);

  return `
    <article class="route-trace-entry ${trace.requestLocalFailover ? 'request-local' : ''}">
      <header class="route-trace-entry-header">
        <div>
          <strong>${escapeHtml(`${trace.method ?? '-'} ${trace.path ?? '/'}${queryKeys}`)}</strong>
          <span>${escapeHtml(`${formatLocalDateTime(trace.completedAt ?? trace.startedAt)} · ${formatRouteTraceDuration(trace.durationMs)}`)}</span>
        </div>
        <mark class="route-trace-status ${trace.outcome === 'success' ? 'success' : 'error'}">${escapeHtml(statusLabel)}</mark>
      </header>
      <div class="route-trace-meta">
        <span>${escapeHtml(formatRouteTraceModel(trace))}</span>
        <span>${escapeHtml(`尝试 ${attempts.length}`)}</span>
        ${badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join('')}
      </div>
      <ol class="route-trace-attempts">
        ${attempts.map(renderRouteTraceAttempt).join('')}
      </ol>
    </article>
  `;
}

function renderRouteTraceAttempt(attempt = {}) {
  const statusLabel = attempt.statusCode ? `HTTP ${attempt.statusCode}` : formatRouteTraceOutcome(attempt.kind);
  const reason = attempt.classification?.reason ?? attempt.errorMessage ?? '';
  const retryLabel = attempt.classification
    ? [
      attempt.classification.retryable ? '可重试' : '不重试',
      attempt.classification.requestLocalRetry ? '单请求切换' : null,
      attempt.classification.affectsSiteHealth ? '影响健康' : '不影响健康'
    ].filter(Boolean).join(' · ')
    : '';

  return `
    <li class="${attempt.ok ? 'success' : 'error'}">
      <div class="route-trace-attempt-main">
        <strong>${escapeHtml(attempt.siteName ?? attempt.siteId ?? '未知站点')}</strong>
        <span>${escapeHtml(statusLabel)}</span>
      </div>
      ${retryLabel ? `<small>${escapeHtml(retryLabel)}</small>` : ''}
      ${reason ? `<code>${escapeHtml(reason)}</code>` : ''}
    </li>
  `;
}

function formatRouteTraceModel(trace = {}) {
  if (trace.modelMapped) {
    return `模型 ${trace.originalModel ?? '-'} -> ${trace.forwardedModel ?? '-'}`;
  }
  return `模型 ${trace.forwardedModel ?? trace.originalModel ?? '-'}`;
}

function formatRouteTraceDuration(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function formatRouteTraceOutcome(outcome) {
  switch (outcome) {
    case 'success':
      return '成功';
    case 'upstream-error':
      return '上游错误';
    case 'network-error':
      return '网络错误';
    case 'no-site':
      return '无可用站点';
    case 'aborted':
      return '已中断';
    case 'proxy-error':
      return '代理错误';
    default:
      return '未知';
  }
}

function getSelectedSite() {
  return state.sites.find((site) => site.id === selectedSiteId) ?? null;
}

function getActiveSite() {
  return state.sites.find((site) => site.id === state.activeSiteId) ?? null;
}

function readConfigExportOptions() {
  const mode = normalizeConfigExportMode(elements.configExportMode.value);
  const siteIds = readConfigExportSiteIds(mode);
  if (siteIds?.length === 0) {
    throw new Error('请选择至少一个要导出的站点');
  }

  return {
    includeGlobalSettings: elements.configExportGlobalSettings.checked,
    siteIds
  };
}

function readConfigExportSiteIds(mode) {
  if (mode === 'all') {
    return null;
  }
  if (mode === 'current') {
    const selectedSite = getSelectedSite();
    return selectedSite ? [selectedSite.id] : [];
  }
  return readCheckedConfigSiteIds(elements.configExportSelectedSites);
}

function readConfigImportOptions() {
  if (!pendingImportPreview?.importId) {
    throw new Error('请先选择导入文件');
  }
  const siteIds = readCheckedConfigSiteIds(elements.configImportSites);
  const includeGlobalSettings = elements.configImportGlobalSettings.checked &&
    !elements.configImportGlobalSettings.disabled;

  if (siteIds.length === 0 && !includeGlobalSettings) {
    throw new Error('请选择至少一个站点或全局设置');
  }

  return {
    importId: pendingImportPreview.importId,
    includeGlobalSettings,
    siteIds
  };
}

function readCheckedConfigSiteIds(container) {
  return getElementChildren(container)
    .map((child) => getElementChildren(child)[0])
    .filter((input) => input?.checked && input.dataset?.siteId)
    .map((input) => input.dataset.siteId);
}

function hasConfigSiteOptions(container) {
  return getElementChildren(container)
    .some((child) => getElementChildren(child)[0]?.dataset?.siteId);
}

for (const [period, button] of dashboardPeriodButtons) {
  button.addEventListener('click', () => {
    selectedDashboardPeriod = period;
    renderDashboard();
  });
}

for (const [view, button] of workspaceViewButtons) {
  button.addEventListener('click', () => {
    switchWorkspaceView(view);
  });
}

for (const [tab, button] of siteTabButtons) {
  button.addEventListener('click', () => {
    selectedSiteTab = tab;
    renderSiteTabs();
  });
}

elements.toggleSiteInspector.addEventListener('click', () => {
  siteInspectorOpen = !siteInspectorOpen;
  renderSiteInspector();
});

elements.closeSiteInspector.addEventListener('click', () => {
  siteInspectorOpen = false;
  renderSiteInspector();
  elements.toggleSiteInspector.focus();
});

elements.openRequestTraces.addEventListener('click', () => {
  switchWorkspaceView('diagnostics');
});

elements.siteStatusFilter.addEventListener('change', () => {
  selectedSiteStatusFilter = normalizeSiteStatusFilter(elements.siteStatusFilter.value);
  renderSiteList();
});

elements.siteSort.addEventListener('change', () => {
  selectedSiteSort = normalizeSiteSort(elements.siteSort.value);
  renderSiteList();
});

elements.activityCategoryFilter?.addEventListener('change', () => {
  selectedActivityCategory = normalizeActivityCategoryFilter(elements.activityCategoryFilter.value);
  renderActivityView();
});

elements.activityStatusFilter?.addEventListener('change', () => {
  selectedActivityStatus = normalizeActivityStatusFilter(elements.activityStatusFilter.value);
  renderActivityView();
});

elements.refreshActivityLogs?.addEventListener('click', async () => {
  await runAction(async () => {
    await refreshActivityLogs();
    showToast('运行日志已刷新');
  });
});

elements.clearActivityLogs?.addEventListener('click', async () => {
  if (typeof api.clearActivityLogs !== 'function') {
    return;
  }
  if (!confirm('确定清空所有运行日志吗？')) {
    return;
  }
  await runAction(async () => {
    const result = await api.clearActivityLogs();
    if (result?.ok === false) {
      throw new Error('运行日志清空失败');
    }
    activityLogs = [];
    renderActivityView();
    showToast('运行日志已清空');
  });
});

elements.configExportMode.addEventListener('change', () => {
  renderExportSitePicker();
});

elements.exportConfig.addEventListener('click', async () => {
  await runAction(async () => {
    const options = readConfigExportOptions();
    const result = await api.exportConfig(options);
    if (result?.canceled) {
      return;
    }
    showToast(`配置已导出：${result.exportedSiteCount ?? 0} 个站点`);
  });
});

elements.previewImportConfig.addEventListener('click', async () => {
  await runAction(async () => {
    const result = await api.previewImportConfig();
    if (result?.canceled) {
      return;
    }
    pendingImportPreview = result;
    renderImportPreview();
    showToast('导入文件已读取，请确认要导入的内容');
  });
});

elements.applyImportConfig.addEventListener('click', async () => {
  await runAction(async () => {
    const result = await api.importConfig(readConfigImportOptions());
    state = result;
    selectedSiteId = result.importResult?.importedSiteIds?.[0] ?? state.activeSiteId ?? state.sites[0]?.id ?? null;
    pendingImportPreview = null;
    formDirty = false;
    render();
    showToast(`已导入 ${result.importResult?.importedSiteCount ?? 0} 个站点`);
  });
});

elements.quitApp.addEventListener('click', async () => {
  if (!confirm('退出 JuanProxy？本地代理、后台同步和悬浮窗都会停止。')) {
    return;
  }
  elements.quitApp.disabled = true;
  try {
    await api.quitApp();
  } catch (error) {
    elements.quitApp.disabled = false;
    showToast(error?.message || String(error));
  }
});

elements.refreshSiteSyncAll.addEventListener('click', async () => {
  await runAction(async () => {
    state = await api.refreshAllSiteSync();
    formDirty = false;
    render();
    const result = state.refreshResult;
    const syncedCount = result?.syncedWebsiteCount ?? result?.syncedCount ?? 0;
    const failedCount = result?.failedWebsiteCount ?? result?.failedCount ?? 0;
    showToast(
      result
        ? `分组倍率已刷新：网站成功 ${syncedCount}，失败 ${failedCount}`
        : '分组倍率已刷新'
    );
  });
});

elements.clearSiteGroupFilter.addEventListener('click', () => {
  selectedGroupFilterKey = null;
  renderSiteList();
  renderTopbarSyncGroups();
});

elements.siteGroupPopoverClose.addEventListener('click', () => {
  closeSiteGroupPopover();
});

elements.siteGroupPopoverViewSite.addEventListener('click', () => {
  const entry = resolveSelectedGroupAction();
  if (!entry) {
    return;
  }
  closeSiteGroupPopover();
  requestEditorNavigation(() => {
    selectedSiteId = entry.site.id;
    selectedSiteTab = 'overview';
    setWorkspaceView('sites');
    render();
  });
});

elements.siteGroupPopoverFilter.addEventListener('click', () => {
  const entry = resolveSelectedGroupAction();
  if (!entry) {
    return;
  }
  selectedGroupFilterKey = entry.filterKey;
  closeSiteGroupPopover();
  renderSiteList();
  renderTopbarSyncGroups();
});

elements.siteGroupPopoverSwitch.addEventListener('click', async () => {
  const entry = resolveSelectedGroupAction();
  if (!entry || entry.group.selected) {
    return;
  }
  const switched = await switchSiteGroup(entry.site.id, {
    groupName: entry.group.name,
    ...(entry.group.id ? { groupId: entry.group.id } : {})
  });
  if (switched) {
    closeSiteGroupPopover();
  }
});

elements.toggleTopbarSyncGroups.addEventListener('click', () => {
  showAllTopbarSyncGroups = !showAllTopbarSyncGroups;
  renderTopbarSyncGroups();
});

elements.copyProxyUrl.addEventListener('click', async () => {
  await copyProxyUrl();
});

elements.copyLocalApiKey.addEventListener('click', async () => {
  if (!visibleLocalApiKey) {
    return;
  }
  await runAction(async () => {
    await copyTextToClipboard(visibleLocalApiKey);
    showToast('本地 API 密钥已复制');
  });
});

elements.generateLocalApiKey.addEventListener('click', async () => {
  if (!confirm('重新生成后，正在使用的旧本地 API 密钥会立即失效。继续？')) {
    return;
  }
  await runAction(async () => {
    const result = await api.generateLocalApiKey();
    visibleLocalApiKey = result.localApiKey;
    renderProxy();
    showToast('新的本地 API 密钥已生成，请立即复制');
  });
});

window.addEventListener?.('keydown', async (event) => {
  if (event.key === 'Escape') {
    if (!elements.unsavedChangesDialog.hidden) {
      event.preventDefault?.();
      cancelEditorNavigation();
      return;
    }
    if (!elements.siteGroupPopover.hidden) {
      event.preventDefault?.();
      closeSiteGroupPopover();
      return;
    }
    if (compactInspectorMode && siteInspectorOpen) {
      event.preventDefault?.();
      siteInspectorOpen = false;
      renderSiteInspector();
      elements.toggleSiteInspector.focus();
      return;
    }
  }
  if (!isCopyProxyUrlShortcut(event)) {
    return;
  }
  event.preventDefault?.();
  await copyProxyUrl();
});

window.addEventListener?.('resize', () => {
  const nextCompactMode = window.innerWidth < 1160;
  if (nextCompactMode === compactInspectorMode) {
    positionSiteGroupPopover();
    return;
  }
  compactInspectorMode = nextCompactMode;
  siteInspectorOpen = !compactInspectorMode;
  renderSiteInspector();
  positionSiteGroupPopover();
});

window.addEventListener?.('scroll', () => {
  positionSiteGroupPopover();
}, true);

elements.newSite.addEventListener('click', () => {
  requestEditorNavigation(() => {
    selectedSiteId = null;
    selectedSiteTab = 'basic';
    setWorkspaceView('sites');
    render();
    elements.name.focus();
  });
});

elements.unsavedChangesCancel.addEventListener('click', () => {
  cancelEditorNavigation();
});

elements.unsavedChangesDiscard.addEventListener('click', () => {
  formDirty = false;
  continueEditorNavigation();
});

elements.unsavedChangesSave.addEventListener('click', async () => {
  await runAction(async () => {
    await persistSiteEditor();
    continueEditorNavigation();
    showToast('站点已保存');
  });
});

elements.form.addEventListener('input', () => {
  formDirty = true;
  renderMultiplierPreview(getSelectedSite());
});

elements.form.addEventListener('change', () => {
  formDirty = true;
  renderMultiplierPreview(getSelectedSite());
});

elements.customMultiplierEnabled.addEventListener('change', () => {
  updateCustomMultiplierState();
  renderMultiplierPreview(getSelectedSite());
});

elements.multiplierLocked.addEventListener('change', () => {
  updateCustomMultiplierState();
  renderMultiplierPreview(getSelectedSite());
});

elements.siteMonitoringEnabled.addEventListener('change', () => {
  elements.siteBalanceThreshold.disabled =
    !elements.syncAccount.value || !elements.syncEnabled.checked || !elements.siteMonitoringEnabled.checked;
});

elements.monitoringNoUsableSite.addEventListener('change', () => {
  elements.noUsableSiteDelayMinutes.disabled = !elements.monitoringNoUsableSite.checked;
});

elements.syncEnabled.addEventListener('change', () => {
  elements.siteBalanceThreshold.disabled =
    !elements.syncAccount.value || !elements.syncEnabled.checked || !elements.siteMonitoringEnabled.checked;
});

elements.apiKey.addEventListener('focus', () => {
  elements.apiKey.type = 'text';
});

elements.apiKey.addEventListener('blur', () => {
  elements.apiKey.type = 'password';
});

elements.syncIntervalMode.addEventListener('change', () => {
  updateSyncIntervalModeState();
});

elements.addGlobalModelMapping.addEventListener('click', () => {
  appendModelMappingRow(elements.globalModelMappingRows, { from: '', to: '' });
  syncModelMappingTextFromRows(elements.globalModelMappingRows, elements.globalModelMapping);
});

elements.addSiteModelMapping.addEventListener('click', () => {
  appendModelMappingRow(elements.siteModelMappingRows, { from: '', to: '' });
  syncModelMappingTextFromRows(elements.siteModelMappingRows, elements.siteModelMapping);
  formDirty = true;
});

elements.globalModelMapping.addEventListener('change', () => {
  replaceModelMappingRowsFromText(elements.globalModelMappingRows, elements.globalModelMapping);
});

elements.siteModelMapping.addEventListener('change', () => {
  replaceModelMappingRowsFromText(elements.siteModelMappingRows, elements.siteModelMapping);
  formDirty = true;
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await runAction(async () => {
    await persistSiteEditor();
    render();
    showToast('站点已保存');
  });
});

elements.syncSite.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (!site) {
    return;
  }
  await runAction(async () => {
    const id = site.id;
    state = await api.updateSite(id, {
      sync: {
        ...site.sync,
        ...readSyncFormPayload(site.sync)
      }
    });
    selectedSiteId = id;
    formDirty = false;
    render();

    state = await api.syncSite(id);
    selectedSiteId = id;
    formDirty = false;
    render();
    showToast(state.syncResult?.ok ? '远端信息已同步' : '远端同步失败');
  });
});

elements.createSiteKey.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (!site || !api.createSiteKey) {
    return;
  }
  if (!confirm(`确认在 ${site.name} 的远端账号中新建密钥并导入本地？`)) {
    return;
  }

  await runAction(async () => {
    const id = site.id;
    state = await api.updateSite(id, {
      sync: {
        ...site.sync,
        ...readSyncFormPayload(site.sync)
      }
    });
    selectedSiteId = id;
    formDirty = false;
    render();

    state = await api.createSiteKey(id);
    selectedSiteId = state.createKeyResult?.createdSiteId || id;
    formDirty = false;
    render();
    showToast(state.createKeyResult?.ok ? '远端密钥已创建并导入' : '远端密钥创建失败');
  });
});

elements.logoutSiteAccount.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (!site || !api.logoutSiteAccount) {
    return;
  }
  if (!confirm(`确认退出 ${site.sync?.username || site.name} 的远端登录设备？`)) {
    return;
  }
  await runAction(async () => {
    state = await api.logoutSiteAccount(site.id);
    selectedSiteId = site.id;
    formDirty = false;
    render();
    if (state.logoutResult?.ok) {
      showToast(state.logoutResult.remoteSucceeded ? '远端账号已退出' : '本地登录凭证已清除');
    } else {
      showToast('远端登出失败，请稍后重试');
    }
  });
});

elements.syncAccount.addEventListener('change', () => {
  const accountId = elements.syncAccount.value;
  const sync = getRemoteAccountSync(accountId);
  if (sync) {
    elements.syncDashboardUrl.value = sync.dashboardUrl ?? '';
    elements.syncUsername.value = sync.username ?? '';
    elements.syncPassword.value = sync.password ?? '';
    elements.syncProviderType.value = sync.providerType ?? 'auto';
  } else {
    elements.syncDashboardUrl.value = '';
    elements.syncUsername.value = '';
    elements.syncPassword.value = '';
    elements.syncProviderType.value = 'auto';
  }
  const rule = getMonitoringRule(accountId);
  elements.siteMonitoringEnabled.checked = rule?.enabled ?? true;
  elements.siteBalanceThreshold.value = rule?.balanceThreshold ?? '';
  elements.siteBalanceThreshold.disabled =
    !accountId || !elements.syncEnabled.checked || !elements.siteMonitoringEnabled.checked;
  elements.siteMonitoringAccount.textContent = accountId
    ? `当前账号：${sync?.username || accountId}（同账号关联站点共用此配置）`
    : '请选择或保存远端账号后配置余额提醒';
  formDirty = true;
});

elements.switchSyncGroupId.addEventListener('click', async () => {
  const groupId = elements.syncGroupId.value.trim();
  if (!groupId) {
    showToast('请输入分组 ID');
    elements.syncGroupId.focus();
    return;
  }
  await switchSelectedSiteGroup({ groupId });
});

async function switchSelectedSiteGroup(group) {
  const site = getSelectedSite();
  if (!site || !api.switchSiteGroup) {
    return;
  }
  await switchSiteGroup(site.id, group);
}

async function switchSiteGroup(siteId, group) {
  const site = state.sites.find((candidate) => candidate.id === siteId);
  if (!site || !api.switchSiteGroup) {
    return false;
  }
  const normalizedGroup = normalizeSwitchGroupInput(site, group);
  if (!normalizedGroup.groupName && !normalizedGroup.groupId) {
    showToast('请输入分组 ID');
    return false;
  }
  if (!confirm(formatSwitchGroupConfirmMessage(site, normalizedGroup))) {
    return false;
  }

  return runAction(async () => {
    const switchPayload = normalizedGroup.groupId
      ? normalizedGroup
      : normalizedGroup.groupName;
    const nextState = await api.switchSiteGroup(site.id, switchPayload);
    applyState(nextState, { preserveDirtyEditor: true });
    if (group?.groupId && elements.syncGroupId) {
      elements.syncGroupId.value = '';
    }
    showToast('分组已切换');
  });
}

function normalizeSwitchGroupInput(site, group = {}) {
  const groupName = String(group?.groupName ?? group?.name ?? '').trim();
  const groupId = String(group?.groupId ?? group?.id ?? '').trim();
  const matchedGroup = groupId
    ? normalizeRemoteGroups(site?.sync?.remote?.groups)
        .find((candidate) => candidate.id === groupId)
    : null;
  const normalizedGroupName = groupName || matchedGroup?.name || '';
  return {
    groupName: normalizedGroupName,
    ...(groupId && (!groupName || Object.hasOwn(group, 'groupId')) ? { groupId } : {})
  };
}

function formatSwitchGroupConfirmMessage(site, group = {}) {
  const currentGroup = site?.sync?.remote?.keyGroup || '-';
  const target = group.groupName || group.groupId || '-';
  const suffix = group.groupId && group.groupName
    ? `（ID: ${group.groupId}）`
    : '';
  return `确认将 ${site.name} 的远端分组从 ${currentGroup} 切换到 ${target}${suffix}？`;
}

elements.resetForm.addEventListener('click', () => {
  formDirty = false;
  renderEditor();
});

elements.deleteSite.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (!site || !confirm(`删除 ${site.name}？`)) {
    return;
  }
  await runAction(async () => {
    state = await api.deleteSite(site.id);
    selectedSiteId = state.activeSiteId ?? state.sites[0]?.id ?? null;
    formDirty = false;
    render();
    showToast('站点已删除');
  });
});

elements.cloneSite.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (!site) {
    return;
  }
  await runAction(async () => {
    state = await api.cloneSite(site.id);
    selectedSiteId = state.sites.at(-1)?.id ?? site.id;
    formDirty = false;
    render();
    showToast('站点已复制');
  });
});

async function testSiteById(siteId) {
  const site = state.sites.find((candidate) => candidate.id === siteId);
  if (!site) {
    return;
  }
  await runAction(async () => {
    const result = await api.testSite(site.id);
    applyState(result, { preserveDirtyEditor: true });
    const updated = result.sites.find((candidate) => candidate.id === site.id);
    showToast(
      result.testResult?.ok
        ? updated?.enabled
          ? '测试通过，站点已启用'
          : '测试通过，人工停用未变更'
        : '测试失败，已记录错误'
    );
  });
}

async function testSiteFromList(siteId) {
  const site = state.sites.find((candidate) => candidate.id === siteId);
  if (!site) {
    return;
  }
  if (!formDirty && selectedSiteId !== siteId) {
    selectedSiteId = siteId;
    setWorkspaceView('sites');
    render();
  }
  await testSiteById(siteId);
}

async function detectCapabilitiesById(siteId) {
  await runAction(async () => {
    await detectCapabilitiesByIdUnsafe(siteId);
  });
}

async function detectCapabilitiesByIdUnsafe(siteId) {
  const site = state.sites.find((candidate) => candidate.id === siteId);
  if (!site) {
    return;
  }
  const result = await api.detectSiteCapabilities(site.id);
  applyState(result, { preserveDirtyEditor: true });
  showToast(
    result.capabilityResult?.ok
      ? `模型已刷新：${result.capabilityResult.modelCount ?? 0} 个`
      : '模型探测失败，已记录结果'
  );
}

async function saveCurrentSiteBeforeCapabilityDetection() {
  const existingSite = getSelectedSite();
  const id = elements.siteId.value;
  const nextState = id
    ? await api.updateSite(id, readSiteFormPayload(existingSite))
    : await api.addSite(readSiteFormPayload(existingSite));
  state = nextState;
  selectedSiteId = id || state.sites.at(-1)?.id || state.activeSiteId;
  formDirty = false;
  render();
  return selectedSiteId;
}

async function toggleSiteById(siteId, nextManualEnabled) {
  const site = state.sites.find((candidate) => candidate.id === siteId);
  if (!site) {
    return;
  }
  await runAction(async () => {
    const nextState = await api.setSiteEnabled(site.id, nextManualEnabled);
    applyState(nextState, { preserveDirtyEditor: true });
    showToast(nextManualEnabled ? '站点已启用' : '站点已停用');
  });
}

async function selectSiteById(siteId) {
  const site = state.sites.find((candidate) => candidate.id === siteId);
  if (
    !site ||
    state.proxy.smartSwitching ||
    site.id === state.activeSiteId ||
    getAvailabilityState(site) !== 'enabled'
  ) {
    return;
  }
  await runAction(async () => {
    state = await api.setActiveSite(site.id);
    selectedSiteId = site.id;
    formDirty = false;
    render();
    showToast('当前站点已更新');
  });
}

elements.setActive.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (site) {
    await selectSiteById(site.id);
  }
});

elements.smartSwitch.addEventListener('change', async () => {
  const smartSwitching = elements.smartSwitch.checked;
  await runAction(async () => {
    state = await api.updateProxy({
      ...state.proxy,
      smartSwitching
    });
    render({ preserveEditor: formDirty });
    if (formDirty) {
      renderSetActiveAction(getSelectedSite());
    }
    showToast(smartSwitching ? '已开启自动选择' : '已切换为手动选择');
  });
});

elements.floatingAlwaysOnTop.addEventListener('change', async () => {
  const alwaysOnTop = elements.floatingAlwaysOnTop.checked;
  await runAction(async () => {
    state = await api.updateAppSettings({
      floatingWindow: {
        alwaysOnTop
      }
    });
    render({ preserveEditor: formDirty });
    showToast(alwaysOnTop ? '悬浮窗已保持最前' : '悬浮窗已取消置顶');
  });
});

elements.testSite.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (site) {
    await testSiteById(site.id);
  }
});

elements.detectSiteCapabilities.addEventListener('click', async () => {
  await runAction(async () => {
    const siteId = await saveCurrentSiteBeforeCapabilityDetection();
    if (siteId) {
      await detectCapabilitiesByIdUnsafe(siteId);
    }
  });
});

elements.toggleSelectedSite.addEventListener('click', async () => {
  const site = getSelectedSite();
  if (site) {
    await toggleSiteById(site.id, getSiteToggleAction(site).nextManualEnabled);
  }
});

elements.saveProxy.addEventListener('click', async () => {
  await runAction(async () => {
    state = await api.updateProxy({
      port: Number(elements.proxyPort.value),
      allowLanAccess: elements.allowLanAccess.checked,
      timeoutMs: Number(elements.proxyTimeoutSeconds.value) * 1000,
      maxReplayableRequestBodyBytes: toReplayBufferBytes(elements.proxyReplayBufferMb.value),
      codexRecoveryEnabled: elements.codexRecoveryEnabled.checked,
      failureThreshold: Number(elements.failureThreshold.value),
      testModel: elements.globalTestModel.value.trim() || 'example-chat-model',
      smartSwitching: elements.smartSwitching.checked,
      priorityMode: elements.priorityMode.value,
      samePriorityStrategy: elements.samePriorityStrategy.value,
      autoSwitchMultiplierLimit: {
        enabled: elements.autoSwitchMultiplierLimitEnabled.checked,
        maxMultiplier: Number(elements.autoSwitchMaxMultiplier.value || 1)
      }
    });
    state = await api.updateModelMapping(
      readModelMappingFormPayload(
        elements.globalModelMappingEnabled,
        elements.globalModelMappingRows,
        '全局模型映射'
      )
    );
    render();
    showToast('代理设置已保存');
  });
});

elements.saveSiteSyncSettings.addEventListener('click', async () => {
  await runAction(async () => {
    state = await api.updateSiteSyncSettings({
      intervalValue: Number(elements.siteSyncGlobalIntervalValue.value || 30),
      intervalUnit: elements.siteSyncGlobalIntervalUnit.value,
      intelligentScheduling: elements.siteSyncIntelligentScheduling.checked
    });
    state = await api.updateGroupSyncSettings({
      intervalValue: Number(elements.groupSyncIntervalValue.value || 30),
      intervalUnit: elements.groupSyncIntervalUnit.value
    });
    render();
    showToast('同步设置已保存');
  });
});

elements.saveMonitoring.addEventListener('click', async () => {
  const settings = readMonitoringSettingsFormPayload();
  if (settings.enabled && !settings.feishuWebhook) {
    showToast('请先填写飞书 Webhook');
    elements.feishuWebhook.focus();
    return;
  }
  await runAction(async () => {
    state = await api.updateMonitoringSettings(settings);
    render();
    showToast('飞书监控设置已保存');
  });
});

elements.testFeishuWebhook.addEventListener('click', async () => {
  const webhook = elements.feishuWebhook.value.trim();
  if (!webhook) {
    showToast('请先填写飞书 Webhook');
    elements.feishuWebhook.focus();
    return;
  }
  await runAction(async () => {
    await api.testFeishuWebhook(webhook);
    showToast('飞书测试消息已发送');
  });
});

elements.installMonitoringTask.addEventListener('click', async () => {
  const settings = readMonitoringSettingsFormPayload();
  if (!settings.feishuWebhook) {
    showToast('请先填写飞书 Webhook');
    elements.feishuWebhook.focus();
    return;
  }
  await runAction(async () => {
    state = await api.updateMonitoringSettings({ ...settings, enabled: true });
    monitoringTaskStatus = await api.installMonitoringTask();
    render();
    showToast('飞书监控后台任务已安装并启动');
  });
});

elements.removeMonitoringTask.addEventListener('click', async () => {
  await runAction(async () => {
    state = await api.updateMonitoringSettings({ enabled: false });
    monitoringTaskStatus = await api.removeMonitoringTask();
    render();
    showToast('飞书监控后台任务已移除');
  });
});

elements.restartProxy.addEventListener('click', async () => {
  await runAction(async () => {
    state = await api.restartProxy();
    render();
    showToast('代理已重启');
  });
});

async function copyProxyUrl() {
  const proxyUrl = elements.proxyUrl.textContent.trim();
  if (!proxyUrl) {
    return;
  }

  await runAction(async () => {
    await copyTextToClipboard(proxyUrl);
    showToast('代理地址已复制');
  });
}

async function copyTextToClipboard(text) {
  if (api.copyText) {
    await api.copyText(text);
    return;
  }
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('当前环境不支持剪贴板写入');
}

function isCopyProxyUrlShortcut(event) {
  return (
    String(event.key ?? '').toLowerCase() === 'c' &&
    event.shiftKey === true &&
    event.altKey !== true &&
    (event.ctrlKey === true || event.metaKey === true)
  );
}

async function runAction(action) {
  try {
    await action();
    return true;
  } catch (error) {
    logRuntimeError('renderer.action-error', error);
    showToast(error.message || String(error));
    return false;
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function installGlobalErrorHandlers() {
  window.addEventListener?.('error', (event) => {
    logRuntimeError('renderer.global-error', event.error ?? event.message, {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
    showToast(`界面运行错误：${formatRuntimeError(event.error ?? event.message)}`);
  });
  window.addEventListener?.('unhandledrejection', (event) => {
    logRuntimeError('renderer.unhandled-rejection', event.reason);
    showToast(`界面异步错误：${formatRuntimeError(event.reason)}`);
  });
}

function formatRuntimeError(error) {
  return error?.message ?? String(error ?? '未知错误');
}

function logRuntimeError(source, error, context = {}) {
  if (!api.logRuntimeError) {
    return;
  }

  api.logRuntimeError({
    source,
    error: serializeRuntimeError(error),
    message: formatRuntimeError(error),
    context
  }).catch(() => {});
}

function serializeRuntimeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  if (error && typeof error === 'object') {
    return {
      name: error.name ?? 'Error',
      message: error.message ?? String(error),
      stack: error.stack
    };
  }

  return {
    name: typeof error,
    message: String(error ?? '鏈煡閿欒')
  };
}

export function buildRequestDashboard(sites = [], period = 'hour') {
  const selectedPeriod = normalizeDashboardPeriod(period);
  const bucketsByKey = new Map();

  for (const site of sites) {
    for (const bucket of site.requestStats?.[selectedPeriod] ?? []) {
      const existing = bucketsByKey.get(bucket.key) ?? {
        key: bucket.key,
        startedAt: bucket.startedAt,
        requestCount: 0,
        successCount: 0,
        errorCount: 0
      };
      const successCount = normalizeCount(bucket.successCount);
      const errorCount = normalizeCount(bucket.errorCount);
      existing.startedAt = existing.startedAt ?? bucket.startedAt;
      existing.successCount += successCount;
      existing.errorCount += errorCount;
      existing.requestCount += successCount + errorCount;
      bucketsByKey.set(bucket.key, existing);
    }
  }

  const buckets = [...bucketsByKey.values()]
    .map((bucket) => ({
      ...bucket,
      successRate: calculateSuccessRate(bucket.successCount, bucket.errorCount)
    }))
    .sort((left, right) => {
      const leftTime = new Date(left.startedAt).getTime();
      const rightTime = new Date(right.startedAt).getTime();
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.key.localeCompare(right.key);
    });

  const summary = buckets.reduce(
    (total, bucket) => ({
      requestCount: total.requestCount + bucket.requestCount,
      successCount: total.successCount + bucket.successCount,
      errorCount: total.errorCount + bucket.errorCount
    }),
    { requestCount: 0, successCount: 0, errorCount: 0 }
  );

  return {
    period: selectedPeriod,
    buckets,
    summary: {
      ...summary,
      successRate: calculateSuccessRate(summary.successCount, summary.errorCount)
    }
  };
}

export function calculateSuccessRate(successCount, errorCount) {
  const success = normalizeCount(successCount);
  const error = normalizeCount(errorCount);
  const total = success + error;
  return total === 0 ? null : success / total;
}

export function formatSuccessRate(rate) {
  if (!Number.isFinite(rate)) {
    return '-';
  }

  const percent = rate * 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

export function formatMultiplier(multiplier) {
  const number = Number(multiplier ?? 1);
  if (!Number.isFinite(number)) {
    return '1';
  }
  const normalized = number === 0 ? 0 : Number(number.toPrecision(15));
  return Number.isInteger(normalized) ? normalized.toFixed(0) : String(normalized);
}

function toReplayBufferMegabytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_PROXY_REPLAY_BUFFER_MB;
  }
  return Math.round(value / BYTES_PER_MEGABYTE);
}

function toReplayBufferBytes(megabytes) {
  return Number(megabytes) * BYTES_PER_MEGABYTE;
}

function renderBalanceBadge(site) {
  return `<span class="site-balance-badge">余额 ${escapeHtml(getSiteBalanceText(site))}</span>`;
}

function renderMultiplierBadge(site) {
  const classes = [
    'site-multiplier-badge',
    hasRecentSyncFailure(site) ? 'is-danger' : ''
  ].filter(Boolean).join(' ');
  return `<span class="${classes}">实际倍率 ${escapeHtml(formatEffectiveMultiplier(site))}</span>`;
}

function formatEffectiveMultiplier(site) {
  return formatMultiplier(calculateEffectiveMultiplier(site));
}

function getSiteBalanceText(site) {
  const balance = site?.sync?.remote?.balance;
  return balance ? String(balance) : '-';
}

export function buildTopSyncedGroups(sites = [], limit = 3) {
  const entriesBySite = new Map();

  for (const site of sites) {
    const filterKey = getSiteGroupFilterKey(site);
    const lowestGroup = normalizeRemoteGroups(site?.sync?.remote?.groups)
      .filter((group) => Number.isFinite(group.multiplier))
      .map((group) => ({
        group,
        effectiveMultiplier: calculateEffectiveGroupMultiplier(site, group)
      }))
      .sort((left, right) => {
        const multiplierOrder = compareNumbersAscending(
          getSortableGroupMultiplier(left.effectiveMultiplier),
          getSortableGroupMultiplier(right.effectiveMultiplier)
        );
        return multiplierOrder !== 0
          ? multiplierOrder
          : left.group.name.localeCompare(right.group.name);
      })[0];
    if (!lowestGroup) {
      continue;
    }

    const candidate = {
      site,
      group: lowestGroup.group,
      effectiveMultiplier: lowestGroup.effectiveMultiplier,
      filterKey
    };
    const existing = entriesBySite.get(filterKey);
    if (existing && compareTopGroupEntries(existing, candidate) <= 0) {
      continue;
    }
    entriesBySite.set(filterKey, candidate);
  }

  return [...entriesBySite.values()]
    .sort(compareTopGroupEntries)
    .slice(0, normalizeTopGroupLimit(limit));
}

function compareTopGroupEntries(left, right) {
  const multiplierOrder = compareNumbersAscending(
    getSortableGroupMultiplier(left.effectiveMultiplier),
    getSortableGroupMultiplier(right.effectiveMultiplier)
  );
  if (multiplierOrder !== 0) {
    return multiplierOrder;
  }
  const siteOrder = String(left.site?.name ?? '').localeCompare(String(right.site?.name ?? ''));
  return siteOrder !== 0 ? siteOrder : left.group.name.localeCompare(right.group.name);
}

function normalizeRemoteGroups(groups = []) {
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups
    .map((group) => ({
      id: String(group?.id ?? '').trim(),
      name: String(group?.name ?? '').trim(),
      multiplier: normalizeOptionalGroupMultiplier(group?.multiplier),
      selected: Boolean(group?.selected)
    }))
    .filter((group) => group.name);
}

function normalizeOptionalGroupMultiplier(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function getSortableGroupMultiplier(multiplier) {
  return Number.isFinite(multiplier) ? multiplier : Number.POSITIVE_INFINITY;
}

function calculateEffectiveGroupMultiplier(site, group) {
  const remoteMultiplier = normalizeOptionalGroupMultiplier(group?.multiplier);
  if (!Number.isFinite(remoteMultiplier)) {
    return null;
  }
  return calculateEffectiveMultiplier({
    ...site,
    multiplier: remoteMultiplier,
    sync: {
      ...site?.sync,
      remote: {
        ...site?.sync?.remote,
        groupMultiplier: remoteMultiplier
      }
    }
  });
}

function getAppliedGroupCustomMultiplier(site) {
  if (site?.multiplierLocked) {
    return 1;
  }
  const customMultiplier = Number(site?.customMultiplier);
  return Number.isFinite(customMultiplier) && customMultiplier > 0 ? customMultiplier : 1;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeTopGroupLimit(value) {
  if (value === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return normalizePositiveInteger(value, 3);
}

function getSiteGroupFilterKey(site) {
  const remote = site?.sync?.remote ?? {};
  return normalizeGroupFilterKey(
    site?.sync?.dashboardUrl ||
    remote.apiEndpoint ||
    site?.baseUrl ||
    site?.id
  );
}

function normalizeGroupFilterKey(value) {
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

function formatGroupChipLabel(group, multiplier = group?.multiplier) {
  const name = String(group?.name ?? '').trim();
  const multiplierText = formatGroupMultiplierText(multiplier);
  if (multiplierText === '-' || name.toLowerCase().includes(multiplierText.toLowerCase())) {
    return name || '-';
  }
  return `${name} · ${multiplierText}`;
}

function formatGroupMultiplierText(multiplier) {
  const formatted = formatOptionalMultiplier(multiplier);
  return formatted === '-' ? '-' : `${formatted}x`;
}

function formatGroupTooltip(entry) {
  const sync = entry.site?.sync ?? {};
  const remote = sync.remote ?? {};
  return [
    `站点：${entry.site?.name ?? '-'}`,
    `分组：${entry.group.name}`,
    `远端倍率：${formatGroupMultiplierText(entry.group.multiplier)}`,
    `自定义倍数：${formatGroupMultiplierText(getAppliedGroupCustomMultiplier(entry.site))}`,
    `实际倍率：${formatGroupMultiplierText(entry.effectiveMultiplier)}`,
    remote.balance ? `余额：${remote.balance}` : null,
    remote.keyName ? `密钥：${remote.keyName}` : null,
    sync.dashboardUrl ? `后台：${sync.dashboardUrl}` : null,
    sync.lastSyncAt ? `同步：${formatLocalDateTime(sync.lastSyncAt)}` : null
  ].filter(Boolean).join('\n');
}

function hasRecentSyncFailure(site) {
  return site?.sync?.lastSyncStatus === 'failure';
}

function formatOptionalMultiplier(multiplier) {
  return multiplier === null || multiplier === undefined ? '-' : formatMultiplier(multiplier);
}

function readSiteMultiplier() {
  const number = Number(String(elements.multiplier.value ?? '').trim() || 1);
  return Number.isFinite(number) && number >= 0 ? number : 1;
}

function readCustomMultiplier() {
  if (!elements.customMultiplierEnabled.checked) {
    return null;
  }
  const number = Number(String(elements.customMultiplier.value ?? '').trim());
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('自定义倍数必须大于 0');
  }
  return number;
}

function updateCustomMultiplierState() {
  const locked = elements.multiplierLocked.checked;
  elements.customMultiplierEnabled.disabled = locked;
  elements.customMultiplier.disabled = locked || !elements.customMultiplierEnabled.checked;
}

function renderMultiplierPreview(site) {
  const accountMultiplier = site?.sync?.remote?.groupMultiplier;
  const customMultiplier = elements.customMultiplierEnabled.checked
    ? Number(elements.customMultiplier.value)
    : null;
  elements.accountMultiplier.textContent = formatOptionalMultiplier(accountMultiplier);
  elements.effectiveMultiplier.textContent = formatEffectiveMultiplier({
    multiplier: readSiteMultiplier(),
    multiplierLocked: elements.multiplierLocked.checked,
    customMultiplier: Number.isFinite(customMultiplier) && customMultiplier > 0
      ? customMultiplier
      : null,
    sync: site?.sync
  });
}

function readModelMappingFormPayload(enabledInput, rowsElement, label = '模型映射') {
  const enabled = Boolean(enabledInput.checked);
  const mappings = enabled
    ? readModelMappingRows(rowsElement, label)
    : readLooseModelMappingRows(rowsElement);
  if (enabled && mappings.length === 0) {
    throw new Error(`${label}已启用，但没有有效映射`);
  }
  return {
    enabled,
    mappings
  };
}

function renderModelMappingEditor({ rowsElement, textElement, modelMapping = {} }) {
  const mappings = Array.isArray(modelMapping?.mappings) ? modelMapping.mappings : [];
  const rows = mappings.length > 0 ? mappings : [{ from: '', to: '' }];
  replaceChildren(
    rowsElement,
    rows.map((entry) => createModelMappingRow(entry))
  );
  textElement.value = formatModelMappingLines({ mappings });
}

function appendModelMappingRow(rowsElement, entry) {
  rowsElement.append(createModelMappingRow(entry));
}

function createModelMappingRow(entry = {}) {
  const row = document.createElement('div');
  row.className = 'model-mapping-row';

  const source = document.createElement('input');
  source.type = 'text';
  source.autocomplete = 'off';
  source.placeholder = '请求模型，如 request-model';
  source.value = entry?.from ?? '';
  source.dataset.field = 'from';
  source.addEventListener('input', () => {
    syncModelMappingTextForRow(row);
  });

  const arrow = document.createElement('span');
  arrow.className = 'model-mapping-arrow';
  arrow.textContent = '->';

  const target = document.createElement('input');
  target.type = 'text';
  target.autocomplete = 'off';
  target.placeholder = '转发模型，如 upstream-model';
  target.value = entry?.to ?? '';
  target.dataset.field = 'to';
  target.addEventListener('input', () => {
    syncModelMappingTextForRow(row);
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary model-mapping-remove';
  remove.textContent = '删除';
  remove.title = '删除这条模型映射';
  remove.addEventListener('click', () => {
    const rowsElement = row.parentElement;
    row.remove?.();
    if (rowsElement && getElementChildren(rowsElement).length === 0) {
      appendModelMappingRow(rowsElement, { from: '', to: '' });
    }
    syncModelMappingTextForRowsElement(rowsElement);
  });

  row.append(source, arrow, target, remove);
  return row;
}

function syncModelMappingTextForRow(row) {
  syncModelMappingTextForRowsElement(row?.parentElement);
}

function syncModelMappingTextForRowsElement(rowsElement) {
  if (rowsElement === elements.globalModelMappingRows) {
    syncModelMappingTextFromRows(rowsElement, elements.globalModelMapping);
    return;
  }
  if (rowsElement === elements.siteModelMappingRows) {
    syncModelMappingTextFromRows(rowsElement, elements.siteModelMapping);
  }
}

function syncModelMappingTextFromRows(rowsElement, textElement) {
  textElement.value = readLooseModelMappingRows(rowsElement)
    .map((entry) => `${entry.from}=${entry.to}`)
    .join('\n');
}

function replaceModelMappingRowsFromText(rowsElement, textElement) {
  const mappings = parseModelMappingText(textElement.value);
  replaceChildren(
    rowsElement,
    (mappings.length > 0 ? mappings : [{ from: '', to: '' }])
      .map((entry) => createModelMappingRow(entry))
  );
  textElement.value = formatModelMappingLines({ mappings });
}

function readModelMappingRows(rowsElement, label) {
  const seen = new Set();
  const mappings = [];
  for (const [index, row] of getElementChildren(rowsElement).entries()) {
    const from = getModelMappingRowValue(row, 'from');
    const to = getModelMappingRowValue(row, 'to');
    if (!from && !to) {
      continue;
    }
    if (!from || !to) {
      throw new Error(`${label}第 ${index + 1} 行需要同时填写源模型和目标模型`);
    }
    if (seen.has(from)) {
      throw new Error(`${label}存在重复源模型：${from}`);
    }
    seen.add(from);
    mappings.push({ from, to });
  }
  return mappings;
}

function readLooseModelMappingRows(rowsElement) {
  return getElementChildren(rowsElement)
    .map((row) => ({
      from: getModelMappingRowValue(row, 'from'),
      to: getModelMappingRowValue(row, 'to')
    }))
    .filter((entry) => entry.from && entry.to);
}

function getModelMappingRowValue(row, field) {
  const input = getElementChildren(row).find((child) => child.dataset?.field === field);
  return String(input?.value ?? '').trim();
}

export function parseModelMappingText(value = '') {
  const text = String(value ?? '').trim();
  if (!text) {
    return [];
  }

  const jsonEntries = parseModelMappingJson(text);
  if (jsonEntries) {
    return normalizeModelMappingEntries(jsonEntries);
  }

  return normalizeModelMappingEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(parseModelMappingLine)
  );
}

function parseModelMappingJson(text) {
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([from, to]) => ({ from, to }));
    }
  } catch {
    return null;
  }

  return null;
}

function parseModelMappingLine(line) {
  const delimiter = line.includes('->') ? '->' : '=';
  const [from, ...targetParts] = line.split(delimiter);
  return {
    from,
    to: targetParts.join(delimiter)
  };
}

function normalizeModelMappingEntries(entries = []) {
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    const from = String(entry?.from ?? '').trim();
    const to = String(entry?.to ?? '').trim();
    if (!from || !to || seen.has(from)) {
      continue;
    }
    seen.add(from);
    normalized.push({ from, to });
  }
  return normalized;
}

export function formatModelMappingLines(modelMapping = {}) {
  return (modelMapping?.mappings ?? [])
    .map((entry) => `${entry.from}=${entry.to}`)
    .join('\n');
}

function formatModelMappingSummary(siteModelMapping, globalModelMapping) {
  const siteCount = siteModelMapping?.enabled ? (siteModelMapping.mappings?.length ?? 0) : 0;
  const globalCount = globalModelMapping?.enabled ? (globalModelMapping.mappings?.length ?? 0) : 0;
  const parts = [];
  if (siteCount > 0) {
    parts.push(`单站点 ${siteCount} 条`);
  }
  if (globalCount > 0) {
    parts.push(`全局 ${globalCount} 条`);
  }
  return parts.length > 0 ? parts.join(' · ') : '未启用';
}

function formatCapabilitySummary(capabilities) {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.lastStatus === 'failure') {
    return normalized.lastError ? `探测失败 · ${normalized.lastError}` : '探测失败';
  }
  if (!normalized.lastStatus) {
    return '尚未探测';
  }

  const enabledLabels = capabilityOrder
    .filter((key) => normalized.features[key])
    .map((key) => capabilityLabels[key]);
  return enabledLabels.length > 0
    ? enabledLabels.join('、')
    : '未从模型列表识别能力';
}

function readSyncFormPayload(existingSync = {}) {
  return {
    ...existingSync,
    enabled: elements.syncEnabled.checked,
    accountId: elements.syncAccount.value,
    dashboardUrl: elements.syncDashboardUrl.value.trim(),
    username: elements.syncUsername.value.trim(),
    password: elements.syncPassword.value.trim(),
    providerType: elements.syncProviderType.value,
    intervalMode: elements.syncIntervalMode.value === 'custom' ? 'custom' : 'global',
    intervalValue: Number(elements.syncIntervalValue.value || 30),
    intervalUnit: elements.syncIntervalUnit.value
  };
}

function updateSyncIntervalModeState() {
  const custom = elements.syncIntervalMode.value === 'custom';
  elements.syncIntervalValue.disabled = !custom;
  elements.syncIntervalUnit.disabled = !custom;
}

export function formatSyncSummary(sync) {
  if (!sync) {
    return '未同步';
  }
  if (sync.lastSyncStatus === 'failure') {
    return `同步失败：${sync.lastSyncError || '未知错误'}`;
  }

  const remote = sync.remote ?? {};
  const parts = [
    remote.providerType || sync.providerType || null,
    remote.balance ? `余额 ${remote.balance}` : null,
    remote.keyName ? `密钥 ${remote.keyName}` : null,
    remote.keyGroup ? `分组 ${remote.keyGroup}` : null,
    remote.groupMultiplier !== null && remote.groupMultiplier !== undefined
      ? `倍率 ${formatMultiplier(remote.groupMultiplier)}`
      : null,
    sync.lastSyncAt ? `同步 ${formatLocalDateTime(sync.lastSyncAt)}` : null
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(' · ');
  }
  return sync.enabled ? '已启用，尚未同步' : '未同步';
}

export function formatProxyError(error, configuredPort) {
  const message = error?.message ?? String(error ?? '');
  if (!message) {
    return '';
  }

  if (error?.code === 'EADDRINUSE' || message.includes('EADDRINUSE')) {
    return `端口 ${configuredPort} 被占用，已尝试结束占用进程但仍无法启动。请手动释放端口或修改端口配置。`;
  }

  return `代理启动失败：${message}`;
}

function statusClass(status) {
  if (status === 'success') {
    return 'success';
  }
  if (status === 'error') {
    return 'error';
  }
  return 'idle';
}

function availabilityClass(site) {
  const availabilityState = getAvailabilityState(site);
  if (availabilityState === 'enabled') {
    return 'success';
  }
  if (availabilityState === 'failure-disabled' || availabilityState === 'rate-limited') {
    return 'error';
  }
  return 'idle';
}

function summarizeSites(sites = []) {
  return sites.reduce(
    (summary, site) => {
      if (getAvailabilityState(site) === 'enabled') {
        summary.enabled += 1;
      } else {
        summary.unavailable += 1;
      }
      return summary;
    },
    { enabled: 0, unavailable: 0 }
  );
}

export function filterSitesByAvailability(sites = [], filter = 'all', now = new Date()) {
  const normalizedFilter = normalizeSiteStatusFilter(filter);
  if (normalizedFilter === 'all') {
    return sites;
  }

  return sites.filter((site) => {
    const availabilityState = getAvailabilityState(site, now);
    if (normalizedFilter === 'unavailable') {
      return availabilityState !== 'enabled';
    }
    return availabilityState === normalizedFilter;
  });
}

export function filterSitesByGroupSite(sites = [], filterKey = null) {
  if (!filterKey) {
    return sites;
  }
  return sites.filter((site) => getSiteGroupFilterKey(site) === filterKey);
}

export function sortSitesForList(sites = [], sort = 'default') {
  const normalizedSort = normalizeSiteSort(sort);
  if (normalizedSort === 'default') {
    return sites;
  }

  return sites
    .map((site, index) => ({ site, index }))
    .sort((left, right) => {
      const order = compareSitesForListSort(left.site, right.site, normalizedSort);
      return order === 0 ? left.index - right.index : order;
    })
    .map(({ site }) => site);
}

function compareSitesForListSort(left, right, sort) {
  if (sort === 'requests') {
    return compareNumbersDescending(
      normalizeCount(left?.requestCount),
      normalizeCount(right?.requestCount)
    );
  }

  if (sort === 'success-rate') {
    return compareNumbersDescending(
      getSortableSuccessRate(left),
      getSortableSuccessRate(right)
    );
  }

  if (sort === 'balance') {
    return compareNumbersDescending(
      parseBalanceAmount(left?.sync?.remote?.balance),
      parseBalanceAmount(right?.sync?.remote?.balance)
    );
  }

  if (sort === 'multiplier') {
    return compareNumbersAscending(
      getSortableMultiplier(left),
      getSortableMultiplier(right)
    );
  }

  return 0;
}

function getSortableSuccessRate(site) {
  const rate = calculateSuccessRate(site?.successCount, site?.errorCount);
  return Number.isFinite(rate) ? rate : Number.NEGATIVE_INFINITY;
}

function getSortableMultiplier(site) {
  return calculateEffectiveMultiplier(site);
}

function parseBalanceAmount(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NEGATIVE_INFINITY;
  }

  const match = String(value).replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return Number.NEGATIVE_INFINITY;
  }

  const number = Number(match[0]);
  return Number.isFinite(number) ? number : Number.NEGATIVE_INFINITY;
}

function compareNumbersDescending(left, right) {
  if (left !== right) {
    return right - left;
  }
  return 0;
}

function compareNumbersAscending(left, right) {
  if (left !== right) {
    return left - right;
  }
  return 0;
}

function formatSiteListSummary(sites, filteredSites, filter, siteSummary) {
  const groupFilterSite = selectedGroupFilterKey
    ? sites.find((site) => getSiteGroupFilterKey(site) === selectedGroupFilterKey)
    : null;
  const groupFilterSuffix = groupFilterSite ? ` · 站点筛选 ${groupFilterSite.name}` : '';
  const baseSummary =
    `${sites.length} 个配置 · ${siteSummary.enabled} 可用 · ${siteSummary.unavailable} 不可用`;

  if (filter === 'all') {
    return `${baseSummary}${groupFilterSuffix}`;
  }

  return `${filteredSites.length}/${sites.length} 个配置 · ${siteStatusFilterLabels[filter]} · ` +
    `${siteSummary.enabled} 可用 · ${siteSummary.unavailable} 不可用${groupFilterSuffix}`;
}

function normalizeSiteStatusFilter(filter) {
  return Object.hasOwn(siteStatusFilterLabels, filter) ? filter : 'all';
}

function normalizeSiteSort(sort) {
  return Object.hasOwn(siteSortLabels, sort) ? sort : 'default';
}

function normalizeConfigExportMode(mode) {
  return ['all', 'current', 'selected'].includes(mode) ? mode : 'all';
}

function getLastRequestBorderClass(site) {
  const lastSuccessTime = getValidTime(site?.lastSuccessAt);
  const lastErrorTime = getValidTime(site?.lastErrorAt);
  const statusBorderClass = getStatusBorderClass(site?.status);

  if (lastSuccessTime === null && lastErrorTime === null) {
    return statusBorderClass;
  }

  if (lastSuccessTime !== null && lastErrorTime !== null && lastSuccessTime === lastErrorTime) {
    return statusBorderClass || 'last-error';
  }

  if (lastSuccessTime !== null && (lastErrorTime === null || lastSuccessTime >= lastErrorTime)) {
    return 'last-success';
  }
  return 'last-error';
}

function getStatusBorderClass(status) {
  if (status === 'success') {
    return 'last-success';
  }
  if (status === 'error') {
    return 'last-error';
  }
  return '';
}

function getValidTime(value) {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function getAvailabilityState(site, now = new Date()) {
  const manualEnabled = site?.manualEnabled ?? site?.enabled ?? true;
  if (!manualEnabled) {
    return 'manual-disabled';
  }
  if (site?.failureDisabled) {
    return 'failure-disabled';
  }
  if (isRateLimitPaused(site, now)) {
    return 'rate-limited';
  }
  return 'enabled';
}

export function formatAvailabilityLabel(site, now = new Date()) {
  const availabilityState = getAvailabilityState(site, now);
  if (availabilityState === 'manual-disabled') {
    return '人工停用';
  }
  if (availabilityState === 'failure-disabled') {
    return '错误停用';
  }
  if (availabilityState === 'rate-limited') {
    return '限速暂停';
  }
  return '启用中';
}

export function getSiteToggleAction(site, now = new Date()) {
  const canUse = getAvailabilityState(site, now) === 'enabled';
  return canUse
    ? { label: '停用', nextManualEnabled: false }
    : { label: '启用', nextManualEnabled: true };
}

function isRateLimitPaused(site, now = new Date()) {
  if (!site?.rateLimit?.enabled || !site?.rateLimitState?.pausedUntil) {
    return false;
  }
  return new Date(site.rateLimitState.pausedUntil).getTime() > new Date(now).getTime();
}

function formatStatus(status) {
  if (status === 'success') {
    return '成功';
  }
  if (status === 'error') {
    return '错误';
  }
  return '待请求';
}

export function formatRateLimitSummary(site) {
  if (!site?.rateLimit?.enabled) {
    return '不限速';
  }

  const unit = site.rateLimit.windowUnit === 'hour' ? '小时' : '分钟';
  const pausedUntil = site.rateLimitState?.pausedUntil;
  const usage = `${site.rateLimitState?.used ?? 0}/${site.rateLimit.limit}`;
  return pausedUntil
    ? `限速 ${site.rateLimit.limit} 次/${site.rateLimit.windowValue}${unit} · 已暂停到 ${formatLocalDateTime(pausedUntil)}`
    : `限速 ${site.rateLimit.limit} 次/${site.rateLimit.windowValue}${unit} · 已用 ${usage}`;
}

export function formatAutoRecoverySummary(site) {
  if (!site?.autoRecovery?.enabled) {
    return '错误停用后自检关闭';
  }

  if ((site.manualEnabled ?? site.enabled ?? true) === false) {
    return '人工停用不自检';
  }

  const unit = site.autoRecovery.intervalUnit === 'hour' ? '小时' : '分钟';
  const intervalValue = Number(site.autoRecovery.intervalValue) || 1;
  const summary = `错误停用后每${intervalValue}${unit}自检`;
  const nextCheckAt = site.autoRecoveryState?.nextCheckAt;

  return nextCheckAt ? `${summary} · 下次 ${formatLocalDateTime(nextCheckAt)}` : summary;
}

function formatAutoRecoveryResult(site) {
  const result = site?.autoRecoveryState?.lastResult;
  if (result === 'success') {
    return site.autoRecoveryState.lastMessage
      ? `成功 · ${site.autoRecoveryState.lastMessage}`
      : '成功';
  }
  if (result === 'failure') {
    return site.autoRecoveryState.lastMessage
      ? `失败 · ${site.autoRecoveryState.lastMessage}`
      : '失败';
  }
  return '-';
}

function normalizeDashboardPeriod(period) {
  return ['hour', 'day', 'week', 'month'].includes(period) ? period : 'hour';
}

function normalizeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function formatDashboardBucketLabel(bucket, period) {
  if (period === 'hour') {
    const date = new Date(bucket.startedAt);
    if (!Number.isFinite(date.getTime())) {
      return bucket.key;
    }
    return `${formatMonthDay(date)} ${String(date.getHours()).padStart(2, '0')}:00`;
  }
  if (period === 'day') {
    return formatLocalDate(bucket.startedAt, bucket.key);
  }
  if (period === 'week') {
    return `${bucket.key} · ${formatLocalDate(bucket.startedAt, bucket.key)}`;
  }
  if (period === 'month') {
    return bucket.key;
  }
  return bucket.key;
}

export function formatLastRequestText(lastRequestAt, now = new Date()) {
  if (!lastRequestAt) {
    return '尚无请求';
  }

  const requestTime = new Date(lastRequestAt).getTime();
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(requestTime) || !Number.isFinite(nowTime)) {
    return '尚无请求';
  }

  const elapsedMs = Math.max(0, nowTime - requestTime);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}分钟之前`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}小时之前`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}天之前`;
}

export function formatLocalDateTime(value, fallback = '-') {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return fallback;
  }

  const pad = (part) => String(part).padStart(2, '0');
  const dateText = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-');
  const timeText = [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':');

  return `${dateText} ${timeText}`;
}

function formatLocalDate(value, fallback = '-') {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return fallback;
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function formatMonthDay(date) {
  return [
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const replacements = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return replacements[char];
  });
}

init().catch((error) => showToast(error.message || String(error)));
