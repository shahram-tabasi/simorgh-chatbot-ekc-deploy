// The setup page's only bridge to the main process: hand back a server
// address. Nothing else from Node is exposed to any page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('simorgh', {
  saveServerUrl: (url) => ipcRenderer.invoke('simorgh:save-server-url', url),
});
