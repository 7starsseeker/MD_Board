const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mdStats', {
  // ── 数据获取 ──
  getAll: () => ipcRenderer.invoke('stats:get-all'),
  getStats: () => ipcRenderer.invoke('stats:get-stats'),

  // ── 数据操作 ──
  addMatch: (matchData) => ipcRenderer.invoke('stats:add-match', matchData),
  updateMatch: (id, updates) => ipcRenderer.invoke('stats:update-match', { id, updates }),
  deleteMatch: (id) => ipcRenderer.invoke('stats:delete-match', id),
  resetMatches: () => ipcRenderer.invoke('stats:reset-matches'),
  persistData: () => ipcRenderer.invoke('stats:persist-data'),
  isPortable: () => ipcRenderer.invoke('stats:is-portable'),
  openStatsWindow: () => ipcRenderer.invoke('stats:open-window'),

  // ── 导入/导出 ──
  exportJSON: () => ipcRenderer.invoke('stats:export-json'),
  importJSON: (jsonStr) => ipcRenderer.invoke('stats:import-json', jsonStr),

  // ── 实时通知 ──
  onStatsUpdate: (callback) => {
    const handler = (event, stats) => callback(stats);
    ipcRenderer.on('stats-updated', handler);
    return () => ipcRenderer.removeListener('stats-updated', handler);
  },

  // ── 对手卡组预设管理 ──
  presets: {
    getAll: () => ipcRenderer.invoke('presets:get-all'),
    add: (name) => ipcRenderer.invoke('presets:add', name),
    delete: (name) => ipcRenderer.invoke('presets:delete', name),
    rename: (oldName, newName) => ipcRenderer.invoke('presets:rename', { oldName, newName })
  },

  // ── 自己卡组预设管理 ──
  myDeckPresets: {
    getAll: () => ipcRenderer.invoke('mydeck:get-all'),
    add: (name) => ipcRenderer.invoke('mydeck:add', name),
    delete: (name) => ipcRenderer.invoke('mydeck:delete', name),
    rename: (oldName, newName) => ipcRenderer.invoke('mydeck:rename', { oldName, newName })
  }
});
