import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';

import { APP_DISPLAY_NAME, APP_ID, selectUserDataPath } from './app-identity.js';
import { CodexRecoveryCoordinator } from './codex/codex-recovery-coordinator.js';
import { ConfigService } from './proxy/config-service.js';
import { DisabledSiteAutoRecoveryScheduler } from './proxy/disabled-site-auto-recovery.js';
import { OpenApiProxyServer } from './proxy/proxy-server.js';
import { buildProxyAccessUrls } from './proxy/network-access.js';
import { PortOccupancyGuard } from './proxy/port-occupancy-guard.js';
import { detectSiteCapabilities } from './proxy/site-capabilities.js';
import { startProxyWithFallback } from './proxy/start-proxy-with-fallback.js';
import { testConfiguredSite } from './proxy/site-actions.js';
import {
  createConfiguredSiteKey,
  logoutConfiguredSiteAccount,
  switchConfiguredSiteGroup,
  syncAllConfiguredSites,
  syncConfiguredSite,
  syncGroupWebsite
} from './proxy/site-sync-actions.js';
import { SiteSyncScheduler } from './proxy/site-sync-scheduler.js';
import { createActivityLogger, createRuntimeLogger } from './runtime-logger.js';
import { createCoalescedStateBroadcaster } from './state-broadcaster.js';
import { sendFeishuWebhook } from './monitoring/feishu-watchdog.js';
import {
  getWatchdogTaskStatus,
  installWatchdogTask,
  removeWatchdogTask
} from './monitoring/windows-watchdog-task.js';
import {
  resolveRemoteBrowserSessionWithWindow,
  resolveTurnstileTokenWithWindow
} from './turnstile-token-window.js';
import { hideMainWindowOnClose, showMainWindow } from './window-lifecycle.js';
import { loadWindowSize, MIN_WINDOW_SIZE, saveWindowSize } from './window-state.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MAX_RECENT_ROUTE_TRACES = 50;

app.setName(APP_DISPLAY_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow = null;
let floatingWindow = null;
let floatingWindowCompactBounds = null;
let floatingWindowPositionSaveTimer = null;
let pendingFloatingWindowPosition = null;
let configService = null;
let proxyServer = null;
let autoRecoveryScheduler = null;
let codexRecoveryCoordinator = null;
let siteSyncScheduler = null;
let portOccupancyGuard = null;
let windowStateFilePath = null;
let stateBroadcaster = null;
let pendingSitePatchTimer = null;
let pendingSitePatchIds = new Set();
let pendingConfigImports = new Map();
let runtimeLogger = null;
let activityLogger = null;
let recentRouteTraces = [];
let processErrorHandlersInstalled = false;
let quitting = false;
let pendingLocalApiKey = null;

async function createWindow() {
  const savedWindowSize = loadWindowSize(windowStateFilePath);

  mainWindow = new BrowserWindow({
    width: savedWindowSize.width,
    height: savedWindowSize.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: APP_DISPLAY_NAME,
    backgroundColor: '#eaf3fa',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  trackWindowSize(mainWindow);
  trackWindowRuntimeErrors(mainWindow);
  mainWindow.on('close', (event) => {
    const hidden = hideMainWindowOnClose({
      event,
      window: mainWindow,
      quitting
    });
    if (hidden) {
      logLifecycleEvent(
        'main-window.hidden',
        'Main window close request was converted to hide',
        { reason: 'window-close' }
      );
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
}

async function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    return floatingWindow;
  }

  const width = 92;
  const height = 92;
  const initialBounds = getInitialFloatingWindowBounds(width, height);
  floatingWindowCompactBounds = initialBounds;
  floatingWindow = new BrowserWindow({
    width,
    height,
    x: initialBounds.x,
    y: initialBounds.y,
    minWidth: 92,
    minHeight: 92,
    maxWidth: 380,
    maxHeight: 320,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    title: `${APP_DISPLAY_NAME} 悬浮窗`,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: getFloatingWindowAlwaysOnTop(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  trackWindowRuntimeErrors(floatingWindow);
  floatingWindow.on('closed', () => {
    if (!quitting) {
      logRuntimeError('floating-window.closed', new Error('Floating window was closed'));
    }
    floatingWindow = null;
  });
  applyFloatingWindowSettings();
  try {
    await floatingWindow.loadFile(join(__dirname, 'renderer', 'floating.html'));
  } catch (error) {
    await logRuntimeError('floating-window.load-failed', error);
    if (!floatingWindow.isDestroyed()) {
      floatingWindow.destroy();
    }
    throw error;
  }
  if (!floatingWindow.isDestroyed()) {
    floatingWindow.showInactive();
  }
  return floatingWindow;
}

async function bootstrap() {
  const userDataPath = selectUserDataPath({ appDataPath: app.getPath('appData') });
  app.setPath('userData', userDataPath);
  runtimeLogger = createRuntimeLogger({
    userDataPath,
    appVersion: app.getVersion?.()
  });
  activityLogger = createActivityLogger({
    userDataPath,
    appVersion: app.getVersion?.()
  });
  windowStateFilePath = join(userDataPath, 'window-state.json');

  configService = new ConfigService({
    filePath: join(userDataPath, 'config.json')
  });
  await configService.load();
  pendingLocalApiKey = await configService.ensureLocalApiKey();

  proxyServer = new OpenApiProxyServer({
    configService,
    logger: createLoggerBridge('proxy')
  });
  autoRecoveryScheduler = new DisabledSiteAutoRecoveryScheduler({
    configService,
    logger: createLoggerBridge('auto-recovery')
  });
  const codexHomePath = process.env.CODEX_HOME || join(app.getPath('home'), '.codex');
  codexRecoveryCoordinator = new CodexRecoveryCoordinator({
    configService,
    sessionsDir: join(codexHomePath, 'sessions'),
    queueFilePath: join(userDataPath, 'codex-recovery-queue.json'),
    logger: createLoggerBridge('codex-recovery')
  });
  siteSyncScheduler = new SiteSyncScheduler({
    configService,
    syncWebsite: (options) => syncGroupWebsite({
      ...options,
      trigger: 'scheduled',
      onActivity: recordActivityEvent,
      resolveTurnstileToken: resolveSiteSyncTurnstileToken,
      resolveBrowserSession: resolveSiteSyncBrowserSession
    }),
    logger: createLoggerBridge('site-sync')
  });
  portOccupancyGuard = new PortOccupancyGuard({
    configService,
    proxyServer,
    logger: createLoggerBridge('port-guard')
  });
  stateBroadcaster = createCoalescedStateBroadcaster({ send: sendState });
  await startProxy();

  configService.on('changed', () => broadcastState());
  configService.on('save-error', (error) => {
    logRuntimeError('config.save-error', error, {
      configPath: configService.filePath
    });
  });
  proxyServer.on('started', () => broadcastState());
  proxyServer.on('stopped', () => broadcastState());
  proxyServer.on('start-error', (error) => {
    logRuntimeError('proxy.start-error', error, {
      port: configService.getProxyPort()
    });
    broadcastState();
  });
  proxyServer.on('site-sync-preheated', () => broadcastState());
  proxyServer.on('site-sync-preheat-error', (error) => {
    logRuntimeError('proxy.site-sync-preheat-error', error);
    broadcastState();
  });
  proxyServer.on('route-trace', (trace) => {
    recordRouteTrace(trace);
  });
  proxyServer.on('request-complete', (event) => {
    if (event?.statusCode >= 400) {
      logRuntimeError(
        'proxy.upstream-http-error',
        new Error(`Upstream returned HTTP ${event.statusCode}`),
        {
          siteId: event.siteId,
          statusCode: event.statusCode,
          request: event.request
        }
      );
    }
    broadcastSitePatch(event?.siteId);
  });
  proxyServer.on('request-error', (event) => {
    logRuntimeError('proxy.request-error', event?.error, {
      siteId: event?.siteId
    });
    broadcastSitePatch(event?.siteId);
  });
  proxyServer.on('availability-exhausted', (event) => {
    codexRecoveryCoordinator.handleAvailabilityExhausted(event);
  });
  proxyServer.on('codex-retry-needed', (event) => {
    codexRecoveryCoordinator.handleAvailabilityExhausted(event);
  });
  proxyServer.on('sites-recovered', () => {
    codexRecoveryCoordinator.notifySitesRecovered();
  });
  autoRecoveryScheduler.on('checked', () => broadcastState());
  autoRecoveryScheduler.on('sites-recovered', () => {
    codexRecoveryCoordinator.notifySitesRecovered();
  });
  codexRecoveryCoordinator.on('queue-changed', () => broadcastState());
  codexRecoveryCoordinator.on('recovery-error', (error) => {
    logRuntimeError('codex-recovery.error', error);
    broadcastState();
  });
  siteSyncScheduler.on('synced', () => broadcastState());
  siteSyncScheduler.on('status-changed', () => broadcastState());
  portOccupancyGuard.on('released', () => broadcastState());
  portOccupancyGuard.on('guard-error', (error) => {
    logRuntimeError('port-guard.guard-error', error, {
      port: configService.getProxyPort()
    });
    broadcastState();
  });
  await codexRecoveryCoordinator.start();
  autoRecoveryScheduler.start();
  siteSyncScheduler.start();
  portOccupancyGuard.start();

  registerIpc();
  await createWindow();
  await createFloatingWindow();
}

function trackWindowSize(window) {
  let resizeSaveTimer = null;

  const saveCurrentSize = () => {
    const bounds = window.getNormalBounds();
    saveWindowSize(windowStateFilePath, {
      width: bounds.width,
      height: bounds.height
    });
  };

  window.on('resize', () => {
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(saveCurrentSize, 250);
  });

  window.on('close', () => {
    clearTimeout(resizeSaveTimer);
    saveCurrentSize();
  });
}

function trackWindowRuntimeErrors(window) {
  window.on('unresponsive', () => {
    logRuntimeError('window.unresponsive', new Error('Main window became unresponsive'));
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    logRuntimeError(
      'renderer.process-gone',
      new Error(`Renderer process gone: ${details?.reason ?? 'unknown'}`),
      details
    );
  });

  window.webContents.on('did-fail-load', (
    _event,
    errorCode,
    errorDescription,
    validatedURL,
    isMainFrame
  ) => {
    logRuntimeError(
      'renderer.did-fail-load',
      new Error(errorDescription || `Renderer failed to load: ${errorCode}`),
      {
        errorCode,
        validatedURL,
        isMainFrame
      }
    );
  });
}

async function startProxy() {
  try {
    await startProxyWithFallback({
      proxyServer,
      configService,
      logger: createLoggerBridge('proxy-start')
    });
  } catch (error) {
    await reportRuntimeError('proxy.start-failed', error, {
      port: configService.getProxyPort()
    });
  }
}

async function restartProxy() {
  await proxyServer.stop();
  await startProxy();
}

function registerIpc() {
  handleLogged('state:get', (event) => buildState({
    revealLocalApiKey: event.sender === mainWindow?.webContents
  }));
  handleLogged('app-window:show-main', async () => {
    const shown = showMainWindowWithLog('renderer-request');
    return { shown };
  });
  handleLogged('app:quit', async () => {
    await logLifecycleEvent(
      'app.quit-requested',
      'Explicit app quit requested',
      { source: 'renderer' }
    );
    app.quit();
    return { ok: true };
  });
  handleLogged('runtime-log:error', async (_event, input) => {
    const result = await logRuntimeError(
      input?.source ?? 'renderer.error',
      input?.error ?? input?.message ?? 'Renderer runtime error',
      input?.context ?? {}
    );
    return {
      ok: result?.ok ?? false,
      filePath: runtimeLogger?.filePath ?? null
    };
  });
  handleLogged('activity-log:list', async (_event, options) => {
    return activityLogger?.readEntries(options) ?? [];
  });
  handleLogged('activity-log:clear', async () => {
    const result = await activityLogger?.clear();
    sendToRendererWindows('activity-log:changed');
    return { ok: result?.ok ?? false };
  });
  handleLogged('site:add', async (_event, input) => {
    await configService.addSite(input);
    return buildState();
  });
  handleLogged('site:update', async (_event, id, patch) => {
    await configService.updateSite(id, patch);
    return buildState();
  });
  handleLogged('site:delete', async (_event, id) => {
    await configService.deleteSite(id);
    return buildState();
  });
  handleLogged('site:clone', async (_event, id) => {
    await configService.cloneSite(id);
    return buildState();
  });
  handleLogged('site:set-active', async (_event, id) => {
    await configService.setActiveSite(id);
    return buildState();
  });
  handleLogged('site:set-enabled', async (_event, id, enabled) => {
    await configService.setSiteEnabled(id, enabled);
    return buildState();
  });
  handleLogged('site:test', async (_event, id) => {
    const testResult = await testConfiguredSite({ configService, siteId: id });
    return {
      ...buildState(),
      testResult
    };
  });
  handleLogged('site:sync', async (_event, id) => {
    const syncResult = await syncConfiguredSite({
      configService,
      siteId: id,
      resolveTurnstileToken: resolveSiteSyncTurnstileToken,
      resolveBrowserSession: resolveSiteSyncBrowserSession
    });
    return {
      ...buildState(),
      syncResult: {
        ok: syncResult.ok,
        multiplier: syncResult.multiplier,
        error: syncResult.error ? {
          message: syncResult.error.message ?? String(syncResult.error)
        } : null
      }
    };
  });
  handleLogged('site:create-key', async (_event, id) => {
    const createKeyResult = await createConfiguredSiteKey({
      configService,
      siteId: id,
      resolveTurnstileToken: resolveSiteSyncTurnstileToken,
      resolveBrowserSession: resolveSiteSyncBrowserSession
    });
    return {
      ...buildState(),
      createKeyResult: {
        ok: createKeyResult.ok,
        multiplier: createKeyResult.multiplier,
        keyName: createKeyResult.keyName,
        createdSiteId: createKeyResult.createdSiteId ?? null,
        error: createKeyResult.error ? {
          message: createKeyResult.error.message ?? String(createKeyResult.error)
        } : null
      }
    };
  });
  handleLogged('site:logout-account', async (_event, id) => {
    const logoutResult = await logoutConfiguredSiteAccount({
      configService,
      siteId: id
    });
    return {
      ...buildState(),
      logoutResult: {
        ok: logoutResult.ok,
        remoteAttempted: logoutResult.remoteAttempted,
        remoteSucceeded: logoutResult.remoteSucceeded,
        reason: logoutResult.reason ?? null,
        error: logoutResult.error ? {
          message: logoutResult.error.message ?? String(logoutResult.error)
        } : null
      }
    };
  });
  handleLogged('site:detect-capabilities', async (_event, id) => {
    const site = configService.findSite(id);
    const capabilityResult = await detectSiteCapabilities(site, {
      timeoutMs: Math.min(configService.getProxyTimeoutMs(), 30000)
    });
    await configService.updateSiteCapabilities(id, capabilityResult.capabilities);
    return {
      ...buildState(),
      capabilityResult: {
        ok: capabilityResult.ok,
        statusCode: capabilityResult.statusCode,
        message: capabilityResult.message,
        durationMs: capabilityResult.durationMs,
        modelCount: capabilityResult.capabilities?.models?.length ?? 0,
        error: capabilityResult.ok
          ? null
          : {
              message: capabilityResult.message,
              detail: capabilityResult.detail
            }
      }
    };
  });
  handleLogged('site:switch-group', async (_event, id, group) => {
    await switchConfiguredSiteGroup({
      configService,
      siteId: id,
      resolveTurnstileToken: resolveSiteSyncTurnstileToken,
      resolveBrowserSession: resolveSiteSyncBrowserSession,
      ...normalizeIpcSwitchGroup(group)
    });
    return buildState();
  });
  handleLogged('site-sync:refresh-all', async () => {
    const refreshResult = await syncAllConfiguredSites({
      configService,
      resolveTurnstileToken: resolveSiteSyncTurnstileToken,
      resolveBrowserSession: resolveSiteSyncBrowserSession,
      onActivity: recordActivityEvent,
      trigger: 'manual'
    });
    return {
      ...buildState(),
      refreshResult: {
        checkedCount: refreshResult.checkedSites.length,
        syncedCount: refreshResult.syncedSites.length,
        failedCount: refreshResult.failedSites.length,
        checkedWebsiteCount: refreshResult.checkedWebsites?.length ?? 0,
        syncedWebsiteCount: refreshResult.syncedWebsites?.length ?? 0,
        failedWebsiteCount: refreshResult.failedWebsites?.length ?? 0
      }
    };
  });
  handleLogged('site:smart-switch', async () => {
    await configService.smartSwitchSite();
    return buildState();
  });
  handleLogged('proxy:update', async (_event, patch) => {
    const previousPort = configService.getProxyPort();
    const previousListenHost = configService.getProxyListenHost();
    await configService.updateProxySettings(patch);
    const nextPort = configService.getProxyPort();
    const nextListenHost = configService.getProxyListenHost();
    if (
      previousPort !== nextPort ||
      previousListenHost !== nextListenHost ||
      !proxyServer.getStatus().running
    ) {
      await restartProxy();
    }
    return buildState();
  });
  handleLogged('proxy:generate-local-api-key', async (event) => {
    if (event.sender !== mainWindow?.webContents) {
      throw new Error('local API key generation requires the main window');
    }
    const localApiKey = await configService.generateLocalApiKey();
    broadcastState();
    return { localApiKey };
  });
  handleLogged('site-sync:update-settings', async (_event, patch) => {
    await configService.updateSiteSyncSettings(patch);
    return buildState();
  });
  handleLogged('group-sync:update-settings', async (_event, patch) => {
    await configService.updateGroupSyncSettings(patch);
    return buildState();
  });
  handleLogged('model-mapping:update', async (_event, patch) => {
    await configService.updateModelMapping(patch);
    return buildState();
  });
  handleLogged('app-settings:update', async (_event, patch) => {
    await configService.updateAppSettings(patch);
    applyFloatingWindowSettings();
    return buildState();
  });
  handleLogged('monitoring:update', async (_event, patch) => {
    await configService.updateMonitoringSettings(patch);
    return buildState();
  });
  handleLogged('monitoring:update-rule', async (_event, siteId, patch) => {
    await configService.updateMonitoringRule(siteId, patch);
    return buildState();
  });
  handleLogged('monitoring:test', async (_event, webhook) => {
    await sendFeishuWebhook({
      webhook,
      event: {
        type: 'recovery',
        condition: {
          key: 'feishu-test',
          kind: 'feishu-test',
          title: '飞书机器人连接成功',
          message: 'JuanProxy Watchdog 测试消息发送成功'
        },
        firstSeenAt: new Date().toISOString()
      }
    });
    return { ok: true };
  });
  handleLogged('monitoring-task:status', () => getWatchdogTaskStatus());
  handleLogged('monitoring-task:install', async () => {
    await installWatchdogTask({ projectRoot: join(__dirname, '..') });
    return getWatchdogTaskStatus();
  });
  handleLogged('monitoring-task:remove', async () => {
    await removeWatchdogTask({ projectRoot: join(__dirname, '..') });
    return getWatchdogTaskStatus();
  });
  handleLogged('floating-window:set-expanded', (_event, expanded) => {
    setFloatingWindowExpanded(Boolean(expanded));
    return getFloatingWindowBounds();
  });
  handleLogged('floating-window:get-bounds', () => getFloatingWindowBounds());
  handleLogged('floating-window:set-bounds', (_event, bounds) => {
    setFloatingWindowBounds(bounds);
    return getFloatingWindowBounds();
  });
  handleLogged('config-export:save', async (_event, options = {}) => {
    const exportPayload = configService.exportConfig({
      siteIds: normalizeOptionalIpcSiteIds(options.siteIds),
      includeGlobalSettings: options.includeGlobalSettings !== false
    });
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出 JuanProxy 配置',
      defaultPath: createConfigExportFileName(),
      filters: [
        { name: 'JSON 配置文件', extensions: ['json'] }
      ]
    });

    if (canceled || !filePath) {
      return { canceled: true };
    }

    await writeFile(filePath, `${JSON.stringify(exportPayload, null, 2)}\n`, 'utf8');
    return {
      canceled: false,
      filePath,
      exportedSiteCount: exportPayload.sites.length,
      exportedGlobalSettings: Boolean(exportPayload.settings)
    };
  });
  handleLogged('config-import:preview', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '导入 JuanProxy 配置',
      properties: ['openFile'],
      filters: [
        { name: 'JSON 配置文件', extensions: ['json'] }
      ]
    });

    if (canceled || !filePaths?.[0]) {
      return { canceled: true };
    }

    const filePath = filePaths[0];
    const raw = await readFile(filePath, 'utf8');
    const preview = configService.previewImportConfig(raw);
    const importId = randomUUID();
    pendingConfigImports.set(importId, {
      raw,
      filePath,
      createdAt: Date.now()
    });
    prunePendingConfigImports();

    return {
      canceled: false,
      importId,
      filePath,
      preview
    };
  });
  handleLogged('config-import:apply', async (_event, options = {}) => {
    const importId = String(options.importId ?? '');
    const pendingImport = pendingConfigImports.get(importId);
    if (!pendingImport) {
      throw new Error('导入预览已失效，请重新选择导入文件');
    }

    const previousPort = configService.getProxyPort();
    const previousListenHost = configService.getProxyListenHost();
    const importResult = await configService.importConfig(pendingImport.raw, {
      siteIds: normalizeOptionalIpcSiteIds(options.siteIds),
      includeGlobalSettings: Boolean(options.includeGlobalSettings)
    });
    pendingConfigImports.delete(importId);

    const nextPort = configService.getProxyPort();
    const nextListenHost = configService.getProxyListenHost();
    if (
      previousPort !== nextPort ||
      previousListenHost !== nextListenHost ||
      !proxyServer.getStatus().running
    ) {
      await restartProxy();
    }

    return {
      ...buildState(),
      importResult
    };
  });
  handleLogged('proxy:restart', async () => {
    await restartProxy();
    return buildState();
  });
}

function normalizeOptionalIpcSiteIds(siteIds) {
  if (siteIds === null || siteIds === undefined) {
    return null;
  }
  return Array.isArray(siteIds) ? siteIds.map((id) => String(id)) : [String(siteIds)];
}

function normalizeIpcSwitchGroup(group) {
  if (group && typeof group === 'object' && !Array.isArray(group)) {
    return {
      groupName: String(group.groupName ?? group.name ?? '').trim(),
      groupId: String(group.groupId ?? group.id ?? '').trim()
    };
  }
  return {
    groupName: String(group ?? '').trim()
  };
}

function createConfigExportFileName(now = new Date()) {
  const pad = (part) => String(part).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('') + '-' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
  return `JuanProxy-config-${stamp}.json`;
}

function prunePendingConfigImports(now = Date.now()) {
  const maxAgeMs = 30 * 60 * 1000;
  for (const [importId, pendingImport] of pendingConfigImports) {
    if (now - pendingImport.createdAt > maxAgeMs) {
      pendingConfigImports.delete(importId);
    }
  }
}

function handleLogged(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      await logRuntimeError(`ipc.${channel}`, error, { channel });
      throw error;
    }
  });
}

function buildState({ revealLocalApiKey = false } = {}) {
  const configState = configService.getRendererState();
  const proxyStatus = proxyServer.getStatus();
  const localApiKey = revealLocalApiKey ? pendingLocalApiKey : null;
  if (revealLocalApiKey) {
    pendingLocalApiKey = null;
  }
  return {
    ...configState,
    proxyStatus,
    proxyAccessUrls: buildProxyAccessUrls({
      port: proxyStatus.port ?? configState.proxy.port,
      allowLanAccess: configState.proxy.allowLanAccess
    }),
    configPath: configService.filePath,
    runtimeLogPath: runtimeLogger?.filePath ?? null,
    activityLogPath: activityLogger?.filePath ?? null,
    siteSyncStatus: siteSyncScheduler?.getStatus() ?? null,
    codexRecoveryStatus: codexRecoveryCoordinator?.getStatus() ?? null,
    recentRouteTraces: recentRouteTraces.map((trace) => ({ ...trace })),
    ...(localApiKey ? { localApiKey } : {})
  };
}

function broadcastState() {
  stateBroadcaster?.schedule();
}

function broadcastSitePatch(siteId) {
  if (!siteId) {
    broadcastState();
    return;
  }

  pendingSitePatchIds.add(siteId);
  if (pendingSitePatchTimer) {
    return;
  }
  pendingSitePatchTimer = setTimeout(sendSitePatches, 100);
  pendingSitePatchTimer.unref?.();
}

function sendState() {
  sendToRendererWindows('state:changed', buildState());
}

function sendSitePatches() {
  pendingSitePatchTimer = null;
  if (
    (!mainWindow || mainWindow.isDestroyed()) &&
    (!floatingWindow || floatingWindow.isDestroyed())
  ) {
    pendingSitePatchIds.clear();
    return;
  }

  const siteIds = [...pendingSitePatchIds];
  pendingSitePatchIds.clear();
  for (const siteId of siteIds) {
    const site = configService.getSiteSnapshot(siteId);
    if (!site) {
      continue;
    }
    sendToRendererWindows('site:changed', {
      site,
      activeSiteId: configService.getActiveSiteId(),
      proxyStatus: proxyServer.getStatus()
    });
  }
}

function sendToRendererWindows(channel, payload) {
  for (const window of [mainWindow, floatingWindow]) {
    if (!window || window.isDestroyed()) {
      continue;
    }
    window.webContents.send(channel, payload);
  }
}

function getFloatingWindowAlwaysOnTop() {
  return Boolean(configService?.getState()?.appSettings?.floatingWindow?.alwaysOnTop);
}

function applyFloatingWindowSettings() {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    return;
  }
  const alwaysOnTop = getFloatingWindowAlwaysOnTop();
  try {
    if (alwaysOnTop) {
      floatingWindow.setAlwaysOnTop(true, 'screen-saver');
    } else {
      floatingWindow.setAlwaysOnTop(false);
    }
  } catch (error) {
    logRuntimeError('floating-window.always-on-top-failed', error, { alwaysOnTop });
  }
  try {
    floatingWindow.setVisibleOnAllWorkspaces(alwaysOnTop, {
      visibleOnFullScreen: alwaysOnTop
    });
  } catch (error) {
    logRuntimeError('floating-window.workspace-visibility-failed', error, { alwaysOnTop });
  }
}

function getInitialFloatingWindowBounds(width, height) {
  const savedPosition = configService?.getState()?.appSettings?.floatingWindow?.position;
  if (savedPosition) {
    return keepBoundsInDisplay({
      width,
      height,
      x: savedPosition.x,
      y: savedPosition.y
    });
  }

  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 18,
    y: workArea.y + workArea.height - height - 18
  };
}

function setFloatingWindowExpanded(expanded) {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    return;
  }
  const bounds = floatingWindow.getBounds();
  if (!expanded) {
    const nextCompactBounds = keepBoundsInDisplay({
      ...(floatingWindowCompactBounds ?? bounds),
      width: 92,
      height: 92
    });
    floatingWindowCompactBounds = nextCompactBounds;
    floatingWindow.setBounds(nextCompactBounds);
    return;
  }

  if (bounds.width <= 120 && bounds.height <= 120) {
    floatingWindowCompactBounds = bounds;
  }
  const nextBounds = keepBoundsInDisplay({
    ...(floatingWindowCompactBounds ?? bounds),
    width: 360,
    height: 300
  });
  floatingWindow.setBounds(nextBounds);
}

function getFloatingWindowBounds() {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    return null;
  }
  return floatingWindow.getBounds();
}

function setFloatingWindowBounds(bounds = {}) {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    return;
  }
  const current = floatingWindow.getBounds();
  const nextBounds = keepBoundsInDisplay({
    ...current,
    x: Number.isFinite(Number(bounds.x)) ? Math.round(Number(bounds.x)) : current.x,
    y: Number.isFinite(Number(bounds.y)) ? Math.round(Number(bounds.y)) : current.y
  });
  floatingWindowCompactBounds = {
    ...nextBounds,
    width: 92,
    height: 92
  };
  floatingWindow.setBounds(nextBounds);
  scheduleFloatingWindowPositionSave(floatingWindowCompactBounds);
}

function keepBoundsInDisplay(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const width = Math.max(92, Math.min(380, Math.round(Number(bounds.width) || 92)));
  const height = Math.max(92, Math.min(320, Math.round(Number(bounds.height) || 92)));
  return {
    width,
    height,
    x: Math.min(Math.max(Math.round(Number(bounds.x) || workArea.x), workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(Math.round(Number(bounds.y) || workArea.y), workArea.y), workArea.y + workArea.height - height)
  };
}

function scheduleFloatingWindowPositionSave(bounds) {
  pendingFloatingWindowPosition = bounds;
  clearTimeout(floatingWindowPositionSaveTimer);
  floatingWindowPositionSaveTimer = setTimeout(() => {
    floatingWindowPositionSaveTimer = null;
    flushFloatingWindowPositionSave().catch((error) => {
      logRuntimeError('floating-window.position-save-failed', error);
    });
  }, 250);
}

async function flushFloatingWindowPositionSave() {
  clearTimeout(floatingWindowPositionSaveTimer);
  floatingWindowPositionSaveTimer = null;
  const bounds = pendingFloatingWindowPosition;
  pendingFloatingWindowPosition = null;
  await saveFloatingWindowPosition(bounds);
}

async function saveFloatingWindowPosition(bounds) {
  if (!configService || !bounds) {
    return;
  }
  await configService.updateAppSettings({
    floatingWindow: {
      position: {
        x: bounds.x,
        y: bounds.y
      }
    }
  });
}

function createLoggerBridge(source) {
  return runtimeLogger?.createConsoleBridge(source) ?? console;
}

function logLifecycleEvent(source, message, context = {}) {
  console.info(`[${source}] ${message}`);
  return runtimeLogger?.info(source, message, context) ?? Promise.resolve(null);
}

function showMainWindowWithLog(source) {
  const shown = showMainWindow(mainWindow);
  if (shown) {
    logLifecycleEvent(
      'main-window.shown',
      'Main window was shown and focused',
      { source }
    );
  }
  return shown;
}

async function resolveSiteSyncTurnstileToken(context) {
  return resolveTurnstileTokenWithWindow({
    parentWindow: mainWindow,
    origin: context?.origin,
    siteKey: context?.siteKey,
    timeoutMs: context?.timeoutMs
  });
}

async function resolveSiteSyncBrowserSession(context) {
  return resolveRemoteBrowserSessionWithWindow({
    parentWindow: mainWindow,
    origin: context?.origin,
    challengeUrl: context?.challengeUrl,
    timeoutMs: context?.timeoutMs
  });
}

function recordRouteTrace(trace) {
  const normalizedTrace = normalizeRouteTraceForState(trace);
  if (!normalizedTrace?.id) {
    return;
  }

  recentRouteTraces = [
    normalizedTrace,
    ...recentRouteTraces.filter((entry) => entry.id !== normalizedTrace.id)
  ].slice(0, MAX_RECENT_ROUTE_TRACES);

  runtimeLogger
    ?.info('proxy.route-trace', 'Request route trace', { trace: normalizedTrace })
    ?.catch?.((error) => {
      console.error('Failed to write route trace runtime log:', error);
    });
  sendToRendererWindows('route-trace:changed', normalizedTrace);
}

function normalizeRouteTraceForState(trace) {
  try {
    return JSON.parse(JSON.stringify(trace ?? null));
  } catch {
    return null;
  }
}

async function logRuntimeError(source, error, context = {}) {
  if (!runtimeLogger) {
    return null;
  }
  return runtimeLogger.error(source, error, context);
}

async function recordActivityEvent(event = {}) {
  if (!activityLogger) {
    return null;
  }
  const level = event.status === 'failure'
    ? 'error'
    : event.status === 'skipped'
      ? 'warn'
      : 'info';
  const result = await activityLogger.write({
    level,
    source: `activity.${event.category ?? 'runtime'}`,
    message: event.message ?? '运行活动',
    context: event
  });
  if (result?.ok) {
    sendToRendererWindows('activity-log:changed');
  }
  return result;
}

async function reportRuntimeError(source, error, context = {}) {
  console.error(`[${source}]`, error);
  return logRuntimeError(source, error, context);
}

function installProcessErrorHandlers() {
  if (processErrorHandlersInstalled) {
    return;
  }
  processErrorHandlersInstalled = true;

  process.on('uncaughtException', (error) => {
    reportRuntimeError('process.uncaughtException', error)
      .finally(async () => {
        await runtimeLogger?.flush();
        app.exit(1);
      });
  });

  process.on('unhandledRejection', (reason) => {
    reportRuntimeError('process.unhandledRejection', reason);
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  installProcessErrorHandlers();

  app.on('second-instance', () => {
    showMainWindowWithLog('second-instance');
  });

  app.whenReady()
    .then(bootstrap)
    .catch(async (error) => {
      await reportRuntimeError('app.bootstrap', error);
      await runtimeLogger?.flush();
      await activityLogger?.flush();
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    if (!quitting) {
      logLifecycleEvent(
        'app.window-all-closed',
        'All windows closed while the background proxy remains active'
      );
    }
  });

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
        .then(() => showMainWindowWithLog('app-activate'))
        .catch((error) => {
          reportRuntimeError('app.activate', error);
        });
    } else {
      showMainWindowWithLog('app-activate');
    }
    if (!floatingWindow || floatingWindow.isDestroyed()) {
      createFloatingWindow().catch((error) => {
        reportRuntimeError('app.activate-floating', error);
      });
    }
  });

  app.on('before-quit', async (event) => {
    event.preventDefault();
    if (quitting) {
      return;
    }
    quitting = true;
    await logLifecycleEvent(
      'app.before-quit.start',
      'App shutdown cleanup started'
    );
    let exitCode = 0;
    try {
      await codexRecoveryCoordinator?.stop();
      autoRecoveryScheduler?.stop();
      siteSyncScheduler?.stop();
      portOccupancyGuard?.stop();
      if (pendingSitePatchTimer) {
        clearTimeout(pendingSitePatchTimer);
        pendingSitePatchTimer = null;
        pendingSitePatchIds.clear();
      }
      stateBroadcaster?.flush();
      await flushFloatingWindowPositionSave();
      await configService?.flush();
      if (proxyServer?.getStatus().running) {
        await proxyServer.stop();
      }
    } catch (error) {
      exitCode = 1;
      await reportRuntimeError('app.before-quit', error);
    }
    await logLifecycleEvent(
      'app.before-quit.complete',
      'App shutdown cleanup finished',
      { exitCode }
    );
    await runtimeLogger?.flush();
    await activityLogger?.flush();
    app.exit(exitCode);
  });
}
