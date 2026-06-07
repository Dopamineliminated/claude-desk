'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 렌더러(웹 UI)에서 안전하게 호출할 수 있는 API 표면. */
contextBridge.exposeInMainWorld('claudeDesk', {
  // 초기화 / 환경
  init: () => ipcRenderer.invoke('app:init'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  copyText: (text) => ipcRenderer.invoke('clip:write', text),
  readText: () => ipcRenderer.invoke('clip:read'),

  // 터미널(PTY)
  termStart: (opts) => ipcRenderer.invoke('term:start', opts),
  termRestart: (opts) => ipcRenderer.invoke('term:restart', opts),
  termKill: () => ipcRenderer.invoke('term:kill'),
  termInput: (data) => ipcRenderer.send('term:input', data),
  termResize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
  onTermData: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('term:data', h);
    return () => ipcRenderer.removeListener('term:data', h);
  },
  onTermExit: (cb) => {
    const h = (_e, e) => cb(e);
    ipcRenderer.on('term:exit', h);
    return () => ipcRenderer.removeListener('term:exit', h);
  },
  onTermStarted: (cb) => {
    const h = (_e, e) => cb(e);
    ipcRenderer.on('term:started', h);
    return () => ipcRenderer.removeListener('term:started', h);
  },

  // 계정 (각 계정 = 격리된 설정 폴더)
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (label) => ipcRenderer.invoke('accounts:add', label),
  setActiveAccount: (id) => ipcRenderer.invoke('accounts:setActive', id),
  renameAccount: (id, label) => ipcRenderer.invoke('accounts:rename', { id, label }),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  logout: (id) => ipcRenderer.invoke('accounts:logout', id),
});
