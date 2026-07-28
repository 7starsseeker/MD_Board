const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/** HTML 转义 — 防止 XSS */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 清洗单条对局数据中的字符串字段 */
function sanitizeMatchData(m) {
  const MAX_DECK_LEN = 100;
  const MAX_NOTES_LEN = 500;
  const allowedResults = ['win', 'loss', 'draw', 'abnormal'];
  const safe = { ...m };
  if (typeof safe.opponentDeck === 'string') safe.opponentDeck = safe.opponentDeck.slice(0, MAX_DECK_LEN);
  if (typeof safe.myDeck === 'string') safe.myDeck = safe.myDeck.slice(0, MAX_DECK_LEN);
  if (typeof safe.notes === 'string') safe.notes = safe.notes.slice(0, MAX_NOTES_LEN);
  if (safe.result && !allowedResults.includes(safe.result)) safe.result = 'abnormal';
  if (safe.handtraps && !Array.isArray(safe.handtraps)) safe.handtraps = [];
  return safe;
}

// ── 数据管理 ──────────────────────────────────────────────────────────────

/** 数据目录（系统临时目录） */
function getRuntimeDir() {
  return path.join(app.getPath('temp'), 'md-stats-data');
}

const RUNTIME_DATA = () => path.join(getRuntimeDir(), 'stats.json');
const RUNTIME_WSTATE = () => path.join(getRuntimeDir(), 'window-state.json');

// ── 自包含 AES-256-GCM 加密 ──────────────────────────────────────────
// 数据密钥嵌入文件自身，复制到任何机器都能解密，无需额外密钥文件。

/** 固定包装密钥（所有机器通用，仅用于保护数据密钥） */
function getWrapKey() {
  return crypto.pbkdf2Sync('md-board-enc-v1', 'md-stats-salt', 10000, 32, 'sha256');
}

/** 自包含加密：数据密钥随机生成 → 用包装密钥加密 → 与数据一同存储 */
function selfEncrypt(plaintext) {
  const wrapKey = getWrapKey();
  const dataKey = crypto.randomBytes(32);

  // 用包装密钥加密数据密钥
  const wrapIv = crypto.randomBytes(16);
  const wrapCipher = crypto.createCipheriv('aes-256-gcm', wrapKey, wrapIv);
  const encKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();

  // 用数据密钥加密数据体
  const dataIv = crypto.randomBytes(16);
  const dataCipher = crypto.createCipheriv('aes-256-gcm', dataKey, dataIv);
  const encData = Buffer.concat([dataCipher.update(plaintext, 'utf-8'), dataCipher.final()]);
  const dataTag = dataCipher.getAuthTag();

  // 文件布局: [wrapIv(16) + wrapTag(16) + encKey(32) + dataIv(16) + dataTag(16) + encData(N)]
  return Buffer.concat([wrapIv, wrapTag, encKey, dataIv, dataTag, encData]);
}

/** 自包含解密 */
function selfDecrypt(buffer) {
  const wrapKey = getWrapKey();

  const wrapIv = buffer.slice(0, 16);
  const wrapTag = buffer.slice(16, 32);
  const encKey = buffer.slice(32, 64);
  const dataIv = buffer.slice(64, 80);
  const dataTag = buffer.slice(80, 96);
  const encData = buffer.slice(96);

  const d1 = crypto.createDecipheriv('aes-256-gcm', wrapKey, wrapIv);
  d1.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([d1.update(encKey), d1.final()]);

  const d2 = crypto.createDecipheriv('aes-256-gcm', dataKey, dataIv);
  d2.setAuthTag(dataTag);
  return d2.update(encData) + d2.final('utf-8');
}

/** 兼容旧版：从密钥文件读取（迁移用） */
function readLegacyKey() {
  try {
    const keyFile = path.join(app.getPath('userData'), '.md-stats-key');
    if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile);
  } catch (e) { /* ignore */ }
  return null;
}

/** AES-256-GCM 解密（旧版密钥文件格式） */
function legacyDecrypt(encrypted, key) {
  if (!key) return encrypted.toString('utf-8');
  const iv = encrypted.slice(0, 16);
  const tag = encrypted.slice(16, 32);
  const ciphertext = encrypted.slice(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf-8');
}

let data = { matches: [], version: 4, deckPresets: [], myDeckPresets: [], handtrapPresets: [], handtrapConfig: { largeIds: [], compactIds: [] }, cycleConfig: null, timeRange: 'all', selectedDate: null, customStart: null, customEnd: null };

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 加载数据：三级回退链 — 自包含解密 → 旧密钥文件 → 明文 */
function loadData() {
  const runtimeDir = getRuntimeDir();
  ensureDir(runtimeDir);

  const runtimeFile = RUNTIME_DATA();
  try {
    if (fs.existsSync(runtimeFile)) {
      const buffer = fs.readFileSync(runtimeFile);
      let parsed;
      // 1) 自包含解密（新格式）
      try {
        const plaintext = selfDecrypt(buffer);
        parsed = JSON.parse(plaintext);
      } catch (e1) {
        // 2) 旧密钥文件解密（兼容迁移）
        try {
          const legacyKey = readLegacyKey();
          if (legacyKey) {
            const plaintext = legacyDecrypt(buffer, legacyKey);
            parsed = JSON.parse(plaintext);
          } else {
            throw new Error('no legacy key');
          }
        } catch (e2) {
          // 3) 明文读取（最旧的未加密格式）
          try {
            parsed = JSON.parse(buffer.toString('utf-8'));
          } catch (e3) {
            throw new Error('数据文件损坏，无法解析');
          }
        }
      }
      data = parsed || data;
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
    const plaintext = JSON.stringify(data, null, 2);
    const encrypted = selfEncrypt(plaintext);
    ensureDir(getRuntimeDir());
    fs.writeFileSync(RUNTIME_DATA(), encrypted);
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

/** 计算百分比 */
function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
}

/** 按 total 降序排序 entries */
function sortEntries(entries) {
  return Object.entries(entries).sort((a, b) => b[1].total > a[1].total ? 1 : -1);
}

// ── 基础统计 ──
function computeBasicStats(matches) {
  const wins = matches.filter(m => m.result === 'win').length;
  const losses = matches.filter(m => m.result === 'loss').length;
  const draws = matches.filter(m => m.result === 'draw').length;
  const abnormals = matches.filter(m => m.result === 'abnormal').length;
  const total = wins + losses + draws + abnormals;
  const playable = wins + losses;
  const normalMatches = matches.filter(m => m.result === 'win' || m.result === 'loss');
  const goingFirst = normalMatches.filter(m => m.goingFirst);
  const goingSecond = normalMatches.filter(m => !m.goingFirst);
  const gfWins = goingFirst.filter(m => m.result === 'win').length;
  const gsWins = goingSecond.filter(m => m.result === 'win').length;
  const gfAll = matches.filter(m => m.goingFirst);
  const gsAll = matches.filter(m => !m.goingFirst);
  return { wins, losses, draws, abnormals, total, playable, winRate: pct(wins, playable),
    normalMatches, goingFirst, goingSecond, gfWins, gsWins, gfAll, gsAll };
}

// ── 连胜/连败 ──
function computeStreak(matches) {
  let streakType = null, streakCount = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const r = matches[i].result;
    if (r === 'abnormal' || r === 'draw') continue;
    if (r !== 'win' && r !== 'loss') continue;
    if (streakType === null) { streakType = r; streakCount = 1; }
    else if (r === streakType) streakCount++;
    else break;
  }
  return { type: streakType, count: streakCount };
}

// ── 硬币统计 ──
function computeCoinStats(matches) {
  const arr = matches.filter(m => m.coinToss === true || m.coinToss === false);
  const wins = arr.filter(m => m.coinToss === true).length;
  const losses = arr.filter(m => m.coinToss === false).length;
  const n = arr.length;
  const coinHistory = arr.map(m => ({ coinToss: m.coinToss, result: m.result, goingFirst: m.goingFirst }));
  // 连正/连反分析
  const streak = (function() {
    if (n === 0) return { current: null, longest: 0, longestType: null, severity: '—', severityScore: 0, pValue: 1 };
    var curType = arr[0].coinToss, curLen = 1, maxLen = 1, maxType = curType;
    for (var si = 1; si < n; si++) {
      if (arr[si].coinToss === curType) { curLen++; }
      else { curType = arr[si].coinToss; curLen = 1; }
      if (curLen > maxLen) { maxLen = curLen; maxType = curType; }
    }
    var curCoin = arr[n - 1].coinToss, curStreak = 1;
    for (var si2 = n - 2; si2 >= 0; si2--) {
      if (arr[si2].coinToss === curCoin) curStreak++;
      else break;
    }
    var L = maxLen, pVal = 1;
    if (n > 0 && L > 0) { pVal = 1 - Math.exp(-n / Math.pow(2, L + 1)); if (pVal < 0) pVal = 0; }
    var expectedMax = Math.log2(n) + 0.333;
    var diff = L - expectedMax, score = Math.min(100, Math.max(0, Math.round((diff / (expectedMax > 3 ? 3 : 2)) * 100)));
    var severity = score <= 20 ? '正常' : score <= 50 ? '⚠️ 偏高' : score <= 75 ? '🔴 显著' : '🔥 异常';
    if (L <= 2) { severity = '正常'; score = 0; }
    return { current: { type: curCoin, length: curStreak }, longest: { type: maxType, length: maxLen },
      severity, severityScore: score, pValue: pVal, expectedMax: expectedMax.toFixed(1) };
  })();
  // 偏斜检测
  const bias = (function() {
    if (n < 10) return { heads: wins, tails: losses, pct: '—', zScore: 0, severity: '—', severityScore: 0 };
    var expected = n / 2, se = Math.sqrt(n) / 2, z = Math.abs(wins - expected) / se;
    var pctStr = ((wins / n) * 100).toFixed(1), score = Math.min(100, Math.round((z / 4) * 100));
    var s = score <= 20 ? '正常' : score <= 50 ? '⚠️ 偏高' : score <= 75 ? '🔴 显著' : '🔥 异常';
    return { heads: wins, tails: losses, pct: pctStr, zScore: z, severity: s, severityScore: score };
  })();
  return { total: n, wins, losses, coinHistory, winRate: pct(wins, n), streak, bias };
}

// ── 手坑统计 ──
function computeHandtrapStats(matches, total, presets, htConfig) {
  const htCounts = {}, htByFirst = {}, htBySecond = {};
  presets.forEach(p => {
    htCounts[p.id] = matches.filter(m => getMatchHandtraps(m).includes(p.id)).length;
    htByFirst[p.id] = matches.filter(m => getMatchHandtraps(m).includes(p.id) && m.goingFirst).length;
    htBySecond[p.id] = matches.filter(m => getMatchHandtraps(m).includes(p.id) && !m.goingFirst).length;
  });
  const gotOther = matches.filter(m => getMatchHandtraps(m).includes('_other')).length;
  const allPresetIds = new Set(presets.map(p => p.id));
  const deletedPresetCount = matches.filter(m =>
    getMatchHandtraps(m).some(id => id !== '_other' && !allPresetIds.has(id))
  ).length;
  htCounts['_other'] = gotOther + deletedPresetCount;
  htByFirst['_other'] = matches.filter(m => getMatchHandtraps(m).includes('_other') && m.goingFirst).length;
  htBySecond['_other'] = matches.filter(m => getMatchHandtraps(m).includes('_other') && !m.goingFirst).length;
  if (deletedPresetCount > 0) {
    htByFirst['_other'] += matches.filter(m =>
      getMatchHandtraps(m).some(id => id !== '_other' && !allPresetIds.has(id)) && m.goingFirst
    ).length;
    htBySecond['_other'] += matches.filter(m =>
      getMatchHandtraps(m).some(id => id !== '_other' && !allPresetIds.has(id)) && !m.goingFirst
    ).length;
  }
  const gotMaxxc = htCounts['gotMaxxc'] || 0, gotDroll = htCounts['gotDroll'] || 0;
  const gotJellyfish = htCounts['gotJellyfish'] || 0, gotLancea = htCounts['gotLancea'] || 0;
  const gotNibiru = htCounts['gotNibiru'] || 0, gotDimension = htCounts['gotDimension'] || 0;
  const gotSmallHT = gotOther;
  const gotAnyG = matches.filter(m => getMatchHandtraps(m).some(id => ['gotMaxxc','gotDroll','gotJellyfish'].includes(id))).length;
  const anyGFirst = matches.filter(m => getMatchHandtraps(m).some(id => ['gotMaxxc','gotDroll','gotJellyfish'].includes(id)) && m.goingFirst).length;
  const anyGSecond = matches.filter(m => getMatchHandtraps(m).some(id => ['gotMaxxc','gotDroll','gotJellyfish'].includes(id)) && !m.goingFirst).length;
  return {
    total: gotMaxxc + gotDroll + gotJellyfish + gotLancea + gotNibiru + gotDimension + gotSmallHT,
    gotMaxxc, gotDroll, gotJellyfish, gotLancea, gotNibiru, gotDimension, gotSmallHT, gotAnyG,
    maxxcRate: pct(gotMaxxc, total), anyGRate: pct(gotAnyG, total), nibiruRate: pct(gotNibiru, total),
    byFirst: { gotMaxxc: htByFirst['gotMaxxc']||0, gotDroll: htByFirst['gotDroll']||0, gotJellyfish: htByFirst['gotJellyfish']||0, gotLancea: htByFirst['gotLancea']||0, gotNibiru: htByFirst['gotNibiru']||0, gotDimension: htByFirst['gotDimension']||0, gotSmallHT: htByFirst['_other']||0, gotAnyG: anyGFirst },
    bySecond: { gotMaxxc: htBySecond['gotMaxxc']||0, gotDroll: htBySecond['gotDroll']||0, gotJellyfish: htBySecond['gotJellyfish']||0, gotLancea: htBySecond['gotLancea']||0, gotNibiru: htBySecond['gotNibiru']||0, gotDimension: htBySecond['gotDimension']||0, gotSmallHT: htBySecond['_other']||0, gotAnyG: anyGSecond },
    presets, config: htConfig, counts: htCounts, byFirstAll: htByFirst, bySecondAll: htBySecond
  };
}

// ── 卡手统计 ──
function computeHandStateStats(matches, total, gfTotal, gsTotal) {
  const cantPlayAlone = matches.filter(m => m.cantPlay).length;
  const cantPlayGarnet = matches.filter(m => m.cantPlayGarnet).length;
  const cantPlayDuplicate = matches.filter(m => m.cantPlayDuplicate).length;
  const cantPlayHT = matches.filter(m => m.cantPlayHT).length;
  const bothStuck = matches.filter(m => m.bothStuck).length;
  const totalCantPlay = matches.filter(m => m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck).length;
  // 先后手
  const byFirst = {
    cantPlay: matches.filter(m => (m.cantPlay || m.bothStuck) && m.goingFirst).length,
    cantPlayGarnet: matches.filter(m => m.cantPlayGarnet && m.goingFirst).length,
    cantPlayDuplicate: matches.filter(m => m.cantPlayDuplicate && m.goingFirst).length,
    cantPlayHT: matches.filter(m => m.cantPlayHT && m.goingFirst).length,
    bothStuck: matches.filter(m => m.bothStuck && m.goingFirst).length,
    totalCantPlay: matches.filter(m => (m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck) && m.goingFirst).length
  };
  const bySecond = {
    cantPlay: matches.filter(m => (m.cantPlay || m.bothStuck) && !m.goingFirst).length,
    cantPlayGarnet: matches.filter(m => m.cantPlayGarnet && !m.goingFirst).length,
    cantPlayDuplicate: matches.filter(m => m.cantPlayDuplicate && !m.goingFirst).length,
    cantPlayHT: matches.filter(m => m.cantPlayHT && !m.goingFirst).length,
    bothStuck: matches.filter(m => m.bothStuck && !m.goingFirst).length,
    totalCantPlay: matches.filter(m => (m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck) && !m.goingFirst).length
  };
  // 互卡子选项
  const bsMatches = matches.filter(m => m.bothStuck);
  const bsFirstMove = bsMatches.filter(m => m.firstMover === 'move' || m.firstMover === 'self' || m.firstMover === 'opponent').length;
  const bsFirstMoveSelf = bsMatches.filter(m => (m.firstMover === 'move' && m.moverWho === 'self') || m.firstMover === 'self').length;
  const bsFirstMoveOpp = bsMatches.filter(m => (m.firstMover === 'move' && m.moverWho === 'opponent') || m.firstMover === 'opponent').length;
  const bsSurrender = bsMatches.filter(m => m.firstMover === 'surrender').length;
  const bsSurrenderSelf = bsMatches.filter(m => m.firstMover === 'surrender' && m.surrenderWho === 'self').length;
  const bsSurrenderOpp = bsMatches.filter(m => m.firstMover === 'surrender' && m.surrenderWho === 'opponent').length;
  const bsOther = bsMatches.filter(m => m.firstMover === 'other' || !m.firstMover).length;
  // 各卡组
  const byDeck = {};
  matches.forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!byDeck[deck]) byDeck[deck] = { total: 0, wins: 0, losses: 0, cantPlayCount: 0, cantPlayAlone: 0, cantPlayGarnetCount: 0, cantPlayDuplicateCount: 0, cantPlayHTCount: 0, bothStuckCount: 0 };
    byDeck[deck].total++;
    if (m.result === 'win') byDeck[deck].wins++;
    else if (m.result === 'loss') byDeck[deck].losses++;
    if (m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck) byDeck[deck].cantPlayCount++;
    if (m.cantPlay) byDeck[deck].cantPlayAlone++;
    if (m.cantPlayGarnet) byDeck[deck].cantPlayGarnetCount++;
    if (m.cantPlayDuplicate) byDeck[deck].cantPlayDuplicateCount++;
    if (m.cantPlayHT) byDeck[deck].cantPlayHTCount++;
    if (m.bothStuck) byDeck[deck].bothStuckCount++;
  });
  return {
    cantPlay: cantPlayAlone, cantPlayGarnet, cantPlayDuplicate, cantPlayHT,
    totalCantPlay, cantPlayRate: pct(totalCantPlay, total),
    bothStuck, bothStuckRate: pct(bothStuck, total),
    gfTotal, gsTotal, byFirst, bySecond,
    bothStuckDetail: { total: bothStuck, firstMove: bsFirstMove, firstMoveSelf: bsFirstMoveSelf, firstMoveOpp: bsFirstMoveOpp, surrender: bsSurrender, surrenderSelf: bsSurrenderSelf, surrenderOpp: bsSurrenderOpp, other: bsOther },
    byDeck: Object.entries(byDeck).sort((a, b) => b[1].total - a[1].total).map(([deck, s]) => ({ deck, ...s, cantPlayRate: pct(s.cantPlayCount, s.total), winRate: pct(s.wins, s.wins + s.losses) }))
  };
}

// ── 连接状态（掉线/超时）──
function computeConnectivityStats(matches, total) {
  const disconnect = matches.filter(m => m.disconnect).length;
  const disconnectSelf = matches.filter(m => m.disconnect && m.disconnectWho === 'self').length;
  const disconnectOpponent = matches.filter(m => m.disconnect && m.disconnectWho === 'opponent').length;
  const timeout = matches.filter(m => m.timeout).length;
  const timeoutSelf = matches.filter(m => m.timeout && m.timeoutWho === 'self').length;
  const timeoutOpponent = matches.filter(m => m.timeout && m.timeoutWho === 'opponent').length;
  const toMap = (filterFn, deckField) => {
    const m = {};
    matches.filter(filterFn).forEach(mt => {
      const d = (mt[deckField] || '').trim();
      if (!d) return;
      if (!m[d]) m[d] = 0;
      m[d]++;
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([deck, count]) => ({ deck, count }));
  };
  return {
    disconnect, disconnectSelf, disconnectOpponent, disconnectRate: pct(disconnect, total),
    timeout, timeoutSelf, timeoutOpponent, timeoutRate: pct(timeout, total),
    timeoutSelfByDeck: toMap(m => m.timeout && m.timeoutWho === 'self', 'myDeck'),
    timeoutOppByDeck: toMap(m => m.timeout && m.timeoutWho === 'opponent', 'opponentDeck')
  };
}

// ── 先手终场 ──
function computeEndboardStats(firstMatches) {
  const normal = firstMatches.filter(m => m.endboardState === 'normal').length;
  const compromised = firstMatches.filter(m => m.endboardState === 'compromised').length;
  const opponentDirectWin = m =>
    m.endboardState === 'stopped' && (m.opponentRan || (m.disconnect && m.disconnectWho === 'opponent') || (m.timeout && m.timeoutWho === 'opponent') || (m.deckOut && m.deckOutWho === 'opponent'));
  const trueStopped = firstMatches.filter(m => m.endboardState === 'stopped' && !opponentDirectWin(m)).length;
  const opponentSurrendered = firstMatches.filter(m => opponentDirectWin(m)).length;
  const surrender = firstMatches.filter(m => m.endboardState === 'surrender').length;
  return { total: firstMatches.length, normal, compromised, stopped: trueStopped, surrender, opponentSurrendered, normalRate: pct(normal, firstMatches.length) };
}

// ── 后手突破 ──
function computeBreakBoardStats(secondMatches) {
  const yes = secondMatches.filter(m => m.brokeBoard === true || m.brokeBoard === 'true').length;
  const no = secondMatches.filter(m => m.brokeBoard === false || m.brokeBoard === 'false').length;
  const surrender = secondMatches.filter(m => m.brokeBoard === 'surrender').length;
  const notNeeded = secondMatches.filter(m => m.brokeBoard === 'not_applicable').length;
  const successWins = secondMatches.filter(m => (m.brokeBoard === true || m.brokeBoard === 'true') && m.result === 'win').length;
  return { total: secondMatches.length, success: yes, failed: no, surrender, notNeeded, successWins, successRate: pct(yes, secondMatches.length), successWinRate: pct(successWins, yes) };
}

// ── 吓跑对手 ──
function computeOpponentRanStats(matches) {
  const ranMatches = matches.filter(m => m.opponentRan);
  const byDeck = {};
  ranMatches.forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!byDeck[deck]) byDeck[deck] = 0;
    byDeck[deck]++;
  });
  const first = ranMatches.filter(m => m.goingFirst);
  const second = ranMatches.filter(m => !m.goingFirst);
  const firstEndboard = {
    normal: first.filter(m => m.endboardState === 'normal').length,
    compromised: first.filter(m => m.endboardState === 'compromised').length,
    stopped: first.filter(m => m.endboardState === 'stopped').length,
    other: first.filter(m => m.endboardState && !['normal','compromised','stopped'].includes(m.endboardState)).length,
    noEndboard: first.filter(m => !m.endboardState).length
  };
  const secondBroke = {
    notNeeded: second.filter(m => m.brokeBoard === 'not_applicable').length,
    success: second.filter(m => m.brokeBoard === true || m.brokeBoard === 'true').length,
    failed: second.filter(m => m.brokeBoard === false || m.brokeBoard === 'false').length,
    other: second.filter(m => m.brokeBoard && ![true,'true',false,'false','not_applicable'].includes(m.brokeBoard)).length,
    noBroke: second.filter(m => !m.brokeBoard).length
  };
  return {
    total: ranMatches.length, rate: pct(ranMatches.length, matches.length),
    byDeck: Object.entries(byDeck).sort((a, b) => b[1] - a[1]).map(([deck, count]) => ({ deck, count })),
    firstTotal: first.length, firstEndboard, secondTotal: second.length, secondBroke
  };
}

// ── 严重失误 ──
function computeMistakeStats(matches, total) {
  const mMatches = matches.filter(m => m.mistake);
  const wins = mMatches.filter(m => m.result === 'win').length;
  const losses = mMatches.filter(m => m.result === 'loss').length;
  const byDeck = {};
  mMatches.forEach(m => {
    const deck = (m.myDeck || '').trim();
    if (!deck) return;
    if (!byDeck[deck]) byDeck[deck] = { total: 0, wins: 0, losses: 0 };
    byDeck[deck].total++;
    if (m.result === 'win') byDeck[deck].wins++;
    else if (m.result === 'loss') byDeck[deck].losses++;
  });
  return {
    total: mMatches.length, rate: pct(mMatches.length, total), wins, losses, winRate: pct(wins, wins + losses),
    byDeck: Object.entries(byDeck).sort((a, b) => b[1].total - a[1].total).map(([deck, s]) => ({ deck, ...s, winRate: pct(s.wins, s.wins + s.losses) }))
  };
}

// ── 对手 T0 ──
function computeOpponentT0Stats(matches) {
  const t0 = matches.filter(m => m.opponentT0);
  const wins = t0.filter(m => m.result === 'win').length;
  const losses = t0.filter(m => m.result === 'loss').length;
  const byDeck = {};
  t0.forEach(m => {
    const deck = (m.opponentDeck || '').trim();
    if (!deck || deck === '未知') return;
    if (!byDeck[deck]) byDeck[deck] = { total: 0, wins: 0, losses: 0 };
    byDeck[deck].total++;
    if (m.result === 'win') byDeck[deck].wins++;
    else if (m.result === 'loss') byDeck[deck].losses++;
  });
  return {
    total: t0.length, wins, losses, winRate: pct(wins, wins + losses),
    byDeck: Object.entries(byDeck).sort((a, b) => b[1].total - a[1].total).map(([deck, s]) => ({ deck, ...s, winRate: pct(s.wins, s.wins + s.losses) }))
  };
}

// ── 卡组统计（通用：自用/对手）──
function computeDeckGroupStats(matches, field) {
  const m = {};
  matches.filter(mt => mt[field]).forEach(mt => {
    const d = mt[field].trim();
    if (!d) return;
    if (!m[d]) m[d] = { wins: 0, losses: 0, draws: 0, abnormals: 0, total: 0 };
    m[d].total++;
    if (mt.result === 'win') m[d].wins++;
    else if (mt.result === 'loss') m[d].losses++;
    else if (mt.result === 'draw') m[d].draws++;
    else if (mt.result === 'abnormal') m[d].abnormals++;
  });
  return Object.entries(m).sort((a, b) => b[1].total - a[1].total).map(([deck, s]) => ({ deck, ...s, winRate: pct(s.wins, s.wins + s.losses) }));
}

// ── 二维交叉统计 ──
function computeMatchupStats(matches) {
  const m = {};
  matches.forEach(mt => {
    const myDeck = (mt.myDeck || '').trim();
    const oppDeck = (mt.opponentDeck || '').trim();
    if (!myDeck || !oppDeck) return;
    const key = myDeck + ' ⚔️ ' + oppDeck;
    if (!m[key]) m[key] = { myDeck, opponentDeck: oppDeck, wins: 0, losses: 0, draws: 0, abnormals: 0, total: 0 };
    m[key].total++;
    if (mt.result === 'win') m[key].wins++;
    else if (mt.result === 'loss') m[key].losses++;
    else if (mt.result === 'draw') m[key].draws++;
    else if (mt.result === 'abnormal') m[key].abnormals++;
  });
  return Object.values(m).sort((a, b) => b.total - a.total).map(s => ({ ...s, winRate: pct(s.wins, s.wins + s.losses) }));
}

// ── 晋级/保级赛统计 ──
function computeTypeStats(typeMatches) {
  const tWins = typeMatches.filter(m => m.result === 'win').length;
  const tLosses = typeMatches.filter(m => m.result === 'loss').length;
  const tTotal = tWins + tLosses;
  if (tTotal === 0) return null;
  const tCoin = typeMatches.filter(m => m.coinToss === true || m.coinToss === false);
  const tCoinWins = tCoin.filter(m => m.coinToss === true).length;
  const tFirst = typeMatches.filter(m => m.goingFirst);
  const tFirstWins = tFirst.filter(m => m.result === 'win').length;
  const tSecond = typeMatches.filter(m => !m.goingFirst);
  const tSecondWins = tSecond.filter(m => m.result === 'win').length;
  const tHTMatches = typeMatches.map(m => getMatchHandtraps(m));
  const tMaxxc = tHTMatches.filter(h => h.includes('gotMaxxc')).length;
  const tDroll = tHTMatches.filter(h => h.includes('gotDroll')).length;
  const tJellyfish = tHTMatches.filter(h => h.includes('gotJellyfish')).length;
  const tLancea = tHTMatches.filter(h => h.includes('gotLancea')).length;
  const tNibiru = tHTMatches.filter(h => h.includes('gotNibiru')).length;
  const tDimension = tHTMatches.filter(h => h.includes('gotDimension')).length;
  const tSmallHT = tHTMatches.filter(h => h.includes('_other')).length;
  const tAnyG = tHTMatches.filter(h => h.includes('gotMaxxc') || h.includes('gotDroll') || h.includes('gotJellyfish')).length;
  const tCantPlay = typeMatches.filter(m => m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck).length;
  const tBigHand = typeMatches.filter(m => m.opponentBigHand).length;
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
  const counts = {};
  (data.handtrapPresets || []).forEach(p => { counts[p.id] = tHTMatches.filter(h => h.includes(p.id)).length; });
  counts['_other'] = tSmallHT;
  return {
    total: tTotal, wins: tWins, losses: tLosses, winRate: pct(tWins, tTotal),
    coinWinRate: pct(tCoinWins, tCoin.length), firstWinRate: pct(tFirstWins, tFirst.length),
    secondWinRate: pct(tSecondWins, tSecond.length),
    handtrap: { gotMaxxc: tMaxxc, gotDroll: tDroll, gotJellyfish: tJellyfish, gotLancea: tLancea, gotNibiru: tNibiru, gotDimension: tDimension, gotSmallHT: tSmallHT, gotAnyG: tAnyG, presets: data.handtrapPresets || [], counts },
    cantPlayRate: pct(tCantPlay, tTotal), bigHandRate: pct(tBigHand, tTotal),
    oppDecks: Object.entries(tOppDecks).sort((a, b) => b[1].total - a[1].total).map(([d, s]) => ({ deck: d, ...s, winRate: pct(s.wins, s.wins + s.losses) }))
  };
}

/** 主统计函数 — 编排所有子函数 */
function computeStats() {
  const allMatches = data.matches || [];
  const timeRange = data.timeRange || 'all';
  const matches = filterMatchesByTimeRange(allMatches, timeRange);

  const basic = computeBasicStats(matches);
  const { total, wins, losses, draws, abnormals, winRate, gfAll, gsAll } = basic;

  const gfWins = basic.goingFirst.filter(m => m.result === 'win').length;
  const gsWins = basic.goingSecond.filter(m => m.result === 'win').length;

  const coin = computeCoinStats(matches);

  const last10 = matches.slice(-10).map(m => ({
    result: m.result, goingFirst: m.goingFirst, opponentDeck: m.opponentDeck || '', coinToss: m.coinToss
  }));

  const handtrap = computeHandtrapStats(matches, total, data.handtrapPresets || [], data.handtrapConfig || {});
  const handState = computeHandStateStats(matches, total, gfAll.length, gsAll.length);
  const connectivity = computeConnectivityStats(matches, total);

  const bigHandTotal = matches.filter(m => m.opponentBigHand).length;
  const bigHandFirst = matches.filter(m => m.opponentBigHand && m.goingFirst).length;
  const bigHandSecond = matches.filter(m => m.opponentBigHand && !m.goingFirst).length;

  const typhonMatches = matches.filter(m => m.typhonAppeared);
  const deckOutMatches = matches.filter(m => m.deckOut);

  const resultHistory = matches.map(m => m.result);
  const deckResults = {};
  matches.forEach(m => {
    const d = m.myDeck;
    if (d && (m.result === 'win' || m.result === 'loss')) {
      if (!deckResults[d]) deckResults[d] = [];
      deckResults[d].push(m.result);
    }
  });

  return {
    total, wins, losses, draws, abnormals, winRate,
    coin: { ...coin, coinHistory: coin.coinHistory },
    coinHistory: coin.coinHistory,
    resultHistory, deckResults,
    goingFirst: {
      total: basic.goingFirst.length, wins: gfWins,
      losses: basic.goingFirst.length - gfWins,
      draws: gfAll.filter(m => m.result === 'draw').length,
      abnormals: gfAll.filter(m => m.result === 'abnormal').length,
      winRate: pct(gfWins, basic.goingFirst.length)
    },
    goingSecond: {
      total: basic.goingSecond.length, wins: gsWins,
      losses: basic.goingSecond.length - gsWins,
      draws: gsAll.filter(m => m.result === 'draw').length,
      abnormals: gsAll.filter(m => m.result === 'abnormal').length,
      winRate: pct(gsWins, basic.goingSecond.length)
    },
    currentStreak: computeStreak(matches),
    last10, handtrap, handState, connectivity,
    bigHand: { total: bigHandTotal, first: bigHandFirst, second: bigHandSecond },
    opponentT0: computeOpponentT0Stats(matches),
    endboard: computeEndboardStats(gfAll),
    breakBoard: computeBreakBoardStats(gsAll),
    myDeckStats: computeDeckGroupStats(matches, 'myDeck'),
    deckStats: computeDeckGroupStats(matches, 'opponentDeck'),
    mistake: computeMistakeStats(matches, total),
    opponentRan: computeOpponentRanStats(matches),
    typhon: {
      total: typhonMatches.length,
      enemyBlack: typhonMatches.filter(m => m.typhonWho === 'opponent' && m.result === 'win').length,
      enemyWhite: typhonMatches.filter(m => m.typhonWho === 'opponent' && m.result === 'loss').length,
      selfBlack: typhonMatches.filter(m => m.typhonWho === 'self' && m.result === 'loss').length,
      selfWhite: typhonMatches.filter(m => m.typhonWho === 'self' && m.result === 'win').length
    },
    deckOut: {
      total: deckOutMatches.length,
      self: deckOutMatches.filter(m => m.deckOutWho === 'self').length,
      opponent: deckOutMatches.filter(m => m.deckOutWho === 'opponent').length,
      selfWins: deckOutMatches.filter(m => m.deckOutWho === 'self' && m.result === 'win').length
    },
    matchupStats: computeMatchupStats(matches),
    rankedStats: {
      promotion: computeTypeStats(matches.filter(m => m.matchType === 'promotion')),
      relegation: computeTypeStats(matches.filter(m => m.matchType === 'relegation'))
    }
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
  const cleaned = sanitizeMatchData(matchData || {});
  const match = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...cleaned
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

// ── 导出 Markdown 统计报告 ──────────────────────────────────────
ipcMain.handle('stats:export-md', async (event, { timeRange, selectedDate, customStart, customEnd, timeLabel }) => {
  const stats = computeStats();
  const matches = filterMatchesByTimeRange(data.matches || [], data.timeRange || 'all');

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const genTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  let md = '';
  md += '# MD Stats 统计报告\n\n';
  md += `**生成时间**: ${genTime}\n`;
  md += `**数据范围**: ${timeLabel || '全部'}\n\n`;

  // ── 时间范围说明 ──
  if (timeRange === 'custom' && customStart && customEnd) {
    md += `自定义时间范围: ${customStart} ~ ${customEnd}\n\n`;
  } else if (timeRange === 'today' && selectedDate) {
    md += `日期: ${selectedDate}\n\n`;
  }

  // ── 概览 ──
  const b = stats;
  md += '---\n\n';
  md += '## 📊 概览\n\n';
  md += `| 指标 | 数值 |\n| --- | --- |\n`;
  md += `| 总对局 | ${b.total} |\n`;
  md += `| 胜 | ${b.wins} |\n`;
  md += `| 负 | ${b.losses} |\n`;
  md += `| 平 | ${b.draws} |\n`;
  md += `| 异常 | ${b.abnormals} |\n`;
  md += `| **胜率** | **${b.winRate}%** |\n`;
  md += '\n';

  // ── 连胜/连败 ──
  const streak = stats.currentStreak;
  if (streak.count > 1) {
    const streakEmoji = streak.type === 'win' ? '🔥' : '💧';
    const streakLabel = streak.type === 'win' ? '连胜' : '连败';
    md += `**当前状态**: ${streakEmoji} ${streakLabel} ${streak.count}\n\n`;
  }
  md += '> **算法**: 总对局 = 胜+负+平+异常; 胜率 = 胜/(胜+负)*100%; 连胜/连败 = 从最新对局向前扫描, 跳过平局/异常, 连续同结果次数\n\n';

  // ── 先后手 ──
  md += '---\n\n';
  md += '## ⚔️ 先后手对比\n\n';
  md += `| 项目 | 场次 | 胜率 |\n| --- | --- | --- |\n`;
  md += `| 先手 | ${stats.goingFirst.total} | ${stats.goingFirst.winRate}% |\n`;
  md += `| 后手 | ${stats.goingSecond.total} | ${stats.goingSecond.winRate}% |\n`;
  md += '\n';
  md += '> **算法**: 先手/后手 = 筛选 goingFirst 为 true/false 的正常对局; 先手胜率 = 先手胜/(先手胜+先手负)*100%; 后手同理\n\n';

  // ── 硬币统计 ──
  if (stats.coin) {
    md += '---\n\n';
    md += '## 🪙 硬币统计\n\n';
    const c = stats.coin;
    md += `| 项目 | 数值 |\n| --- | --- |\n`;
    md += `| 总投币 | ${c.total} |\n`;
    md += `| 正（先手） | ${c.wins} (${c.winRate}%) |\n`;
    md += `| 反（后手） | ${c.losses} |\n`;
    if (c.streak && c.streak.current) {
      const cur = c.streak.current;
      const ctLabel = cur.type === true ? '连正' : '连反';
      md += `| 当前${ctLabel} | ${cur.length} |\n`;
    }
    if (c.bias && c.bias.severity !== '—') {
      md += `| 偏斜检测 | ${c.bias.severity} (分数: ${c.bias.severityScore}) |\n`;
    }
    md += '\n';
  }
  md += '> **算法**: 正=投币赢且先手; 反=投币输且后手。连正/连反分析从最近对局倒序扫描; 偏斜用 Z 检验 (|观察-预期|/标准误), 严重度：分数≤20正常/≤50⚠️/≤75🔴/>75🔥。期望最大连正=log₂(n)+0.333\n\n';

  // ── 手坑统计 ──
  md += '---\n\n';
  md += '## 🛡️ 吃手坑统计\n\n';
  const ht = stats.handtrap;
  md += `| 手坑 | 次数 | 占比 |\n| --- | --- | --- |\n`;
  md += `| G | ${ht.gotMaxxc} | ${ht.maxxcRate}% |\n`;
  md += `| 任一 G | ${ht.gotAnyG} | ${ht.anyGRate}% |\n`;
  md += `| 锁鸟 | ${ht.gotDroll} | -\n`;
  md += `| 水母 | ${ht.gotJellyfish} | -\n`;
  md += `| 渊兽 | ${ht.gotLancea} | -\n`;
  md += `| 陨石 | ${ht.gotNibiru} | ${ht.nibiruRate}% |\n`;
  md += `| 次元 | ${ht.gotDimension} | -\n`;
  md += `| 小手坑 | ${ht.gotSmallHT} | -\n`;
  if (ht.presets && ht.presets.length > 0) {
    ht.presets.forEach(function(p) {
      const cnt = (ht.counts && ht.counts[p.id]) || 0;
      if (cnt > 0) {
        md += `| ${p.label} | ${cnt} | -\n`;
      }
    });
  }
  md += '\n';
  md += '> **算法**: 逐场提取 handtraps 数组, 按 ID 统计出现次数除以总对局数得占比。gotAnyG = 含 G/锁鸟/水母任一的场次\n\n';

  // ── 手牌与卡手统计 ──
  md += '---\n\n';
  md += '## 🃏 手牌与卡手统计\n\n';
  const hs = stats.handState;
  md += `| 类型 | 次数 | 占比 |\n| --- | --- | --- |\n`;
  md += `| 卡手合计 | ${hs.totalCantPlay} | ${hs.cantPlayRate}% |\n`;
  md += `| 动不了 | ${hs.cantPlay} | -\n`;
  md += `| 卡组件 | ${hs.cantPlayGarnet} | -\n`;
  md += `| 卡复数 | ${hs.cantPlayDuplicate} | -\n`;
  md += `| 卡手坑 | ${hs.cantPlayHT} | -\n`;
  md += `| 互卡 | ${hs.bothStuck} | ${hs.bothStuckRate}% |\n`;

  // 先后手卡手
  md += '\n**先后手卡手**:\n\n';
  md += `| 项目 | 先手 | 后手 |\n| --- | --- | --- |\n`;
  md += `| 动不了 | ${hs.byFirst.cantPlay} | ${hs.bySecond.cantPlay} |\n`;
  md += `| 卡组件 | ${hs.byFirst.cantPlayGarnet} | ${hs.bySecond.cantPlayGarnet} |\n`;
  md += `| 卡复数 | ${hs.byFirst.cantPlayDuplicate} | ${hs.bySecond.cantPlayDuplicate} |\n`;
  md += `| 卡手坑 | ${hs.byFirst.cantPlayHT} | ${hs.bySecond.cantPlayHT} |\n`;
  md += `| 互卡 | ${hs.byFirst.bothStuck} | ${hs.bySecond.bothStuck} |\n`;

  md += '> **算法**: 各类型卡手标记位统计; 卡手率 = 任一类卡手对局数/总对局*100%。byDeck 按自用卡组分组\n\n';

  // 互卡子选项详情
  if (hs.bothStuck > 0) {
    const bsd = hs.bothStuckDetail;
    md += '\n**互卡子选项详情**:\n\n';
    md += `| 类型 | 次数 |\n| --- | --- |\n`;
    md += `| 有人先动 | ${bsd.firstMove} |\n`;
    if (bsd.firstMove > 0) {
      md += `|　ー 自己先动 | ${bsd.firstMoveSelf} |\n`;
      md += `|　ー 对手先动 | ${bsd.firstMoveOpp} |\n`;
    }
    md += `| 有人投降 | ${bsd.surrender} |\n`;
    if (bsd.surrender > 0) {
      md += `|　ー 自己投降 | ${bsd.surrenderSelf} |\n`;
      md += `|　ー 对手投降 | ${bsd.surrenderOpp} |\n`;
    }
    md += `| 其他 | ${bsd.other} |\n`;
  }
  md += '\n';

  // ── 严重失误 ──
  if (stats.mistake && stats.mistake.total > 0) {
    md += '---\n\n';
    md += '## 💢 严重失误统计\n\n';
    const m = stats.mistake;
    md += `| 项目 | 数值 |\n| --- | --- |\n`;
    md += `| 失误总次数 | ${m.total} (${m.rate}%) |\n`;
    md += `| 失误时胜率 | ${m.winRate}% (${m.wins}W ${m.losses}L) |\n`;
    if (m.byDeck && m.byDeck.length > 0) {
      md += '\n**各卡组失误分布**:\n\n';
      md += `| 卡组 | 失误 | 胜率 |\n| --- | --- | --- |\n`;
      m.byDeck.forEach(function(d) {
        md += `| ${d.deck} | ${d.total} | ${d.winRate}% |\n`;
      });
    }
    md += '\n';
  }
  md += '> **算法**: 失误率 = mistake 标记对局数/总对局*100%; 失误时胜率 = 有失误对局中胜/(胜+负)*100%; 按 myDeck 分组计数\n\n';

  // ── 吓跑对手 ──
  if (stats.opponentRan && stats.opponentRan.total > 0) {
    md += '---\n\n';
    md += '## 🏃 吓跑对手情况\n\n';
    const r = stats.opponentRan;
    md += `| 项目 | 次数 |\n| --- | --- |\n`;
    md += `| 合计 | ${r.total} (${r.rate}%) |\n`;
    md += `| 先手吓跑 | ${r.firstTotal} |\n`;
    md += `| 后手吓跑 | ${r.secondTotal} |\n`;
    if (r.byDeck && r.byDeck.length > 0) {
      md += '\n**吓跑分布**:\n';
      r.byDeck.forEach(function(d) { md += `- ${d.deck}: ${d.count}\n`; });
    }
    md += '\n';
  }
  md += '> **算法**: 吓跑率 = opponentRan 标记对局数/总对局*100%; 区分先手终场阶段(正常/妥协/被停/其他)和后手突破阶段(无需/成功/失败/其他)\n\n';

  // ── 对手 T0 ──
  if (stats.opponentT0 && stats.opponentT0.total > 0) {
    md += '---\n\n';
    md += '## ⚡ 对手 T0 动统计\n\n';
    const t0 = stats.opponentT0;
    md += `| 项目 | 数值 |\n| --- | --- |\n`;
    md += `| 总次数 | ${t0.total} |\n`;
    md += `| 胜率 | ${t0.winRate}% (${t0.wins}W ${t0.losses}L) |\n`;
    if (t0.byDeck && t0.byDeck.length > 0) {
      t0.byDeck.forEach(function(d) {
        md += `| 对手 ${d.deck} | ${d.total} | ${d.winRate}% |\n`;
      });
    }
    md += '\n';
  }
  md += '> **算法**: 对手 T0 = opponentT0 标记对局; 按对手卡组分组的胜率\n\n';

  // ── 先手终场 ──
  if (stats.endboard && stats.endboard.total > 0) {
    md += '---\n\n';
    md += '## 🏗️ 先手终场统计\n\n';
    const eb = stats.endboard;
    md += `| 终场质量 | 次数 | 占比 |\n| --- | --- | --- |\n`;
    md += `| 正常展开 | ${eb.normal} | ${eb.normalRate}% |\n`;
    md += `| 妥协场 | ${eb.compromised} | -\n`;
    md += `| 被停 | ${eb.stopped} | -\n`;
    md += `| 直接投降 | ${eb.surrender} | -\n`;
    md += `| 对手投 | ${eb.opponentSurrendered} | -\n`;
    md += '\n';
  }
  md += '> **算法**: 正常展开率 = endboardState="normal"/先手总场*100%; 妥协/被停/投降/对手投各计数\n\n';

  // ── 后手突破 ──
  if (stats.breakBoard && stats.breakBoard.total > 0) {
    md += '---\n\n';
    md += '## 🔨 后手突破统计\n\n';
    const bb = stats.breakBoard;
    md += `| 项目 | 次数 | 占比 |\n| --- | --- | --- |\n`;
    md += `| 成功突破 | ${bb.success} | ${bb.successRate}% |\n`;
    md += `| 突破失败 | ${bb.failed} | -\n`;
    md += `| 投降 | ${bb.surrender} | -\n`;
    md += `| 无需突破 | ${bb.notNeeded} | -\n`;
    md += `| 突破后胜率 | ${bb.successWinRate}% | -\n`;
    md += '\n';
  }
  md += '> **算法**: 突破成功率 = brokeBoard=true/后手总场*100%; 突破后胜率 = 突破成功且获胜/突破成功总场*100%\n\n';

  // ── 连接状态 ──
  md += '---\n\n';
  md += '## 📡 连接状态统计\n\n';
  const conn = stats.connectivity;
  md += `| 项目 | 次数 | 占比 |\n| --- | --- | --- |\n`;
  md += `| 掉线 | ${conn.disconnect} | ${conn.disconnectRate}% |\n`;
  md += `|　ー 自己掉线 | ${conn.disconnectSelf} | -\n`;
  md += `|　ー 对手掉线 | ${conn.disconnectOpponent} | -\n`;
  md += `| 超时 | ${conn.timeout} | ${conn.timeoutRate}% |\n`;
  md += `|　ー 己方超时 | ${conn.timeoutSelf} | -\n`;
  md += `|　ー 对手超时 | ${conn.timeoutOpponent} | -\n`;
  md += '\n';
  md += '> **算法**: 掉线/超时分别统计 disconnect/timeout 标记; 区分己方(disconnectWho/timeoutWho="self")和对方("opponent")\n\n';

  // ── 大牌/提丰/抽干 ──
  md += '---\n\n';
  md += '## 🃏 其他统计\n\n';

  md += `**对手大牌**: ${stats.bigHand.total} 次（先手 ${stats.bigHand.first} / 后手 ${stats.bigHand.second}）\n\n`;

  if (stats.typhon && stats.typhon.total > 0) {
    const t = stats.typhon;
    md += `**提丰登场**: ${t.total} 次\n`;
    md += `- 对手出提丰输了: ${t.enemyBlack} 次\n`;
    md += `- 对手出提丰赢了: ${t.enemyWhite} 次\n`;
    md += `- 自己出提丰输了: ${t.selfBlack} 次\n`;
    md += `- 自己出提丰赢了: ${t.selfWhite} 次\n\n`;
  }

  if (stats.deckOut && stats.deckOut.total > 0) {
    const d = stats.deckOut;
    md += `**抽干牌组**: ${d.total} 次（自己 ${d.self} / 对手 ${d.opponent}）\n\n`;
  }
  md += '> **算法**: 大牌=opponentBigHand; 提丰=typhonAppeared; 抽干=deckOut。分别统计次数, 提丰+抽干区分己方/对方\n\n';

  // ── 自用卡组统计 ──
  if (stats.myDeckStats && stats.myDeckStats.length > 0) {
    md += '---\n\n';
    md += '## 🃏 自用卡组统计\n\n';
    md += `| 卡组 | 总场 | 胜 | 负 | 胜率 |\n| --- | --- | --- | --- | --- |\n`;
    stats.myDeckStats.forEach(function(d) {
      md += `| ${d.deck} | ${d.total} | ${d.wins} | ${d.losses} | ${d.winRate}% |\n`;
    });
    md += '\n';
  }
  md += '> **算法**: 按 myDeck 字段分组, 每组统计胜/负/平/异常, 胜率=胜/(胜+负)*100%; 按总场数降序排列\n\n';

  // ── 对手卡组统计 ──
  if (stats.deckStats && stats.deckStats.length > 0) {
    md += '---\n\n';
    md += '## 🎴 对手卡组统计\n\n';
    md += `| 卡组 | 总场 | 胜 | 负 | 胜率 |\n| --- | --- | --- | --- | --- |\n`;
    stats.deckStats.forEach(function(d) {
      md += `| ${d.deck} | ${d.total} | ${d.wins} | ${d.losses} | ${d.winRate}% |\n`;
    });
    md += '\n';
  }
  md += '> **算法**: 按 opponentDeck 字段分组, 与自用卡组同理\n\n';

  // ── 二维交叉统计 ──
  if (stats.matchupStats && stats.matchupStats.length > 0) {
    md += '---\n\n';
    md += '## ⚔️ 对位交叉统计\n\n';
    // 按 myDeck 分组
    var groups = {};
    stats.matchupStats.forEach(function(m) {
      if (!groups[m.myDeck]) groups[m.myDeck] = [];
      groups[m.myDeck].push(m);
    });
    Object.keys(groups).sort(function(a, b) {
      var ta = groups[a].reduce(function(s, m) { return s + m.total; }, 0);
      var tb = groups[b].reduce(function(s, m) { return s + m.total; }, 0);
      return tb - ta;
    }).forEach(function(myDeck) {
      var items = groups[myDeck];
      var subTotal = items.reduce(function(s, m) { return s + m.total; }, 0);
      var subWins = items.reduce(function(s, m) { return s + m.wins; }, 0);
      var subLosses = items.reduce(function(s, m) { return s + m.losses; }, 0);
      var subRate = (subWins + subLosses) > 0 ? ((subWins / (subWins + subLosses)) * 100).toFixed(1) : '0.0';
      md += `**${myDeck}** — 共 ${subTotal} 场, 胜率 ${subRate}%\n\n`;
      md += `| 对手卡组 | 总 | W | L | 胜率 |\n| --- | --- | --- | --- | --- |\n`;
      items.forEach(function(m) {
        var wr = (m.wins + m.losses) > 0 ? ((m.wins / (m.wins + m.losses)) * 100).toFixed(1) : '0.0';
        md += `| ${m.opponentDeck} | ${m.total} | ${m.wins} | ${m.losses} | ${wr}% |\n`;
      });
      md += '\n';
    });
  }
  md += '> **算法**: 按 myDeck+opponentDeck 二维分组, 统计各组胜率; 先按 myDeck 聚合, 每个 myDeck 下再按 opponentDeck 显示明细\n\n';

  // ── 晋级/保级赛 ──
  var rs = stats.rankedStats;
  if (rs && (rs.promotion || rs.relegation)) {
    md += '---\n\n';
    md += '## 🏆 晋级 / 保级赛\n\n';
    [['晋级赛', '🔥', rs.promotion], ['保级赛', '💧', rs.relegation]].forEach(function(item) {
      var label = item[0], icon = item[1], data = item[2];
      if (!data) return;
      md += `### ${icon} ${label}\n\n`;
      md += `| 项目 | 数值 |\n| --- | --- |\n`;
      md += `| 场次 | ${data.total} |\n`;
      md += `| 胜率 | ${data.winRate}% |\n`;
      md += `| 硬币胜率 | ${data.coinWinRate}% |\n`;
      md += `| 先手胜率 | ${data.firstWinRate}% |\n`;
      md += `| 后手胜率 | ${data.secondWinRate}% |\n`;
      md += `| 卡手率 | ${data.cantPlayRate}% |\n`;
      md += `| 对手大牌率 | ${data.bigHandRate}% |\n`;

      var ht2 = data.handtrap;
      if (ht2 && ht2.presets && ht2.presets.length > 0) {
        md += '\n**吃手坑**:\n';
        ht2.presets.forEach(function(p) {
          var cnt = (ht2.counts && ht2.counts[p.id]) || 0;
          if (cnt > 0) md += `- ${p.label}: ${cnt}\n`;
        });
      }

      if (data.oppDecks && data.oppDecks.length > 0) {
        md += '\n**对手卡组分布**:\n\n';
        md += `| 卡组 | W | L | 胜率 |\n| --- | --- | --- | --- |\n`;
        data.oppDecks.forEach(function(d) {
          md += `| ${d.deck} | ${d.wins} | ${d.losses} | ${d.winRate}% |\n`;
        });
      }
      md += '\n';
    });
  }
  md += '> **算法**: 晋级/保级赛 = matchType 为 "promotion"/"relegation" 的对局; 统计胜率、硬币胜率、先后手胜率、卡手率、对手大牌率、吃手坑分布、对手卡组分布\n\n';

  // ── 对局原始数据表格 ──
  md += '---\n\n';
  md += '## 📋 对局明细\n\n';
  if (matches.length > 0) {
    md += `共 ${matches.length} 场对局\n\n`;
    md += `| # | 时间 | 结果 | 先后手 | 硬币 | 自用卡组 | 对手卡组 | 手坑 | 卡手 | 失误 | 终场/突破 | 备注 |\n`;
    md += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    var maxRows = matches.length;
    for (var i = matches.length - maxRows; i < matches.length; i++) {
      var m = matches[i];
      var ts = m.timestamp ? m.timestamp.substring(0, 16).replace('T', ' ') : '—';
      var res = m.result || '—';
      var gf = m.goingFirst === true ? '先手' : (m.goingFirst === false ? '后手' : '—');
      var coin = m.coinToss === true ? '正' : (m.coinToss === false ? '反' : '—');
      var myD = m.myDeck || '—';
      var opD = m.opponentDeck || '—';
      var htStr = (m.handtraps && m.handtraps.length > 0) ? m.handtraps.map(function(h) { return h.replace('got', ''); }).join(',') : '—';
      var cantPlay = (m.cantPlay || m.cantPlayGarnet || m.cantPlayDuplicate || m.cantPlayHT || m.bothStuck) ? 'Y' : '—';
      var mistake = m.mistake ? 'Y' : '—';
      var endBrk = m.goingFirst ? (m.endboardState || '—') : (m.brokeBoard || '—');
      var notes = (m.notes || '').substring(0, 30).replace(/\|/g, '\\|');
      md += `| ${i + 1} | ${ts} | ${res} | ${gf} | ${coin} | ${myD} | ${opD} | ${htStr} | ${cantPlay} | ${mistake} | ${endBrk} | ${notes} |\n`;
    }
    md += '\n';
  } else {
    md += '（无对局数据）\n\n';
  }

  md += '---\n\n';
  md += `*由 MD Stats v${require('./package.json').version} 自动生成*\n`;

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出统计报告',
    defaultPath: `md-stats-report-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (canceled || !filePath) return { success: false, reason: 'canceled' };
  try {
    fs.writeFileSync(filePath, md, 'utf-8');
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stats:import-json', (event, jsonStr) => {
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.matches || !Array.isArray(parsed.matches)) {
      return { success: false, error: '无效的数据格式' };
    }
    const MAX_MATCHES = 100000;
    if (parsed.matches.length > MAX_MATCHES) {
      return { success: false, error: '数据量过大（最多 ' + MAX_MATCHES + ' 条）' };
    }
    // 只覆盖对局数据，保留预设等配置
    data.matches = parsed.matches.map(sanitizeMatchData);
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
  try {
    const u = new URL(url);
    const allowed = ['github.com', 'raw.githubusercontent.com'];
    if (!allowed.includes(u.hostname)) return;
    if (u.protocol !== 'https:') return;
    shell.openExternal(url);
  } catch (e) {
    console.error('拒绝打开不安全的 URL:', url);
  }
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
  const n = (name || '').trim();
  if (!n) return { success: false, error: '名称不能为空' };
  if (n.length > 100) return { success: false, error: '名称过长（最多100字符）' };
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
  const n = (newName || '').trim();
  if (!n) return { success: false, error: '名称不能为空' };
  if (n.length > 100) return { success: false, error: '名称过长（最多100字符）' };
  data.deckPresets[idx] = n;
  saveData();
  return { success: true, presets: data.deckPresets };
});

// ── 自用卡组预设管理 ─────────────────────────────────────────────────
ipcMain.handle('mydeck:get-all', () => {
  return (data.myDeckPresets || []);
});

ipcMain.handle('mydeck:add', (event, name) => {
  const n = (name || '').trim();
  if (!n) return { success: false, error: '名称不能为空' };
  if (n.length > 100) return { success: false, error: '名称过长（最多100字符）' };
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
  const n = (newName || '').trim();
  if (!n) return { success: false, error: '名称不能为空' };
  if (n.length > 100) return { success: false, error: '名称过长（最多100字符）' };
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
  if (l.length > 100) return { success: false, error: '名称过长（最多100字符）' };
  if (!id) return { success: false, error: 'ID 不能为空' };
  if (id.length > 50) return { success: false, error: 'ID 过长' };
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