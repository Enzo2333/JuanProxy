import { clipboard, contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('openApiProxy', {
  getState: () => ipcRenderer.invoke('state:get'),
  showMainWindow: () => ipcRenderer.invoke('app-window:show-main'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  copyText: (text) => clipboard.writeText(String(text ?? '')),
  addSite: (input) => ipcRenderer.invoke('site:add', input),
  updateSite: (id, patch) => ipcRenderer.invoke('site:update', id, patch),
  deleteSite: (id) => ipcRenderer.invoke('site:delete', id),
  cloneSite: (id) => ipcRenderer.invoke('site:clone', id),
  setActiveSite: (id) => ipcRenderer.invoke('site:set-active', id),
  setSiteEnabled: (id, enabled) => ipcRenderer.invoke('site:set-enabled', id, enabled),
  testSite: (id) => ipcRenderer.invoke('site:test', id),
  detectSiteCapabilities: (id) => ipcRenderer.invoke('site:detect-capabilities', id),
  syncSite: (id) => ipcRenderer.invoke('site:sync', id),
  createSiteKey: (id) => ipcRenderer.invoke('site:create-key', id),
  logoutSiteAccount: (id) => ipcRenderer.invoke('site:logout-account', id),
  switchSiteGroup: (id, group) => ipcRenderer.invoke('site:switch-group', id, group),
  refreshAllSiteSync: () => ipcRenderer.invoke('site-sync:refresh-all'),
  smartSwitchSite: () => ipcRenderer.invoke('site:smart-switch'),
  updateProxy: (patch) => ipcRenderer.invoke('proxy:update', patch),
  generateLocalApiKey: () => ipcRenderer.invoke('proxy:generate-local-api-key'),
  updateSiteSyncSettings: (patch) => ipcRenderer.invoke('site-sync:update-settings', patch),
  updateGroupSyncSettings: (patch) => ipcRenderer.invoke('group-sync:update-settings', patch),
  updateModelMapping: (patch) => ipcRenderer.invoke('model-mapping:update', patch),
  updateAppSettings: (patch) => ipcRenderer.invoke('app-settings:update', patch),
  updateMonitoringSettings: (patch) => ipcRenderer.invoke('monitoring:update', patch),
  updateMonitoringRule: (siteId, patch) =>
    ipcRenderer.invoke('monitoring:update-rule', siteId, patch),
  testFeishuWebhook: (webhook) => ipcRenderer.invoke('monitoring:test', webhook),
  getMonitoringTaskStatus: () => ipcRenderer.invoke('monitoring-task:status'),
  installMonitoringTask: () => ipcRenderer.invoke('monitoring-task:install'),
  removeMonitoringTask: () => ipcRenderer.invoke('monitoring-task:remove'),
  openRemoteMonitorDownload: () => ipcRenderer.invoke('remote-monitoring:open-download'),
  setFloatingWindowExpanded: (expanded) =>
    ipcRenderer.invoke('floating-window:set-expanded', expanded),
  getFloatingWindowBounds: () => ipcRenderer.invoke('floating-window:get-bounds'),
  setFloatingWindowBounds: (bounds) => ipcRenderer.invoke('floating-window:set-bounds', bounds),
  exportConfig: (options) => ipcRenderer.invoke('config-export:save', options),
  previewImportConfig: () => ipcRenderer.invoke('config-import:preview'),
  importConfig: (options) => ipcRenderer.invoke('config-import:apply', options),
  restartProxy: () => ipcRenderer.invoke('proxy:restart'),
  listActivityLogs: (options) => ipcRenderer.invoke('activity-log:list', options),
  clearActivityLogs: () => ipcRenderer.invoke('activity-log:clear'),
  logRuntimeError: (input) => ipcRenderer.invoke('runtime-log:error', input),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.off('state:changed', listener);
  },
  onSiteChanged: (callback) => {
    const listener = (_event, patch) => callback(patch);
    ipcRenderer.on('site:changed', listener);
    return () => ipcRenderer.off('site:changed', listener);
  },
  onRouteTraceChanged: (callback) => {
    const listener = (_event, trace) => callback(trace);
    ipcRenderer.on('route-trace:changed', listener);
    return () => ipcRenderer.off('route-trace:changed', listener);
  },
  onActivityLogChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('activity-log:changed', listener);
    return () => ipcRenderer.off('activity-log:changed', listener);
  }
});
