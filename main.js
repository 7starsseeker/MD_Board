const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ── 数据管理 ──────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data', 'stats.json');

let data = { matches: [], version: 2, deckPresets: [] };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      data = JSON.parse(raw);
      // 迁移旧版本
      if (!data.deckPresets) data.deckPresets = [];
    }
  } catch (e) {
    console.error('读取数据文件失败:', e.message);
  }
}

function saveData() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存数据文件失败:', e.message);
  }
}

// ── 统计计算 ──────────────────────────────────────────────────────────────
function computeStats() {
  const matches = data.matches || [];
  const wins = matches.filter(m => m.result === 'win').length;
  const losses = matches.filter(m => m.result === 'loss').length;
  const draws = matches.filter(m => m.result === 'draw').length;
  const abnormals = matches.filter(m => m.result === 'abnormal').length;
  const total = wins + losses + draws + abnormals;

  const normalMatches = matches.filter(m => m.result === 'win' || m.result === 'loss');
  const goingFirst = normalMatches.filter(m => m.goingFirst);
  const goingSecond = normalMatches.filter(m => !m.goingFirst);
  const gfWins = goingFirst.filter(m => m.result === 'win').length;
  const gsWins = goingSecond.filter(m => m.result === 'win').length;

  // 先后手包含平局和异常
  const gfAll = matches.filter(m => m.goingFirst);
  const gsAll = matches.filter(m => !m.goingFirst);
  const gdDraws = gfAll.filter(m => m.result === 'draw').length;
  const gdAbnormals = gfAll.filter(m => m.result === 'abnormal').length;
  const gsDraws = gsAll.filter(m => m.result === 'draw').length;
  const gsAbnormals = gsAll.filter(m => m.result === 'abnormal').length;

  // 当前连胜/连败（跳过异常和平局）
  let streakType = null, streakCount = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const r = matches[i].result;
    if (r === 'abnormal' || r === 'draw') continue;
    if (r !== 'win' && r !== 'loss') continue;
    if (streakType === null) { streakType = r; streakCount = 1; }
    else if (r === streakType) streakCount++;
    else break;
  }

  // 硬币统计
  const coinMatches = matches.filter(m => m.coinToss === true || m.coinToss === false);
  const coinWins = coinMatches.filter(m => m.coinToss === true).length;
  const coinLosses = coinMatches.filter(m => m.coinToss === false).length;

  // 最近10场
  const last10 = matches.slice(-10).map(m => ({
    result: m.result, goingFirst: m.goingFirst, opponentDeck: m.opponentDeck || ''
  }));

  // 对手卡组统计
  const deckStats = {};
  matches.filter(m => m.opponentDeck).forEach(m => {
    const deck = m.opponentDeck.trim();
    if (!deck) return;
    if (!deckStats[deck]) deckStats[deck] = { wins: 0, losses: 0, draws: 0, abnormals: 0, total: 0 };
    deckStats[deck].total++;
    if (m.result === 'win') deckStats[deck].wins++;
    else if (m.result === 'loss') deckStats[deck].losses++;
    else if (m.result === 'draw') deckStats[deck].draws++;
    else if (m.result === 'abnormal') deckStats[deck].abnormals++;
  });

  const playable = wins + losses;

  return {
    total, wins, losses, draws, abnormals,
    winRate: playable > 0 ? ((wins / playable) * 100).toFixed(1) : '0.0',
    coin: {
      total: coinMatches.length,
      wins: coinWins,
      losses: coinLosses,
      winRate: coinMatches.length > 0 ? ((coinWins / coinMatches.length) * 100).toFixed(1) : '0.0'
    },
    goingFirst: {
      total: goingFirst.length,
      wins: gfWins,
      losses: goingFirst.length - gfWins,
      draws: gdDraws,
      abnormals: gdAbnormals,
      winRate: goingFirst.length > 0 ? ((gfWins / goingFirst.length) * 100).toFixed(1) : '0.0'
    },
    goingSecond: {
      total: goingSecond.length,
      wins: gsWins,
      losses: goingSecond.length - gsWins,
      draws: gsDraws,
      abnormals: gsAbnormals,
      winRate: goingSecond.length > 0 ? ((gsWins / goingSecond.length) * 100).toFixed(1) : '0.0'
    },
    currentStreak: { type: streakType, count: streakCount },
    last10,
    deckStats: Object.entries(deckStats)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([deck, s]) => ({
        deck, ...s,
        winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
      }))
  };
}

// ── 窗口管理 ──────────────────────────────────────────────────────────────
let displayWin = null;
let controlWin = null;
const WINDOW_STATE_FILE = path.join(__dirname, 'data', 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(WINDOW_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf-8'));
    }
  } catch (e) {}
  return {};
}

function saveWindowState(state) {
  try {
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch (e) {}
}

function createDisplayWindow() {
  const state = loadWindowState();

  displayWin = new BrowserWindow({
    width: state.displayWidth || 340,
    height: state.displayHeight || 130,
    x: state.displayX || 100,
    y: state.displayY || 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  displayWin.loadFile(path.join(__dirname, 'src', 'display.html'));
  displayWin.setVisibleOnAllWorkspaces(true);

  // 内容加载后自动调整到刚好显示所有要素
  displayWin.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      displayWin.webContents.executeJavaScript(
        '(function(){var o=document.querySelector(".overlay");o.style.overflow="visible";var r={w:o.offsetWidth,h:o.offsetHeight};o.style.overflow="";return JSON.stringify(r);})()'
      ).then((result) => {
        try {
          const size = JSON.parse(result);
          const [cw, ch] = displayWin.getContentSize();
          const [ww, wh] = displayWin.getSize();
          const dw = ww - cw, dh = wh - ch;
          displayWin.setSize(Math.max(size.w + dw + 4, 200), Math.max(size.h + dh + 4, 50));
        } catch(e) {}
      }).catch(() => {});
    }, 500);
  });

  // 崩溃/进程退出处理
  displayWin.on('closed', () => { displayWin = null; });

  // 保存窗口位置和大小
  displayWin.on('resize', () => {
    const [w, h] = displayWin.getSize();
    const [x, y] = displayWin.getPosition();
    saveWindowState({ displayWidth: w, displayHeight: h, displayX: x, displayY: y });
  });
  displayWin.on('move', () => {
    const [x, y] = displayWin.getPosition();
    const [w, h] = displayWin.getSize();
    saveWindowState({ displayWidth: w, displayHeight: h, displayX: x, displayY: y });
  });

}

function createControlWindow() {
  const state = loadWindowState();

  controlWin = new BrowserWindow({
    width: state.controlWidth || 520,
    height: state.controlHeight || 640,
    x: state.controlX || 100,
    y: state.controlY || 100,
    frame: true,
    resizable: true,
    title: 'MD Stats - 控制面板',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  controlWin.loadFile(path.join(__dirname, 'src', 'control.html'));

  // 自动调整控制面板宽度到刚好显示全部内容
  controlWin.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      controlWin.webContents.executeJavaScript(
        'JSON.stringify({w:document.body.scrollWidth})'
      ).then((result) => {
        try {
          const size = JSON.parse(result);
          const [cw] = controlWin.getContentSize();
          const [ww] = controlWin.getSize();
          controlWin.setSize(Math.max(Math.ceil(size.w) + (ww - cw) + 4, 400), controlWin.getSize()[1]);
        } catch(e) {}
      }).catch(() => {});
    }, 300);
  });

  controlWin.on('resize', () => {
    const [w, h] = controlWin.getSize();
    const [x, y] = controlWin.getPosition();
    saveWindowState({ controlWidth: w, controlHeight: h, controlX: x, controlY: y });
  });
  controlWin.on('move', () => {
    const [x, y] = controlWin.getPosition();
    const [w, h] = controlWin.getSize();
    saveWindowState({ controlWidth: w, controlHeight: h, controlX: x, controlY: y });
  });

  controlWin.on('closed', () => { app.quit(); });
}

// ── IPC 处理 ──────────────────────────────────────────────────────────────
function notifyWindows() {
  const stats = computeStats();
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('stats-updated', stats);
  }
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('stats-updated', stats);
  }
}

ipcMain.handle('stats:get-all', () => {
  return { matches: data.matches, stats: computeStats() };
});

ipcMain.handle('stats:get-stats', () => {
  return computeStats();
});

ipcMain.handle('stats:add-match', (event, matchData) => {
  const match = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...matchData
  };
  data.matches.push(match);
  saveData();
  notifyWindows();
  return { success: true, match };
});

ipcMain.handle('stats:update-match', (event, { id, updates }) => {
  const idx = data.matches.findIndex(m => m.id === id);
  if (idx === -1) return { success: false, error: '未找到该对局' };
  data.matches[idx] = { ...data.matches[idx], ...updates };
  saveData();
  notifyWindows();
  return { success: true };
});

ipcMain.handle('stats:delete-match', (event, id) => {
  const idx = data.matches.findIndex(m => m.id === id);
  if (idx === -1) return { success: false, error: '未找到该对局' };
  data.matches.splice(idx, 1);
  saveData();
  notifyWindows();
  return { success: true };
});

ipcMain.handle('stats:export-json', () => {
  return JSON.stringify(data, null, 2);
});

ipcMain.handle('stats:import-json', (event, jsonStr) => {
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.matches || !Array.isArray(parsed.matches)) {
      return { success: false, error: '无效的数据格式' };
    }
    data = parsed;
    saveData();
    notifyWindows();
    return { success: true };
  } catch (e) {
    return { success: false, error: 'JSON 解析失败' };
  }
});

ipcMain.handle('stats:reset-matches', () => {
  data.matches = [];
  saveData();
  notifyWindows();
  return { success: true };
});

// ── 预设卡组管理 ─────────────────────────────────────────────────────────
ipcMain.handle('presets:get-all', () => {
  return (data.deckPresets || []);
});

ipcMain.handle('presets:add', (event, name) => {
  const n = name.trim();
  if (!n) return { success: false, error: '名称不能为空' };
  if (!data.deckPresets) data.deckPresets = [];
  if (data.deckPresets.includes(n)) return { success: false, error: '已存在' };
  data.deckPresets.push(n);
  saveData();
  return { success: true, presets: data.deckPresets };
});

ipcMain.handle('presets:delete', (event, name) => {
  if (!data.deckPresets) return { success: false };
  const idx = data.deckPresets.indexOf(name);
  if (idx === -1) return { success: false, error: '未找到' };
  data.deckPresets.splice(idx, 1);
  saveData();
  return { success: true, presets: data.deckPresets };
});

ipcMain.handle('presets:rename', (event, { oldName, newName }) => {
  if (!data.deckPresets) return { success: false };
  const idx = data.deckPresets.indexOf(oldName);
  if (idx === -1) return { success: false, error: '未找到' };
  const n = newName.trim();
  if (!n) return { success: false, error: '名称不能为空' };
  data.deckPresets[idx] = n;
  saveData();
  return { success: true, presets: data.deckPresets };
});

// ── 应用生命周期 ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadData();
  createDisplayWindow();
  createControlWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDisplayWindow();
      createControlWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
