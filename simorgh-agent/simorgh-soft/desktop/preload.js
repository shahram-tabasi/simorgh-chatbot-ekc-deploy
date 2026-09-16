// The setup page's only bridge to the main process: hand back a server
// address. Nothing else from Node is exposed to any page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('simorgh', {
  saveServerUrl: (url) => ipcRenderer.invoke('simorgh:save-server-url', url),
  // For the "can't reach it" page: the one thing worth doing from there is
  // correcting the address, and hunting through the File menu for it while
  // looking at an error is not the moment to make somebody hunt.
  changeServerUrl: () => ipcRenderer.invoke('simorgh:change-server-url'),
});
