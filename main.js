const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ── 数据管理 ──────────────────────────────────────────────────────────────

/** 数据目录（系统临时目录） */
function getRuntimeDir() {
  return path.join(app.getPath('temp'), 'md-stats-data');
}

const RUNTIME_DATA = () => path.join(getRuntimeDir(), 'stats.json');
const RUNTIME_WSTATE = () => path.join(getRuntimeDir(), 'window-state.json');

let data = { matches: [], version: 4, deckPresets: [], myDeckPresets: [], handtrapPresets: [], handtrapConfig: { largeIds: [], compactIds: [] }, cycleConfig: null, timeRange: 'all', selectedDate: null, customStart: null, customEnd: null };

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 加载数据：从系统临时目录读取 */
function loadData() {
  const runtimeDir = getRuntimeDir();
  ensureDir(runtimeDir);

  const runtimeFile = RUNTIME_DATA();
  try {
    if (fs.existsSync(runtimeFile)) {
      data = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8'));
      if (!data.deckPresets) data.deckPresets = [];
      if (!data.myDeckPresets) data.myDeckPresets = [];
      if (!data.handtrapPresets || !Array.isArray(data.handtrapPresets) || data.handtrapPresets.length === 0) {
        data.handtrapPresets = [
          { id: 'gotMaxxc', label: '增殖的G' },
          { id: 'gotDroll', label: '鸟G' },
          { id: 'gotJellyfish', label: '水母G' },
          { id: 'gotLancea', label: '锁鸟' },
          { id: 'gotNibiru', label: '陨石' },
          { id: 'gotDimension', label: '大宇宙人/次元系' }
        ];
      }
      if (!data.handtrapConfig || !data.handtrapConfig.largeIds) {
        data.handtrapConfig = { largeIds: ['gotMaxxc', 'gotDroll', 'gotJellyfish', 'gotLancea'], compactIds: ['gotNibiru', 'gotDimension'] };
      }
      // 大字显示最多3个，超限时自动全部降级到简略
      if (data.handtrapConfig.largeIds && data.handtrapConfig.largeIds.length > 3) {
        const moved = data.handtrapConfig.largeIds.splice(0);
        data.handtrapConfig.compactIds = [...new Set([...(data.handtrapConfig.compactIds || []), ...moved])];
      }
      // 从 v2 迁移到 v3
      if (data.version === 2) {
        data.version = 3;
        data.myDeckPresets = [];
        saveData();
      }
      // 从 v3 迁移到 v4
      if (data.version === 3) {
        data.version = 4;
        data.cycleConfig = getDefaultCycleConfig();
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
  } catch (e) {
    console.error('保存数据文件失败:', e.message);
  }
}

// ── 时间范围过滤 ──────────────────────────────────────────────────
function filterMatchesByTimeRange(matches, range) {
  if (range === 'all' || !range) return matches;
  const now = new Date();
  let start, end;
  if (range === 'today') {
    if (data.selectedDate) {
      // 使用选中的具体日期
      start = new Date(data.selectedDate);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(end.getDate() + 1);
    } else {
      // 回退到当天
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end = new Date(start);
      end.setDate(end.getDate() + 1);
    }
  } else if (range === 'week') {
    // 使用选中日期所在周（周一起算），否则用当前周
    const ref = data.selectedDate ? new Date(data.selectedDate) : now;
    const day = ref.getDay();
    const diff = (day === 0 ? 6 : day - 1);
    start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - diff);
  } else if (range === 'month') {
    // 使用选中日期所在月，否则用当前月
    const ref = data.selectedDate ? new Date(data.selectedDate) : now;
    start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  } else if (range === 'custom') {
    start = data.customStart ? new Date(data.customStart) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (start) start.setHours(0, 0, 0, 0);
    end = data.customEnd ? new Date(data.customEnd) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (end) { end.setDate(end.getDate() + 1); end.setHours(0, 0, 0, 0); }
  } else {
    return matches;
  }
  const startTs = start.getTime();
  const endTs = end ? end.getTime() : Infinity;
  return matches.filter(m => {
    const t = new Date(m.timestamp).getTime();
    return t >= startTs && t < endTs;
  });
}

// ── 手坑兼容读取 ──────────────────────────────────────────────
/** 从 match 中提取手坑 ID 数组（兼容新旧数据格式） */
function getMatchHandtraps(match) {
  if (match.handtraps && Array.isArray(match.handtraps) && match.handtraps.length > 0) {
    return match.handtraps;
  }
  // 旧数据回退
  const result = [];
  if (match.gotMaxxc) result.push('gotMaxxc');
  if (match.gotDroll) result.push('gotDroll');
  if (match.gotJellyfish) result.push('gotJellyfish');
  if (match.gotLancea) result.push('gotLancea');
  if (match.gotNibiru) result.push('gotNibiru');
  if (match.gotDimension) result.push('gotDimension');
  if (match.gotSmallHT) result.push('_other');
  return result;
}

// ── 统计计算（v2.0 增强版）─────────────────────────────────────────
function computeStats() {
  const allMatches = data.matches || [];
  const timeRange = data.timeRange || 'all';
  const matches = filterMatchesByTimeRange(allMatches, timeRange);
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
    result: m.result, goingFirst: m.goingFirst, opponentDeck: m.opponentDeck || '',
    coinToss: m.coinToss
  }));

  // ── 手坑统计（动态） ──
  const presets = data.handtrapPresets || [];
  const htConfig = data.handtrapConfig || { largeIds: [], compactIds: [] };
  const htCounts = {};
  const htByFirst = {};
  const htBySecond = {};
  presets.forEach(p => {
    htCounts[p.id] = matches.filter(m => getMatchHandtraps(m).includes(p.id)).length;
    htByFirst[p.id] = matches.filter(m => getMatchHandtraps(m).includes(p.id) && m.goingFirst).length;
    htBySecond[p.id] = matches.filter(m => getMatchHandtraps(m).includes(p.id) && !m.goingFirst).length;
  });
  // 额外统计"其他手坑"（_other），以及已删除预设的旧数据
  const gotOther = matches.filter(m => getMatchHandtraps(m).includes('_other')).length;
  const allPresetIds = new Set(presets.map(p => p.id));
  const deletedPresetCount = matches.filter(m => {
    return getMatchHandtraps(m).some(id => id !== '_other' && !allPresetIds.has(id));
  }).length;
  htCounts['_other'] = gotOther + deletedPresetCount;
  htByFirst['_other'] = matches.filter(m => getMatchHandtraps(m).includes('_other') && m.goingFirst).length;
  htBySecond['_other'] = matches.filter(m => getMatchHandtraps(m).includes('_other') && !m.goingFirst).length;
  if (deletedPresetCount > 0) {
    htByFirst['_other'] += matches.filter(m => {
      return getMatchHandtraps(m).some(id => id !== '_other' && !allPresetIds.has(id)) && m.goingFirst;
    }).length;
    htBySecond['_other'] += matches.filter(m => {
      return getMatchHandtraps(m).some(id => id !== '_other' && !allPresetIds.has(id)) && !m.goingFirst;
    }).length;
  }
  // 旧字段兼容（保持后端引用不报错）
  const gotMaxxc = htCounts['gotMaxxc'] || 0;
  const gotDroll = htCounts['gotDroll'] || 0;
  const gotJellyfish = htCounts['gotJellyfish'] || 0;
  const gotLancea = htCounts['gotLancea'] || 0;
  const gotNibiru = htCounts['gotNibiru'] || 0;
  const gotDimension = htCounts['gotDimension'] || 0;
  const gotSmallHT = gotOther;
  const gotAnyG = matches.filter(m => getMatchHandtraps(m).some(id => ['gotMaxxc', 'gotDroll', 'gotJellyfish'].includes(id))).length;

  // ── 卡手统计 ──
  const cantPlay = matches.filter(m => m.cantPlay || m.bothStuck).length;
  const cantPlayGarnet = matches.filter(m => m.cantPlayGarnet).length;
  const cantPlayDuplicate = matches.filter(m => m.cantPlayDuplicate).length;
  const cantPlayHT = matches.filter(m => m.cantPlayHT).length;

  // ── 互卡统计 ──
  const bothStuck = matches.filter(m => m.bothStuck).length;
  // 有效卡手 = 任一卡手情况被选中即计为一场（同一场多项也只计一次）
  const totalCantPlay = matches.filter(m => m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck).length;

  // ── 卡手统计 · 先后手细分 ──
  const gfTotal = gfAll.length;
  const gsTotal = gsAll.length;
  const cantPlayFirst = matches.filter(m => (m.cantPlay || m.bothStuck) && m.goingFirst).length;
  const cantPlaySecond = matches.filter(m => (m.cantPlay || m.bothStuck) && !m.goingFirst).length;
  const cantPlayGarnetFirst = matches.filter(m => m.cantPlayGarnet && m.goingFirst).length;
  const cantPlayGarnetSecond = matches.filter(m => m.cantPlayGarnet && !m.goingFirst).length;
  const cantPlayDuplicateFirst = matches.filter(m => m.cantPlayDuplicate && m.goingFirst).length;
  const cantPlayDuplicateSecond = matches.filter(m => m.cantPlayDuplicate && !m.goingFirst).length;
  const cantPlayHTFirst = matches.filter(m => m.cantPlayHT && m.goingFirst).length;
  const cantPlayHTSecond = matches.filter(m => m.cantPlayHT && !m.goingFirst).length;
  const bothStuckFirst = matches.filter(m => m.bothStuck && m.goingFirst).length;
  const bothStuckSecond = matches.filter(m => m.bothStuck && !m.goingFirst).length;
  // ── 互卡子选项统计 ──
  const bsMatches = matches.filter(m => m.bothStuck);
  // 兼容旧版：旧版 firstMover 直接存 "self"/"opponent"（相当于"有人先动" + 谁先动）
  const bsFirstMove = bsMatches.filter(m => m.firstMover === 'move' || m.firstMover === 'self' || m.firstMover === 'opponent').length;
  const bsFirstMoveSelf = bsMatches.filter(m => (m.firstMover === 'move' && m.moverWho === 'self') || m.firstMover === 'self').length;
  const bsFirstMoveOpp = bsMatches.filter(m => (m.firstMover === 'move' && m.moverWho === 'opponent') || m.firstMover === 'opponent').length;
  const bsSurrender = bsMatches.filter(m => m.firstMover === 'surrender').length;
  const bsSurrenderSelf = bsMatches.filter(m => m.firstMover === 'surrender' && m.surrenderWho === 'self').length;
  const bsSurrenderOpp = bsMatches.filter(m => m.firstMover === 'surrender' && m.surrenderWho === 'opponent').length;
  const bsOther = bsMatches.filter(m => m.firstMover === 'other' || !m.firstMover).length;
  const totalCantPlayFirst = matches.filter(m => (m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck) && m.goingFirst).length;
  const totalCantPlaySecond = matches.filter(m => (m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck) && !m.goingFirst).length;

  // ── 卡手 × 自用卡组 ──
  const cantPlayByDeck = {};
  matches.forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!cantPlayByDeck[deck]) cantPlayByDeck[deck] = { total: 0, wins: 0, losses: 0, cantPlayCount: 0, cantPlayAlone: 0, cantPlayGarnetCount: 0, cantPlayDuplicateCount: 0, cantPlayHTCount: 0, bothStuckCount: 0 };
    cantPlayByDeck[deck].total++;
    if (m.result === 'win') cantPlayByDeck[deck].wins++;
    else if (m.result === 'loss') cantPlayByDeck[deck].losses++;
    if (m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck) {
      cantPlayByDeck[deck].cantPlayCount++;
    }
    if (m.cantPlay) cantPlayByDeck[deck].cantPlayAlone++;
    if (m.cantPlayGarnet) cantPlayByDeck[deck].cantPlayGarnetCount++;
    if (m.cantPlayDuplicate) cantPlayByDeck[deck].cantPlayDuplicateCount++;
    if (m.cantPlayHT) cantPlayByDeck[deck].cantPlayHTCount++;
    if (m.bothStuck) cantPlayByDeck[deck].bothStuckCount++;
  });

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
  const bigHandMatches = matches.filter(m => m.opponentBigHand);
  const bigHandTotal = bigHandMatches.length;
  const bigHandFirst = bigHandMatches.filter(m => m.goingFirst).length;
  const bigHandSecond = bigHandMatches.filter(m => !m.goingFirst).length;

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
  // 先手终场没做出来、但对手以非正常方式"直接胜利"的情况（对方跑/掉线/超时/抽干）
  const opponentDirectWin = m =>
    m.endboardState === 'stopped' && (
      m.opponentRan ||
      (m.disconnect && m.disconnectWho === 'opponent') ||
      (m.timeout && m.timeoutWho === 'opponent') ||
      (m.deckOut && m.deckOutWho === 'opponent')
    );
  const endboardTrueStopped = firstMatches.filter(m => m.endboardState === 'stopped' && !opponentDirectWin(m)).length;
  const opponentSurrendered = firstMatches.filter(m => opponentDirectWin(m)).length;
  const endboardSurrender = firstMatches.filter(m => m.endboardState === 'surrender').length;

  // ── 后手突破统计（仅后手对局） ──
  const secondMatches = matches.filter(m => !m.goingFirst);
  const brokeYes = secondMatches.filter(m => m.brokeBoard === true || m.brokeBoard === 'true').length;
  const brokeNo = secondMatches.filter(m => m.brokeBoard === false || m.brokeBoard === 'false').length;
  const brokeSurrender = secondMatches.filter(m => m.brokeBoard === 'surrender').length;
  const brokeNotNeeded = secondMatches.filter(m => m.brokeBoard === 'not_applicable').length;
  const brokeSuccessWins = secondMatches.filter(m => (m.brokeBoard === true || m.brokeBoard === 'true') && m.result === 'win').length;

  // ── 提丰趣味统计 ──
  const typhonMatches = matches.filter(m => m.typhonAppeared);
  const typhonEnemyBlack = typhonMatches.filter(m => m.typhonWho === 'opponent' && m.result === 'win').length;
  const typhonEnemyWhite = typhonMatches.filter(m => m.typhonWho === 'opponent' && m.result === 'loss').length;
  const typhonSelfBlack = typhonMatches.filter(m => m.typhonWho === 'self' && m.result === 'loss').length;
  const typhonSelfWhite = typhonMatches.filter(m => m.typhonWho === 'self' && m.result === 'win').length;

  // ── 抽干牌组统计 ──
  const deckOutMatches = matches.filter(m => m.deckOut);
  const deckOutSelf = deckOutMatches.filter(m => m.deckOutWho === 'self').length;
  const deckOutOpponent = deckOutMatches.filter(m => m.deckOutWho === 'opponent').length;
  const deckOutSelfWins = deckOutMatches.filter(m => m.deckOutWho === 'self' && m.result === 'win').length;

  // ── 严重失误统计 ──
  const mistakeMatches = matches.filter(m => m.mistake);
  const mistakeCount = mistakeMatches.length;
  const mistakeWins = mistakeMatches.filter(m => m.result === 'win').length;
  const mistakeLosses = mistakeMatches.filter(m => m.result === 'loss').length;
  // 严重失误 × 自用卡组
  const mistakeByDeck = {};
  mistakeMatches.forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!mistakeByDeck[deck]) mistakeByDeck[deck] = { total: 0, wins: 0, losses: 0 };
    mistakeByDeck[deck].total++;
    if (m.result === 'win') mistakeByDeck[deck].wins++;
    else if (m.result === 'loss') mistakeByDeck[deck].losses++;
  });

  // ── 吓跑对手统计 ──
  const opponentRanMatches = matches.filter(m => m.opponentRan);
  const opponentRanCount = opponentRanMatches.length;
  const opponentRanByDeck = {};
  opponentRanMatches.forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!opponentRanByDeck[deck]) opponentRanByDeck[deck] = 0;
    opponentRanByDeck[deck]++;
  });
  // 吓跑对手 - 先手终场类型细分
  const opponentRanFirst = opponentRanMatches.filter(m => m.goingFirst);
  const opponentRanFirstEndboard = {
    normal: opponentRanFirst.filter(m => m.endboardState === 'normal').length,
    compromised: opponentRanFirst.filter(m => m.endboardState === 'compromised').length,
    stopped: opponentRanFirst.filter(m => m.endboardState === 'stopped').length,
    other: opponentRanFirst.filter(m => m.endboardState && m.endboardState !== 'normal' && m.endboardState !== 'compromised' && m.endboardState !== 'stopped').length,
    noEndboard: opponentRanFirst.filter(m => !m.endboardState).length
  };
  // 吓跑对手 - 后手突破类型细分
  const opponentRanSecond = opponentRanMatches.filter(m => !m.goingFirst);
  const opponentRanSecondBroke = {
    notNeeded: opponentRanSecond.filter(m => m.brokeBoard === 'not_applicable').length,
    success: opponentRanSecond.filter(m => m.brokeBoard === true || m.brokeBoard === 'true').length,
    failed: opponentRanSecond.filter(m => m.brokeBoard === false || m.brokeBoard === 'false').length,
    other: opponentRanSecond.filter(m => m.brokeBoard && m.brokeBoard !== 'not_applicable' && m.brokeBoard !== true && m.brokeBoard !== 'true' && m.brokeBoard !== false && m.brokeBoard !== 'false').length,
    noBroke: opponentRanSecond.filter(m => !m.brokeBoard).length
  };

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

  // ── 晋级赛 / 保级赛统计 ──
  function computeTypeStats(typeMatches) {
    const tWins = typeMatches.filter(m => m.result === 'win').length;
    const tLosses = typeMatches.filter(m => m.result === 'loss').length;
    const tTotal = tWins + tLosses;
    if (tTotal === 0) return null;
    // 硬币
    const tCoin = typeMatches.filter(m => m.coinToss === true || m.coinToss === false);
    const tCoinWins = tCoin.filter(m => m.coinToss === true).length;
    // 先后手
    const tFirst = typeMatches.filter(m => m.goingFirst);
    const tFirstWins = tFirst.filter(m => m.result === 'win').length;
    const tSecond = typeMatches.filter(m => !m.goingFirst);
    const tSecondWins = tSecond.filter(m => m.result === 'win').length;
    // 手坑（兼容新旧格式）
    const tHTMatches = typeMatches.map(function(m) { return getMatchHandtraps(m); });
    const tMaxxc = tHTMatches.filter(function(h) { return h.includes('gotMaxxc'); }).length;
    const tDroll = tHTMatches.filter(function(h) { return h.includes('gotDroll'); }).length;
    const tJellyfish = tHTMatches.filter(function(h) { return h.includes('gotJellyfish'); }).length;
    const tLancea = tHTMatches.filter(function(h) { return h.includes('gotLancea'); }).length;
    const tNibiru = tHTMatches.filter(function(h) { return h.includes('gotNibiru'); }).length;
    const tDimension = tHTMatches.filter(function(h) { return h.includes('gotDimension'); }).length;
    const tSmallHT = tHTMatches.filter(function(h) { return h.includes('_other'); }).length;
    const tAnyG = tHTMatches.filter(function(h) { return h.includes('gotMaxxc') || h.includes('gotDroll') || h.includes('gotJellyfish'); }).length;
    // 卡手
    const tCantPlay = typeMatches.filter(m => m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck).length;
    // 对手大牌
    const tBigHand = typeMatches.filter(m => m.opponentBigHand).length;
    // 对手卡组
    const tOppDecks = {};
    typeMatches.forEach(m => {
      if (!m.opponentDeck) return;
      const d = m.opponentDeck.trim();
      if (!d) return;
      if (!tOppDecks[d]) tOppDecks[d] = { total: 0, wins: 0, losses: 0 };
      tOppDecks[d].total++;
      if (m.result === 'win') tOppDecks[d].wins++;
      else if (m.result === 'loss') tOppDecks[d].losses++;
    });
    return {
      total: tTotal, wins: tWins, losses: tLosses,
      winRate: tTotal > 0 ? ((tWins / tTotal) * 100).toFixed(1) : '0.0',
      coinWinRate: tCoin.length > 0 ? ((tCoinWins / tCoin.length) * 100).toFixed(1) : '0.0',
      firstWinRate: tFirst.length > 0 ? ((tFirstWins / tFirst.length) * 100).toFixed(1) : '0.0',
      secondWinRate: tSecond.length > 0 ? ((tSecondWins / tSecond.length) * 100).toFixed(1) : '0.0',
      handtrap: {
        gotMaxxc: tMaxxc, gotDroll: tDroll, gotJellyfish: tJellyfish,
        gotLancea: tLancea, gotNibiru: tNibiru, gotDimension: tDimension,
        gotSmallHT: tSmallHT, gotAnyG: tAnyG,
        // 动态手坑列表（供渲染端展示预设手坑）
        presets: data.handtrapPresets || [],
        counts: (function() {
          var c = {};
          (data.handtrapPresets || []).forEach(function(p) {
            c[p.id] = tHTMatches.filter(function(h) { return h.includes(p.id); }).length;
          });
          c['_other'] = tSmallHT;
          return c;
        })()
      },
      cantPlayRate: tTotal > 0 ? ((tCantPlay / tTotal) * 100).toFixed(1) : '0.0',
      bigHandRate: tTotal > 0 ? ((tBigHand / tTotal) * 100).toFixed(1) : '0.0',
      oppDecks: Object.entries(tOppDecks)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([d, s]) => ({ deck: d, ...s, winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0' }))
    };
  }
  const promotionMatches = matches.filter(m => m.matchType === 'promotion');
  const relegationMatches = matches.filter(m => m.matchType === 'relegation');
  const rankedStats = {
    promotion: computeTypeStats(promotionMatches),
    relegation: computeTypeStats(relegationMatches)
  };

  // ── 硬币历史记录（供 streak 分析和返回共用）──
  var coinHistory = matches.filter(function(m) { return m.coinToss === true || m.coinToss === false; }).map(function(m) {
    return { coinToss: m.coinToss, result: m.result, goingFirst: m.goingFirst };
  });

  return {
    total, wins, losses, draws, abnormals,
    winRate: playable > 0 ? ((wins / playable) * 100).toFixed(1) : '0.0',
    coin: {
      total: coinMatches.length,
      wins: coinWins,
      losses: coinLosses,
      winRate: coinMatches.length > 0 ? ((coinWins / coinMatches.length) * 100).toFixed(1) : '0.0',
      // ── 硬币连正/连反分析 ──
      streak: (function() {
        var arr = coinHistory;
        var n = arr.length;
        if (n === 0) return { current: null, longest: 0, longestType: null, severity: '—', severityScore: 0, pValue: 1 };
        // 扫描所有连续段
        var curType = arr[0].coinToss;
        var curLen = 1;
        var maxLen = 1;
        var maxType = curType;
        for (var si = 1; si < n; si++) {
          if (arr[si].coinToss === curType) {
            curLen++;
          } else {
            curType = arr[si].coinToss;
            curLen = 1;
          }
          if (curLen > maxLen) { maxLen = curLen; maxType = curType; }
        }
        // 当前连续（从尾部向前扫描）
        var curCoin = arr[n - 1].coinToss;
        var curStreak = 1;
        for (var si2 = n - 2; si2 >= 0; si2--) {
          if (arr[si2].coinToss === curCoin) curStreak++;
          else break;
        }
        // 统计显著性：最长连续段长度 L 在 N 次抛掷中出现的概率
        // 近似公式 P(最长连续 ≥ L) ≈ 1 - exp(-N / 2^(L+1))
        var L = maxLen;
        var pVal = 1;
        if (n > 0 && L > 0) {
          pVal = 1 - Math.exp(-n / Math.pow(2, L + 1));
          if (pVal < 0) pVal = 0;
        }
        // 期望最长连续长度 ≈ log2(N) + 1/3
        var expectedMax = Math.log2(n) + 0.333;
        // 严重程度评分 0~100（基于与期望值的偏离程度）
        var diff = L - expectedMax;
        var score = Math.min(100, Math.max(0, Math.round((diff / (expectedMax > 3 ? 3 : 2)) * 100)));
        // 严重程度等级：基于 severityScore（与展示颜色阈值对齐）
        var severity;
        if (score <= 20) severity = '正常';
        else if (score <= 50) severity = '⚠️ 偏高';
        else if (score <= 75) severity = '🔴 显著';
        else severity = '🔥 异常';
        // 极端情况：L 很小但 n 很大时 pVal 也小，但此时不视为异常
        if (L <= 2) { severity = '正常'; score = 0; }
        return {
          current: { type: curCoin, length: curStreak },
          longest: { type: maxType, length: maxLen },
          severity: severity,
          severityScore: score,
          pValue: pVal,
          expectedMax: expectedMax.toFixed(1)
        };
      })(),
      // ── 硬币偏斜检测（总体比例是否偏离 50%）──
      bias: (function() {
        var h = coinWins, t = coinLosses, n = h + t;
        if (n < 10) return { heads: h, tails: t, pct: '—', zScore: 0, severity: '—', severityScore: 0 };
        var expected = n / 2;
        var se = Math.sqrt(n) / 2;  // 标准误 = sqrt(n * 0.5 * 0.5)
        var z = Math.abs(h - expected) / se;
        var pct = ((h / n) * 100).toFixed(1);
        var score = Math.min(100, Math.round((z / 4) * 100));
        var severity;
        if (score <= 20) severity = '正常';
        else if (score <= 50) severity = '⚠️ 偏高';
        else if (score <= 75) severity = '🔴 显著';
        else severity = '🔥 异常';
        return { heads: h, tails: t, pct: pct, zScore: z, severity: severity, severityScore: score };
      })()
    },
    coinHistory: coinHistory,
    resultHistory: matches.map(function(m) { return m.result; }),
    deckResults: (function() {
      var dr = {};
      matches.forEach(function(m) {
        var deck = m.myDeck;
        if (deck && (m.result === 'win' || m.result === 'loss')) {
          if (!dr[deck]) dr[deck] = [];
          dr[deck].push(m.result);
        }
      });
      return dr;
    })(),
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
      nibiruRate: total > 0 ? ((gotNibiru / total) * 100).toFixed(1) : '0.0',
      // 先后手细分（向后兼容，原有字段不变）
      byFirst: { gotMaxxc: htByFirst['gotMaxxc']||0, gotDroll: htByFirst['gotDroll']||0, gotJellyfish: htByFirst['gotJellyfish']||0, gotLancea: htByFirst['gotLancea']||0, gotNibiru: htByFirst['gotNibiru']||0, gotDimension: htByFirst['gotDimension']||0, gotSmallHT: htByFirst['_other']||0, gotAnyG: matches.filter(m => getMatchHandtraps(m).some(id => ['gotMaxxc','gotDroll','gotJellyfish'].includes(id)) && m.goingFirst).length },
      bySecond: { gotMaxxc: htBySecond['gotMaxxc']||0, gotDroll: htBySecond['gotDroll']||0, gotJellyfish: htBySecond['gotJellyfish']||0, gotLancea: htBySecond['gotLancea']||0, gotNibiru: htBySecond['gotNibiru']||0, gotDimension: htBySecond['gotDimension']||0, gotSmallHT: htBySecond['_other']||0, gotAnyG: matches.filter(m => getMatchHandtraps(m).some(id => ['gotMaxxc','gotDroll','gotJellyfish'].includes(id)) && !m.goingFirst).length },
      // 新字段：预设列表 + 配置 + 动态计数
      presets: data.handtrapPresets || [],
      config: data.handtrapConfig || { largeIds: [], compactIds: [] },
      counts: htCounts,
      byFirstAll: htByFirst,
      bySecondAll: htBySecond
    },
    handState: {
      cantPlay, cantPlayGarnet, cantPlayDuplicate, cantPlayHT,
      totalCantPlay,
      cantPlayRate: total > 0 ? ((totalCantPlay / total) * 100).toFixed(1) : '0.0',
      bothStuck,
      bothStuckRate: total > 0 ? ((bothStuck / total) * 100).toFixed(1) : '0.0',
      // 先后手细分
      gfTotal, gsTotal,
      byFirst: { cantPlay: cantPlayFirst, cantPlayGarnet: cantPlayGarnetFirst, cantPlayDuplicate: cantPlayDuplicateFirst, cantPlayHT: cantPlayHTFirst, bothStuck: bothStuckFirst, totalCantPlay: totalCantPlayFirst },
      bySecond: { cantPlay: cantPlaySecond, cantPlayGarnet: cantPlayGarnetSecond, cantPlayDuplicate: cantPlayDuplicateSecond, cantPlayHT: cantPlayHTSecond, bothStuck: bothStuckSecond, totalCantPlay: totalCantPlaySecond },
      // 互卡子选项详情
      bothStuckDetail: {
        total: bothStuck,
        firstMove: bsFirstMove, firstMoveSelf: bsFirstMoveSelf, firstMoveOpp: bsFirstMoveOpp,
        surrender: bsSurrender, surrenderSelf: bsSurrenderSelf, surrenderOpp: bsSurrenderOpp,
        other: bsOther
      },
      // 各卡组明细
      byDeck: Object.entries(cantPlayByDeck)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([deck, s]) => ({
          deck, ...s,
          cantPlayRate: s.total > 0 ? ((s.cantPlayCount / s.total) * 100).toFixed(1) : '0.0',
          winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
        }))
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
    bigHand: {
      total: bigHandTotal,
      first: bigHandFirst,
      second: bigHandSecond
    },
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
      stopped: endboardTrueStopped,
      surrender: endboardSurrender,
      opponentSurrendered: opponentSurrendered,
      normalRate: firstMatches.length > 0 ? ((endboardNormal / firstMatches.length) * 100).toFixed(1) : '0.0'
    },
    breakBoard: {
      total: secondMatches.length,
      success: brokeYes,
      failed: brokeNo,
      surrender: brokeSurrender,
      notNeeded: brokeNotNeeded,
      successWins: brokeSuccessWins,
      successRate: secondMatches.length > 0 ? ((brokeYes / secondMatches.length) * 100).toFixed(1) : '0.0',
      successWinRate: brokeYes > 0 ? ((brokeSuccessWins / brokeYes) * 100).toFixed(1) : '0.0'
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
    // 严重失误统计
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
    // 吓跑对手统计
    opponentRan: {
      total: opponentRanCount,
      rate: total > 0 ? ((opponentRanCount / total) * 100).toFixed(1) : '0.0',
      byDeck: Object.entries(opponentRanByDeck)
        .sort((a, b) => b[1] - a[1])
        .map(([deck, count]) => ({ deck, count })),
      // 先手细分：对手跑时场面状态
      firstTotal: opponentRanFirst.length,
      firstEndboard: opponentRanFirstEndboard,
      // 后手细分：对手跑时突破状态
      secondTotal: opponentRanSecond.length,
      secondBroke: opponentRanSecondBroke
    },
    // 趣味统计
    typhon: {
      total: typhonMatches.length,
      enemyBlack: typhonEnemyBlack,
      enemyWhite: typhonEnemyWhite,
      selfBlack: typhonSelfBlack,
      selfWhite: typhonSelfWhite
    },
    deckOut: {
      total: deckOutMatches.length,
      self: deckOutSelf,
      opponent: deckOutOpponent,
      selfWinRate: deckOutSelf > 0 ? ((deckOutSelfWins / deckOutSelf) * 100).toFixed(1) : '0.0'
    },
    matchupStats: Object.entries(matchupStats)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([key, s]) => ({
        myDeck: s.myDeck, opponentDeck: s.opponentDeck, ...s,
        winRate: (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0'
      })),
    rankedStats
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
    width: state.controlWidth || 580,
    height: state.controlHeight || 640,
    x: state.controlX || 100,
    y: state.controlY || 100,
    frame: false,
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

// ── 详细统计窗口 ─────────────────────────────────────────────────────────
let statsWin = null;

ipcMain.handle('stats:open-window', () => {
  if (statsWin && !statsWin.isDestroyed()) {
    statsWin.focus();
    return;
  }

  statsWin = new BrowserWindow({
    width: 1100,
    height: 640,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
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

// ── 独立图表窗口 ─────────────────────────────────────────────────────────
let chartWin = null;

ipcMain.handle('chart:open-window', () => {
  if (chartWin && !chartWin.isDestroyed()) {
    chartWin.focus();
    return;
  }

  chartWin = new BrowserWindow({
    width: 500,
    height: 420,
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

  chartWin.loadFile(path.join(__dirname, 'src', 'chart.html'));
  chartWin.setVisibleOnAllWorkspaces(true);

  chartWin.on('closed', () => { chartWin = null; });
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
  if (chartWin && !chartWin.isDestroyed()) {
    chartWin.webContents.send('stats-updated', stats);
  }
  if (cycleWin && !cycleWin.isDestroyed()) {
    cycleWin.webContents.send('stats-updated', stats);
  }
}

ipcMain.handle('stats:get-all', () => {
  return { matches: data.matches, stats: computeStats(), timeRange: data.timeRange || 'all' };
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

ipcMain.handle('shell:open-external', (event, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});

ipcMain.handle('app:get-version', () => {
  return require('./package.json').version;
});

// ── 时间范围过滤 ─────────────────────────────────────────────────────────
ipcMain.handle('stats:get-time-range', () => {
  return data.timeRange || 'all';
});

ipcMain.handle('stats:set-time-range', (event, range, selectedDate, customStart, customEnd) => {
  if (['all', 'today', 'week', 'month', 'custom'].includes(range)) {
    data.timeRange = range;
    data.selectedDate = selectedDate || null;
    if (range === 'custom') {
      data.customStart = customStart || null;
      data.customEnd = customEnd || null;
    } else {
      data.customStart = null;
      data.customEnd = null;
    }
    saveData();
    notifyWindows();
    return { success: true };
  }
  return { success: false, error: '无效的时间范围' };
});

ipcMain.handle('stats:get-available-dates', () => {
  const dates = new Set();
  (data.matches || []).forEach(m => {
    if (m.timestamp) {
      const d = new Date(m.timestamp);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      dates.add(key);
    }
  });
  return Array.from(dates).sort().reverse();
});

ipcMain.handle('stats:get-selected-date', () => {
  return data.selectedDate || null;
});

ipcMain.handle('stats:get-custom-range', () => {
  return { start: data.customStart || null, end: data.customEnd || null };
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

// ── 手坑预设管理 ─────────────────────────────────────────────────
ipcMain.handle('handtrap:get-all', () => {
  return (data.handtrapPresets || []);
});

ipcMain.handle('handtrap:add', (event, { id, label }) => {
  const l = (label || '').trim();
  if (!l) return { success: false, error: '名称不能为空' };
  if (!id) return { success: false, error: 'ID 不能为空' };
  if (!data.handtrapPresets) data.handtrapPresets = [];
  if (data.handtrapPresets.some(p => p.id === id)) return { success: false, error: '已存在' };
  data.handtrapPresets.push({ id, label: l });
  saveData();
  notifyWindows();
  return { success: true, presets: data.handtrapPresets };
});

ipcMain.handle('handtrap:delete', (event, id) => {
  if (!data.handtrapPresets) return { success: false };
  const idx = data.handtrapPresets.findIndex(p => p.id === id);
  if (idx === -1) return { success: false, error: '未找到' };
  data.handtrapPresets.splice(idx, 1);
  // 也从 display 配置中移除
  const cfg = data.handtrapConfig || { largeIds: [], compactIds: [] };
  cfg.largeIds = (cfg.largeIds || []).filter(x => x !== id);
  cfg.compactIds = (cfg.compactIds || []).filter(x => x !== id);
  saveData();
  notifyWindows();
  return { success: true, presets: data.handtrapPresets, config: cfg };
});

ipcMain.handle('handtrap:rename', (event, { id, newLabel }) => {
  if (!data.handtrapPresets) return { success: false };
  const idx = data.handtrapPresets.findIndex(p => p.id === id);
  if (idx === -1) return { success: false, error: '未找到' };
  const l = (newLabel || '').trim();
  if (!l) return { success: false, error: '名称不能为空' };
  data.handtrapPresets[idx].label = l;
  saveData();
  notifyWindows();
  return { success: true, presets: data.handtrapPresets };
});

ipcMain.handle('handtrap:set-display', (event, { id, display }) => {
  // display: 'large' | 'compact' | null (null=归入other)
  // 最多3个大字显示
  const MAX_LARGE = 3;
  if (!data.handtrapConfig) data.handtrapConfig = { largeIds: [], compactIds: [] };
  const cfg = data.handtrapConfig;
  // 如果要切成 large 且已达上限，拒绝
  if (display === 'large') {
    const currentLarge = (cfg.largeIds || []).filter(x => x !== id);
    if (currentLarge.length >= MAX_LARGE) {
      return { success: false, error: '大字显示最多' + MAX_LARGE + '个，请先将其他项降级' };
    }
  }
  cfg.largeIds = (cfg.largeIds || []).filter(x => x !== id);
  cfg.compactIds = (cfg.compactIds || []).filter(x => x !== id);
  if (display === 'large') cfg.largeIds.push(id);
  else if (display === 'compact') cfg.compactIds.push(id);
  saveData();
  notifyWindows();
  return { success: true, config: cfg };
});

// ── 循环显示面板配置 ────────────────────────────────────────────────
function getDefaultCycleConfig() {
  return {
    duration: 5,
    items: [
      { type: 'winRate', enabled: true, label: '总胜率' },
      { type: 'deckTrend', enabled: false, label: '特定卡组胜率', deck: '' },
      { type: 'record', enabled: true, label: '胜负记录' },
      { type: 'firstSecond', enabled: true, label: '先后手对比' },
      { type: 'streak', enabled: true, label: '连胜/连败' },
      { type: 'handtrapRate', enabled: true, label: '吃G率' },
      { type: 'coinRate', enabled: true, label: '硬币率' },
      { type: 'coinTrend', enabled: true, label: '硬币胜率趋势' },
      { type: 'coinAnomaly', enabled: true, label: '硬币异常检测' },
      { type: 'totalMatches', enabled: true, label: '总场次' },
      { type: 'opponentRan', enabled: true, label: '吓跑对手' },
      { type: 'bigHand', enabled: true, label: '遇到大牌哥' },
      { type: 'endboard', enabled: true, label: '先手终场' },
      { type: 'breakBoard', enabled: true, label: '后手突破' },
      { type: 'handState', enabled: true, label: '卡手率' },
      { type: 'mistake', enabled: true, label: '严重失误' },
      { type: 'opponentT0', enabled: true, label: '对手T0动' },
      { type: 'disconnect', enabled: true, label: '掉线统计' },
      { type: 'timeout', enabled: true, label: '超时统计' },
      { type: 'typhon', enabled: true, label: '提丰统计' },
      { type: 'deckOut', enabled: true, label: '抽干牌组' },
      { type: 'myDeckStats', enabled: true, label: '自用卡组' },
      { type: 'oppDeckStats', enabled: true, label: '对战卡组' },
      { type: 'matchupStats', enabled: true, label: '交叉统计' },
      { type: 'promotionStats', enabled: true, label: '晋级赛' },
      { type: 'relegationStats', enabled: true, label: '保级赛' }
    ]
  };
}

ipcMain.handle('cycle:get-config', () => {
  if (!data.cycleConfig) data.cycleConfig = getDefaultCycleConfig();
  return JSON.parse(JSON.stringify(data.cycleConfig));
});

ipcMain.handle('cycle:save-config', (event, config) => {
  data.cycleConfig = config;
  saveData();
  // 通知 cycle 窗口更新
  if (cycleWin && !cycleWin.isDestroyed()) {
    cycleWin.webContents.send('cycle:config-updated', config);
  }
  return { success: true };
});

// ── 循环显示面板窗口 ─────────────────────────────────────────────────
let cycleWin = null;

ipcMain.handle('cycle:open-window', () => {
  if (cycleWin && !cycleWin.isDestroyed()) {
    cycleWin.focus();
    return;
  }

  const state = loadWindowState();

  cycleWin = new BrowserWindow({
    width: state.cycleWidth || 320,
    height: state.cycleHeight || 200,
    x: state.cycleX || 500,
    y: state.cycleY || 100,
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

  cycleWin.loadFile(path.join(__dirname, 'src', 'cycle.html'));
  cycleWin.setVisibleOnAllWorkspaces(true);

  cycleWin.on('closed', () => { cycleWin = null; });

  // 保存窗口状态
  cycleWin.on('resize', () => {
    const [w, h] = cycleWin.getSize();
    const [x, y] = cycleWin.getPosition();
    saveWindowState({ cycleWidth: w, cycleHeight: h, cycleX: x, cycleY: y });
  });
  cycleWin.on('move', () => {
    const [x, y] = cycleWin.getPosition();
    const [w, h] = cycleWin.getSize();
    saveWindowState({ cycleWidth: w, cycleHeight: h, cycleX: x, cycleY: y });
  });
});

// ── 启动提示（便携版数据说明）────────────────────────────────────────
const TIP_DISMISSED_FILE = () => path.join(getRuntimeDir(), '.tip-dismissed');

function showStartupTip() {
  try {
    if (fs.existsSync(TIP_DISMISSED_FILE())) return;
  } catch(e) { return; }

  const choice = dialog.showMessageBoxSync({
    type: 'info',
    buttons: ['下次不显示', '确定'],
    defaultId: 1,
    title: 'MD_Board',
    message: '数据存储说明',
    detail: '所有对局数据默认保存在系统临时目录中。\n\n' +
      '如需备份，请使用控制面板的「导出」功能；\n' +
      '恢复数据时使用「导入」功能。'
  });
  if (choice === 0) {
    // 不再提示
    try {
      fs.writeFileSync(TIP_DISMISSED_FILE(), '', 'utf-8');
    } catch(e) {}
  }
}

// ── 应用生命周期 ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadData();
  createDisplayWindow();
  createControlWindow();
  showStartupTip();

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
