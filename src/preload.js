import { clipboard, contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('openApiProxy', {
  getState: () => ipcRenderer.invoke('state:get'),
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
  switchSiteGroup: (id, groupName) => ipcRenderer.invoke('site:switch-group', id, groupName),
  refreshAllSiteSync: () => ipcRenderer.invoke('site-sync:refresh-all'),
  smartSwitchSite: () => ipcRenderer.invoke('site:smart-switch'),
  updateProxy: (patch) => ipcRenderer.invoke('proxy:update', patch),
  updateSiteSyncSettings: (patch) => ipcRenderer.invoke('site-sync:update-settings', patch),
  updateGroupSyncSettings: (patch) => ipcRenderer.invoke('group-sync:update-settings', patch),
  updateModelMapping: (patch) => ipcRenderer.invoke('model-mapping:update', patch),
  exportConfig: (options) => ipcRenderer.invoke('config-export:save', options),
  previewImportConfig: () => ipcRenderer.invoke('config-import:preview'),
  importConfig: (options) => ipcRenderer.invoke('config-import:apply', options),
  restartProxy: () => ipcRenderer.invoke('proxy:restart'),
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
  }
});
