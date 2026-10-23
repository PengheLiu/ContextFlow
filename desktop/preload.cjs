const { contextBridge, ipcRenderer } = require('electron');
// No generic IPC, shell, filesystem, URL or token is exposed to the renderer.
contextBridge.exposeInMainWorld('contextflowDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('desktop:status'),
  onStatusChange: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Status listener must be a function');
    const listener = () => callback();
    ipcRenderer.on('desktop:changed', listener);
    return () => ipcRenderer.removeListener('desktop:changed', listener);
  },
  onNavigate: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Navigation listener must be a function');
    const listener = (_event, page) => { if (page === 'support') callback(page); };
    ipcRenderer.on('desktop:page', listener);
    return () => ipcRenderer.removeListener('desktop:page', listener);
  },
  discover: (options) => ipcRenderer.invoke('desktop:discover', options),
  onboarding: (patch) => ipcRenderer.invoke('desktop:onboarding', patch),
  request: (path, init) => ipcRenderer.invoke('desktop:request', path, init),
  action: (action) => ipcRenderer.invoke('desktop:action', action),
  chooseFolder: (target) => ipcRenderer.invoke('desktop:folder', target),
  chooseAgent: () => ipcRenderer.invoke('desktop:agent-path'),
  preferences: (patch) => ipcRenderer.invoke('desktop:preferences', patch),
  revoke: (id, instanceId) => ipcRenderer.invoke('desktop:revoke', id, instanceId),
  updates: (action) => ipcRenderer.invoke('desktop:updates', action),
  recovery: (action, id) => ipcRenderer.invoke('desktop:recovery', action, id),
}));
