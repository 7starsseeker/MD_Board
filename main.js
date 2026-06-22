const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ── 数据管理 ──────────────────────────────────────────────────────────────

/** 运行时的数据目录（系统临时目录） */
function getRuntimeDir() {
  return path.join(app.getPath('temp'), 'md-stats-data');
}

/** 持久化数据目录（exe 同级或项目本地） */
function getPersistDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }
  return path.join(__dirname, 'data');
}

const RUNTIME_DATA = () => path.join(getRuntimeDir(), 'stats.json');
const RUNTIME_WSTATE = () => path.join(getRuntimeDir(), 'window-state.json');

/** 持久化目录是否已存在（有 data/ 目录才启用持久模式） */
function hasPersistDir() {
  return fs.existsSync(getPersistDir());
}

let data = { matches: [], version: 3, deckPresets: [], myDeckPresets: [] };

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 加载数据：优先从持久化目录复制，再读运行目录 */
function loadData() {
  const persistDir = getPersistDir();
  const runtimeDir = getRuntimeDir();
  ensureDir(runtimeDir);

  // 如果有持久化数据，复制到运行目录
  const persistFile = path.join(persistDir, 'stats.json');
  const persistWs = path.join(persistDir, 'window-state.json');
  if (fs.existsSync(persistFile)) {
    try { fs.copyFileSync(persistFile, RUNTIME_DATA()); } catch(e) {}
    if (fs.existsSync(persistWs)) {
      try { fs.copyFileSync(persistWs, RUNTIME_WSTATE()); } catch(e) {}
    }
  }

  // 从运行目录读取
  try {
    if (fs.existsSync(RUNTIME_DATA())) {
      data = JSON.parse(fs.readFileSync(RUNTIME_DATA(), 'utf-8'));
      if (!data.deckPresets) data.deckPresets = [];
      if (!data.myDeckPresets) data.myDeckPresets = [];
      // 从 v2 迁移到 v3
      if (data.version === 2) {
        data.version = 3;
        data.myDeckPresets = [];
        saveData();
      }
    }
  } catch (e) {
    console.error('读取数据文件失败:', e.message);
  }
}

function saveData() {
  try {
    ensureDir(getRuntimeDir());
    fs.writeFileSync(RUNTIME_DATA(), JSON.stringify(data, null, 2), 'utf-8');
    // 如果已有持久目录，同步写入（源码模式或已保存过的 exe）
    if (hasPersistDir()) {
      fs.writeFileSync(path.join(getPersistDir(), 'stats.json'), JSON.stringify(data, null, 2), 'utf-8');
    }
  } catch (e) {
    console.error('保存数据文件失败:', e.message);
  }
}

/** 将运行时数据持久化到 exe 同级目录 */
function persistData() {
  const persistDir = getPersistDir();
  const runtimeDir = getRuntimeDir();
  ensureDir(persistDir);
  try {
    fs.copyFileSync(RUNTIME_DATA(), path.join(persistDir, 'stats.json'));
    const wsFile = RUNTIME_WSTATE();
    if (fs.existsSync(wsFile)) {
      fs.copyFileSync(wsFile, path.join(persistDir, 'window-state.json'));
    }
    return true;
  } catch (e) {
    console.error('持久化数据失败:', e.message);
    return false;
  }
}

// ── 统计计算（v2.0 增强版）─────────────────────────────────────────
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

  // ── 手坑统计 ──
  const gotMaxxc = matches.filter(m => m.gotMaxxc).length;
  const gotDroll = matches.filter(m => m.gotDroll).length;
  const gotJellyfish = matches.filter(m => m.gotJellyfish).length;
  const gotLancea = matches.filter(m => m.gotLancea).length;
  const gotNibiru = matches.filter(m => m.gotNibiru).length;
  // 合并吃G（增殖的G 或 鸟G/水母G，同一场只算一次）
  const gotAnyG = matches.filter(m => m.gotMaxxc || m.gotDroll || m.gotJellyfish).length;
  const gotDimension = matches.filter(m => m.gotDimension).length;
  const gotSmallHT = matches.filter(m => m.gotSmallHT).length;

  // ── 卡手统计 ──
  const cantPlay = matches.filter(m => m.cantPlay).length;
  const cantPlayGarnet = matches.filter(m => m.cantPlayGarnet).length;
  const cantPlayDuplicate = matches.filter(m => m.cantPlayDuplicate).length;
  const cantPlayHT = matches.filter(m => m.cantPlayHT).length;

  // ── 互卡统计 ──
  const bothStuck = matches.filter(m => m.bothStuck).length;

  // ── 掉线 / 超时 ──
  const disconnect = matches.filter(m => m.disconnect).length;
  const disconnectSelf = matches.filter(m => m.disconnect && m.disconnectWho === 'self').length;
  const disconnectOpponent = matches.filter(m => m.disconnect && m.disconnectWho === 'opponent').length;
  const timeout = matches.filter(m => m.timeout).length;
  const timeoutSelf = matches.filter(m => m.timeout && m.timeoutWho === 'self').length;
  const timeoutOpponent = matches.filter(m => m.timeout && m.timeoutWho === 'opponent').length;
  // 超时 × 卡组
  const timeoutSelfByDeck = {};
  matches.filter(m => m.timeout && m.timeoutWho === 'self').forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!timeoutSelfByDeck[deck]) timeoutSelfByDeck[deck] = 0;
    timeoutSelfByDeck[deck]++;
  });
  const timeoutOppByDeck = {};
  matches.filter(m => m.timeout && m.timeoutWho === 'opponent').forEach(m => {
    const deck = (m.opponentDeck || '').trim();
    if (!deck) return;
    if (!timeoutOppByDeck[deck]) timeoutOppByDeck[deck] = 0;
    timeoutOppByDeck[deck]++;
  });

  // ── 对手大牌哥 ──
  const bigHand = matches.filter(m => m.opponentBigHand).length;

  // ── 对手 T0 动 ──
  const opponentT0 = matches.filter(m => m.opponentT0).length;
  const opponentT0Wins = matches.filter(m => m.opponentT0 && m.result === 'win').length;
  const opponentT0Losses = matches.filter(m => m.opponentT0 && m.result === 'loss').length;
  // T0 × 对手卡组
  const opponentT0ByDeck = {};
  matches.filter(m => m.opponentT0).forEach(m => {
    const deck = (m.opponentDeck || '').trim();
    if (!deck || deck === '未知') return;
    if (!opponentT0ByDeck[deck]) opponentT0ByDeck[deck] = { total: 0, wins: 0, losses: 0 };
    opponentT0ByDeck[deck].total++;
    if (m.result === 'win') opponentT0ByDeck[deck].wins++;
    else if (m.result === 'loss') opponentT0ByDeck[deck].losses++;
  });

  // ── 先手终场分布（仅先手对局） ──
  const firstMatches = matches.filter(m => m.goingFirst);
  const endboardNormal = firstMatches.filter(m => m.endboardState === 'normal').length;
  const endboardCompromised = firstMatches.filter(m => m.endboardState === 'compromised').length;
  const endboardStopped = firstMatches.filter(m => m.endboardState === 'stopped').length;
  const endboardSurrender = firstMatches.filter(m => m.endboardState === 'surrender').length;

  // ── 后手突破统计（仅后手对局） ──
  const secondMatches = matches.filter(m => !m.goingFirst);
  const brokeYes = secondMatches.filter(m => m.brokeBoard === true || m.brokeBoard === 'true').length;
  const brokeNo = secondMatches.filter(m => m.brokeBoard === false || m.brokeBoard === 'false').length;
  const brokeSurrender = secondMatches.filter(m => m.brokeBoard === 'surrender').length;
  const otkYes = secondMatches.filter(m => m.otk === true || m.otk === 'true').length;

  // ── 提丰趣味统计 ──
  const typhonMatches = matches.filter(m => m.typhonAppeared);
  const typhonEnemyBlack = typhonMatches.filter(m => m.typhonWho === 'opponent' && m.result === 'win').length;
  const typhonEnemyWhite = typhonMatches.filter(m => m.typhonWho === 'opponent' && m.result === 'loss').length;
  const typhonSelfBlack = typhonMatches.filter(m => m.typhonWho === 'self' && m.result === 'loss').length;
  const typhonSelfWhite = typhonMatches.filter(m => m.typhonWho === 'self' && m.result === 'win').length;

  // ── 打错了统计 ──
  const mistakeMatches = matches.filter(m => m.mistake);
  const mistakeCount = mistakeMatches.length;
  const mistakeWins = mistakeMatches.filter(m => m.result === 'win').length;
  const mistakeLosses = mistakeMatches.filter(m => m.result === 'loss').length;
  // 打错了 × 自用卡组
  const mistakeByDeck = {};
  mistakeMatches.forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!mistakeByDeck[deck]) mistakeByDeck[deck] = { total: 0, wins: 0, losses: 0 };
    mistakeByDeck[deck].total++;
    if (m.result === 'win') mistakeByDeck[deck].wins++;
    else if (m.result === 'loss') mistakeByDeck[deck].losses++;
  });

  // ── 自用卡组统计 ──
  const myDeckStats = {};
  matches.filter(m => m.myDeck).forEach(m => {
    const deck = m.myDeck.trim();
    if (!deck) return;
    if (!myDeckStats[deck]) myDeckStats[deck] = { wins: 0, losses: 0, draws: 0, abnormals: 0, total: 0 };
    myDeckStats[deck].total++;
    if (m.result === 'win') myDeckStats[deck].wins++;
    else if (m.result === 'loss') myDeckStats[deck].losses++;
    else if (m.result === 'draw') myDeckStats[deck].draws++;
    else if (m.result === 'abnormal') myDeckStats[deck].abnormals++;
  });

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

  // ── 二维交叉统计：自己卡组 vs 对手卡组 ──
  const matchupStats = {};
  matches.forEach(m => {
    const myDeck = (m.myDeck || '').trim();
    const oppDeck = (m.opponentDeck || '').trim();
    if (!myDeck || !oppDeck) return;
    const key = myDeck + ' ⚔️ ' + oppDeck;
    if (!matchupStats[key]) {
      matchupStats[key] = { myDeck, opponentDeck: oppDeck, wins: 0, losses: 0, draws: 0, abnormals: 0, total: 0 };
    }
    matchupStats[key].total++;
    if (m.result === 'win') matchupStats[key].wins++;
    else if (m.result === 'loss') matchupStats[key].losses++;
    else if (m.result === 'draw') matchupStats[key].draws++;
    else if (m.result === 'abnormal') matchupStats[key].abnormals++;
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
    // 新 v2.0 统计 ────────────────────────────────────────────────
    handtrap: {
      total: gotMaxxc + gotDroll + gotJellyfish + gotLancea + gotNibiru + gotDimension + gotSmallHT,
      gotMaxxc, gotDroll, gotJellyfish, gotLancea, gotNibiru, gotAnyG, gotDimension, gotSmallHT,
      maxxcRate: total > 0 ? ((gotMaxxc / total) * 100).toFixed(1) : '0.0',
      anyGRate: total > 0 ? ((gotAnyG / total) * 100).toFixed(1) : '0.0',
      nibiruRate: total > 0 ? ((gotNibiru / total) * 100).toFixed(1) : '0.0'
    },
    handState: {
      cantPlay, cantPlayGarnet, cantPlayDuplicate, cantPlayHT,
      cantPlayRate: total > 0 ? ((cantPlay / total) * 100).toFixed(1) : '0.0',
      bothStuck,
      bothStuckRate: total > 0 ? ((bothStuck / total) * 100).toFixed(1) : '0.0'
    },
    connectivity: {
      disconnect, disconnectSelf, disconnectOpponent,
      disconnectRate: total > 0 ? ((disconnect / total) * 100).toFixed(1) : '0.0',
      timeout, timeoutSelf, timeoutOpponent,
      timeoutRate: total > 0 ? ((timeout / total) * 100).toFixed(1) : '0.0',
      timeoutSelfByDeck: Object.entries(timeoutSelfByDeck)
        .sort((a, b) => b[1] - a[1])
        .map(([deck, count]) => ({ deck, count })),
      timeoutOppByDeck: Object.entries(timeoutOppByDeck)
        .sort((a, b) => b[1] - a[1])
        .map(([deck, count]) => ({ deck, count }))
    },
    bigHand,
    opponentT0: {
      total: opponentT0,
      wins: opponentT0Wins,
      losses: opponentT0Losses,
      winRate: (opponentT0Wins + opponentT0Losses) > 0 ? ((opponentT0Wins / (opponentT0Wins + opponentT0Losses)) * 100).toFixed(1) : '0.0',
      byDeck: Object.entries(opponentT0ByDeck)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([deck, s]) => ({ deck, ...s,
          winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
        }))
    },
    endboard: {
      total: firstMatches.length,
      normal: endboardNormal,
      compromised: endboardCompromised,
      stopped: endboardStopped,
      surrender: endboardSurrender,
      normalRate: firstMatches.length > 0 ? ((endboardNormal / firstMatches.length) * 100).toFixed(1) : '0.0'
    },
    breakBoard: {
      total: secondMatches.length,
      success: brokeYes,
      failed: brokeNo,
      surrender: brokeSurrender,
      successRate: (brokeYes + brokeNo) > 0 ? ((brokeYes / (brokeYes + brokeNo)) * 100).toFixed(1) : '0.0',
      otk: otkYes,
      otkRate: brokeYes > 0 ? ((otkYes / brokeYes) * 100).toFixed(1) : '0.0'
    },
    myDeckStats: Object.entries(myDeckStats)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([deck, s]) => ({
        deck, ...s,
        winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
      })),
    deckStats: Object.entries(deckStats)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([deck, s]) => ({
        deck, ...s,
        winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
      })),
    // 打错了统计
    mistake: {
      total: mistakeCount,
      rate: total > 0 ? ((mistakeCount / total) * 100).toFixed(1) : '0.0',
      wins: mistakeWins,
      losses: mistakeLosses,
      winRate: (mistakeWins + mistakeLosses) > 0 ? ((mistakeWins / (mistakeWins + mistakeLosses)) * 100).toFixed(1) : '0.0',
      byDeck: Object.entries(mistakeByDeck)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([deck, s]) => ({ deck, ...s,
          winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
        }))
    },
    // 趣味统计
    typhon: {
      total: typhonMatches.length,
      enemyBlack: typhonEnemyBlack,
      enemyWhite: typhonEnemyWhite,
      selfBlack: typhonSelfBlack,
      selfWhite: typhonSelfWhite
    },
    matchupStats: Object.entries(matchupStats)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([key, s]) => ({
        myDeck: s.myDeck, opponentDeck: s.opponentDeck, ...s,
        winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
      }))
  };
}

// ── 窗口管理 ──────────────────────────────────────────────────────────────
let displayWin = null;
let controlWin = null;
const WINDOW_STATE_FILE = path.join(getRuntimeDir(), 'window-state.json');

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
    width: state.displayWidth || 376,
    height: state.displayHeight || 152,
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

  controlWin.on('close', (event) => {
    if (hasPersistDir()) {
      // 已有持久目录：静默自动保存（源码模式或已保存过的 exe）
      persistData();
    } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
      // 便携版且尚无 data/ 目录：询问是否保存
      const choice = dialog.showMessageBoxSync(controlWin, {
        type: 'question',
        buttons: ['保存并退出', '直接退出', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: 'MD_Board',
        message: '是否将对局数据保存到 exe 同级目录？',
        detail: '保存后下次启动时自动加载。取消则仅保留在系统临时目录。'
      });
      if (choice === 2) { event.preventDefault(); return; }  // 取消
      if (choice === 0) persistData();
    }
    // 源码模式且尚无 data/（理论上不会发生）不做特殊处理
  });
  controlWin.on('closed', () => { app.quit(); });
}

// ── 详细统计窗口 ─────────────────────────────────────────────────────────
let statsWin = null;

ipcMain.handle('stats:open-window', () => {
  if (statsWin && !statsWin.isDestroyed()) {
    statsWin.focus();
    return;
  }

  statsWin = new BrowserWindow({
    width: 800,
    height: 640,
    frame: true,
    resizable: true,
    title: 'MD Stats - 详细统计',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  statsWin.loadFile(path.join(__dirname, 'src', 'stats.html'));

  statsWin.on('closed', () => { statsWin = null; });
});

// ── IPC 处理 ──────────────────────────────────────────────────────────────
function notifyWindows() {
  const stats = computeStats();
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('stats-updated', stats);
  }
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('stats-updated', stats);
  }
  if (statsWin && !statsWin.isDestroyed()) {
    statsWin.webContents.send('stats-updated', stats);
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

// ── 数据持久化（便携版用） ───────────────────────────────────────────────
ipcMain.handle('stats:persist-data', () => {
  return { success: persistData() };
});

ipcMain.handle('stats:is-portable', () => {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
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

// ── 自用卡组预设管理 ─────────────────────────────────────────────────
ipcMain.handle('mydeck:get-all', () => {
  return (data.myDeckPresets || []);
});

ipcMain.handle('mydeck:add', (event, name) => {
  const n = name.trim();
  if (!n) return { success: false, error: '名称不能为空' };
  if (!data.myDeckPresets) data.myDeckPresets = [];
  if (data.myDeckPresets.includes(n)) return { success: false, error: '已存在' };
  data.myDeckPresets.push(n);
  saveData();
  return { success: true, presets: data.myDeckPresets };
});

ipcMain.handle('mydeck:delete', (event, name) => {
  if (!data.myDeckPresets) return { success: false };
  const idx = data.myDeckPresets.indexOf(name);
  if (idx === -1) return { success: false, error: '未找到' };
  data.myDeckPresets.splice(idx, 1);
  saveData();
  return { success: true, presets: data.myDeckPresets };
});

ipcMain.handle('mydeck:rename', (event, { oldName, newName }) => {
  if (!data.myDeckPresets) return { success: false };
  const idx = data.myDeckPresets.indexOf(oldName);
  if (idx === -1) return { success: false, error: '未找到' };
  const n = newName.trim();
  if (!n) return { success: false, error: '名称不能为空' };
  data.myDeckPresets[idx] = n;
  saveData();
  return { success: true, presets: data.myDeckPresets };
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
