// The app's own pages' only bridge to the main process: Settings (and the
// first-run window, which is Settings) and the error page. Nothing else from
// Node is exposed to any page; the suite's own pages never use it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('simorgh', {
  getSettings: () => ipcRenderer.invoke('simorgh:get-settings'),
  saveSettings: settings => ipcRenderer.invoke('simorgh:save-settings', settings),
  test: (kind, cfg) => ipcRenderer.invoke('simorgh:test', kind, cfg),
  exportAccess: (sqlServer, file) => ipcRenderer.invoke('simorgh:export-access', sqlServer, file),
  job: id => ipcRenderer.invoke('simorgh:job', id),
  chooseAccessFile: (current, forSaving) => ipcRenderer.invoke('simorgh:choose-access-file', current, forSaving),
  openPath: file => ipcRenderer.invoke('simorgh:open-path', file),
  openSettings: () => ipcRenderer.invoke('simorgh:open-settings'),
  retry: () => ipcRenderer.invoke('simorgh:retry'),
  closeWindow: () => ipcRenderer.invoke('simorgh:close-window'),
});
