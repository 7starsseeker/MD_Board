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
      // 数据迁移：旧格式 handtrap 布尔字段 → 统一 handtraps 数组
      if (data.matches) {
        var migrated = false;
        data.matches.forEach(function(m) {
          if (m.handtraps && Array.isArray(m.handtraps) && m.handtraps.length > 0) return;
          var hts = [];
          if (m.gotMaxxc) hts.push('gotMaxxc');
          if (m.gotDroll) hts.push('gotDroll');
          if (m.gotJellyfish) hts.push('gotJellyfish');
          if (m.gotLancea) hts.push('gotLancea');
          if (m.gotNibiru) hts.push('gotNibiru');
          if (m.gotDimension) hts.push('gotDimension');
          if (m.gotSmallHT) hts.push('_other');
          if (hts.length > 0) { m.handtraps = hts; migrated = true; }
        });
        if (migrated) saveData();
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
  // 基础7种ID独立保障：即使预设中被删除也能统计到旧数据
  var baseFallbackIds = ['gotMaxxc','gotDroll','gotJellyfish','gotLancea','gotNibiru','gotDimension'];
  baseFallbackIds.forEach(function(id) {
    if (!(id in htCounts)) {
      htCounts[id] = matches.filter(function(m) { return getMatchHandtraps(m).includes(id); }).length;
    }
    if (!(id in htByFirst)) {
      htByFirst[id] = matches.filter(function(m) { return getMatchHandtraps(m).includes(id) && m.goingFirst; }).length;
    }
    if (!(id in htBySecond)) {
      htBySecond[id] = matches.filter(function(m) { return getMatchHandtraps(m).includes(id) && !m.goingFirst; }).length;
    }
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
    m.opponentRan || (m.disconnect && m.disconnectWho === 'opponent') || (m.timeout && m.timeoutWho === 'opponent') || (m.deckOut && m.deckOutWho === 'opponent');
  const trueStopped = firstMatches.filter(m => m.endboardState === 'stopped' && !opponentDirectWin(m)).length;
  const opponentSurrendered = firstMatches.filter(m => opponentDirectWin(m) && m.result === 'win').length;
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
    handtrap: { gotMaxxc: tMaxxc, gotDroll: tDroll, gotJellyfish: tJellyfish, gotLancea: tLancea, gotNibiru: tNibiru, gotDimension: tDimension, gotSmallHT: tSmallHT, gotAnyG: tAnyG, presets: data.handtrapPresets || [], counts: counts, config: data.handtrapConfig || { largeIds: [], compactIds: [] } },
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
  md += '> 如某字段对应的预设已被删除，行末标注⚠️（该数据归入其他手坑）。\n\n';
  const ht = stats.handtrap;
  md += `| 手坑 | 次数 | 占比 |\n| --- | --- | --- |\n`;
  // 基础手坑（硬编码，确保所有字段都导出）
  var activePresetIds = {};
  (ht.presets || []).forEach(function(p) { activePresetIds[p.id] = true; });
  function noteIfDeleted(id) { return activePresetIds[id] ? '' : ' ⚠️（预设已删除，数据归入其他手坑）'; }
  md += `| 鸟G | ${ht.gotDroll} | -${noteIfDeleted('gotDroll')}\n`;
  md += `| 水母G | ${ht.gotJellyfish} | -${noteIfDeleted('gotJellyfish')}\n`;
  md += `| 锁鸟 | ${ht.gotLancea} | -${noteIfDeleted('gotLancea')}\n`;
  md += `| 陨石 | ${ht.gotNibiru} | ${ht.nibiruRate}%${noteIfDeleted('gotNibiru')}\n`;
  md += `| 大宇宙人/次元系 | ${ht.gotDimension} | -${noteIfDeleted('gotDimension')}\n`;
  md += `| 其他手坑 | ${ht.gotSmallHT} | -\n`;
  // 预设：仅输出非基础的自定义手坑
  var baseIds = ['gotMaxxc','gotDroll','gotJellyfish','gotLancea','gotNibiru','gotDimension'];
  if (ht.presets && ht.presets.length > 0) {
    ht.presets.forEach(function(p) {
      if (baseIds.indexOf(p.id) >= 0) return;
      const cnt = (ht.counts && ht.counts[p.id]) || 0;
      if (cnt > 0) {
        md += `| ${p.label} | ${cnt} | -\n`;
      }
    });
  }
  md += '\n';
  md += '> **算法**: 逐场提取 handtraps 数组, 按 ID 统计出现次数除以总对局数得占比。gotAnyG = 含 G/鸟G/水母任一的场次。\n\n';

  // ── 手牌与卡手统计 ──
  md += '---\n\n';
  md += '## 🃏 手牌与卡手统计\n\n';
  const hs = stats.handState;
  md += `| 类型 | 次数 | 占比 |\n| --- | --- | --- |\n`;
  md += `| 卡手合计 | ${hs.totalCantPlay} | ${hs.cantPlayRate}% |\n`;
  md += `| 动不了 | ${hs.cantPlay} | -\n`;
  md += `| 卡废件 | ${hs.cantPlayGarnet} | -\n`;
  md += `| 卡同名牌 | ${hs.cantPlayDuplicate} | -\n`;
  md += `| 卡后手牌 | ${hs.cantPlayHT} | -\n`;
  md += `| 互卡 | ${hs.bothStuck} | ${hs.bothStuckRate}% |\n`;

  // 先后手卡手
  md += '\n**先后手卡手**:\n\n';
  md += `| 项目 | 先手 | 后手 |\n| --- | --- | --- |\n`;
  md += `| 动不了 | ${hs.byFirst.cantPlay} | ${hs.bySecond.cantPlay} |\n`;
  md += `| 卡废件 | ${hs.byFirst.cantPlayGarnet} | ${hs.bySecond.cantPlayGarnet} |\n`;
  md += `| 卡同名牌 | ${hs.byFirst.cantPlayDuplicate} | ${hs.bySecond.cantPlayDuplicate} |\n`;
  md += `| 卡后手牌 | ${hs.byFirst.cantPlayHT} | ${hs.bySecond.cantPlayHT} |\n`;
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
  md += '> **算法**: 吓跑率 = opponentRan 标记对局数/总对局*100%; 区分先手终场阶段(正常/妥协/被停/无终场/其他)和后手突破阶段(无需/成功/失败/无记录/其他); 先手+对手吓跑+无终场也计为对手投降\n\n';

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
  md += '> **算法**: 对手 T0 = opponentT0 标记对局; 统计胜率观察被 T0 动后的胜负分布, 按对手卡组分组\n\n';

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
  md += '> **算法**: 正常展开率 = endboardState="normal"/先手总场*100%; 妥协/被停/投降/对手投各计数; 对手投 = opponentRan/对手掉线/对手超时/对手抽干 且结果为胜\n\n';

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
    const black = t.enemyBlack + t.selfBlack;
    const white = t.enemyWhite + t.selfWhite;
    const blackRate = (black / (black + white) * 100).toFixed(1);
    md += `**提丰登场**: ${t.total} 次\n`;
    md += `- 🖤 提丰黑子（出提丰且输）: ${black} 次（${blackRate}%）\n`;
    md += `- 🤍 提丰白子（出提丰且赢）: ${white} 次\n`;
    md += `- 明细：对手出提丰输了 ${t.enemyBlack} · 对手出提丰赢了 ${t.enemyWhite} · 自己出提丰输了 ${t.selfBlack} · 自己出提丰赢了 ${t.selfWhite}\n\n`;
  }

  if (stats.deckOut && stats.deckOut.total > 0) {
    const d = stats.deckOut;
    md += `**抽干牌组**: ${d.total} 次（自己 ${d.self} / 对手 ${d.opponent}）\n\n`;
  }
  md += '> **算法**: 大牌=opponentBigHand; 提丰=typhonAppeared; 抽干=deckOut。分别统计次数, 提丰+抽干区分己方/对方\n';

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
    md += `| # | 时间 | 结果 | 先后手 | 硬币 | 自用卡组 | 对手卡组 | 手坑 | 卡手 | 失误 | 类型 | 对手 | 状态 | 其他 | 终场/突破 | 备注 |\n`;
    md += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    var maxRows = matches.length;
    for (var i = matches.length - maxRows; i < matches.length; i++) {
      var m = matches[i];
      var ts = m.timestamp ? m.timestamp.substring(0, 16).replace('T', ' ') : '—';
      var res = m.result || '—';
      var gf = m.goingFirst === true ? '先手' : (m.goingFirst === false ? '后手' : '—');
      var coin = m.coinToss === true ? '正' : (m.coinToss === false ? '反' : '—');
      var myD = m.myDeck || '—';
      var opD = m.opponentDeck || '—';
      var htStr = (function(){ var hts = getMatchHandtraps(m); return hts.length > 0 ? hts.map(function(h) { return h.replace('got', ''); }).join(',') : '—'; })();
      var cantPlayDetail = [];
      if (m.cantPlay) cantPlayDetail.push('动不了');
      if (m.cantPlayGarnet) cantPlayDetail.push('卡废件');
      if (m.cantPlayDuplicate) cantPlayDetail.push('卡同名牌');
      if (m.cantPlayHT) cantPlayDetail.push('卡后手牌');
      if (m.bothStuck) cantPlayDetail.push('互卡');
      var cantPlay = cantPlayDetail.length > 0 ? cantPlayDetail.join('/') : '—';
      var mistake = m.mistake ? 'Y' : '—';
      var matchType = m.matchType === 'promotion' ? '晋级' : (m.matchType === 'relegation' ? '保级' : '—');
      var oppFlags = [];
      if (m.opponentBigHand) oppFlags.push('大牌');
      if (m.opponentRan) oppFlags.push('吓跑');
      if (m.opponentT0) oppFlags.push('T0');
      var oppStr = oppFlags.length > 0 ? oppFlags.join('/') : '—';
      var connFlags = [];
      if (m.disconnect) connFlags.push((m.disconnectWho === 'self' ? '己' : '对') + '掉线');
      if (m.timeout) connFlags.push((m.timeoutWho === 'self' ? '己' : '对') + '超时');
      var connStr = connFlags.length > 0 ? connFlags.join('/') : '—';
      var otherFlags = [];
      if (m.typhonAppeared) otherFlags.push((m.typhonWho === 'self' ? '己' : '对') + '提丰');
      if (m.deckOut) otherFlags.push((m.deckOutWho === 'self' ? '己' : '对') + '抽干');
      var otherStr = otherFlags.length > 0 ? otherFlags.join('/') : '—';
      var endBrk = m.goingFirst ? (m.endboardState || '—') : (m.brokeBoard || '—');
      var notes = (m.notes || '').substring(0, 30).replace(/\|/g, '\\|');
      md += `| ${i + 1} | ${ts} | ${res} | ${gf} | ${coin} | ${myD} | ${opD} | ${htStr} | ${cantPlay} | ${mistake} | ${matchType} | ${oppStr} | ${connStr} | ${otherStr} | ${endBrk} | ${notes} |\n`;
    }
    md += '\n';
  } else {
    md += '（无对局数据）\n\n';
  }

  // ── 字段说明附录 ──
  md += '\n---\n\n';
  md += '## 📖 字段说明\n\n';
  md += '对局记录中各字段的含义及其对应的统计分类：\n\n';
  md += '| 字段 | 含义 | 所属统计范畴 | 取值说明 |\n';
  md += '| --- | --- | --- | --- |\n';
  md += '| 时间 | 对局发生时间 | — | ISO 格式 |\n';
  md += '| 结果 | 对局结果 | 📊 概览 · 先后手对比 | win=胜 / loss=负 / draw=平 / abnormal=异常 |\n';
  md += '| 先后手 | 是否先手 | ⚔️ 先后手对比 · 🏗️ 先手终场 · 🔨 后手突破 | 先手 / 后手 |\n';
  md += '| 硬币 | 投币结果 | 🪙 硬币统计 | 正=先手 / 反=后手 |\n';
  md += '| 自用卡组 | 自己使用的卡组 | 🃏 自用卡组统计 | 自由文本 |\n';
  md += '| 对手卡组 | 对手使用的卡组 | 🎴 对手卡组统计 · ⚔️ 对位交叉 | 自由文本 |\n';
  md += '| 手坑 | 吃到的手坑列表 | 🛡️ 吃手坑统计 | 手坑 ID 列表, 逗号分隔 |\n';
  md += '| 卡手 | 是否卡手 | 🃏 手牌与卡手统计 | Y=卡手 / —=正常; 细分: cantPlay/动不了, cantPlayGarnet/卡废件, cantPlayDuplicate/卡同名牌, cantPlayHT/卡后手牌, bothStuck/互卡 |\n';
  md += '| 失误 | 是否出现严重失误 | 💢 严重失误统计 | Y=有 / —=无 |\n';
  md += '| 终场/突破 | 先手终场或后手突破 | 🏗️ 先手终场 · 🔨 后手突破 | 先手: normal/compromised/stopped/surrender; 后手: true/false/surrender/not_applicable |\n';
  md += '| 备注 | 附加说明 | — | 自由文本 |\n';
  md += '| 晋级/保级 | 是否为晋级/保级赛 | 🏆 晋级/保级赛 | promotion=晋级赛 / relegation=保级赛 |\n';
  md += '| 对手大牌 | 对手手牌质量极佳 | 🃏 其他统计 | boolean |\n';
  md += '| 吓跑对手 | 对手提前投降 | 🏃 吓跑对手统计 | boolean |\n';
  md += '| 对手T0 | 对手在自己先攻回合发动了效果（手坑/特殊召唤等） | ⚡ 对手 T0 动统计 | boolean |\n';
  md += '| 掉线 | 是否有人掉线 | 📡 连接状态 | boolean; 区分 self/opponent |\n';
  md += '| 超时 | 是否有人超时 | 📡 连接状态 | boolean; 区分 self/opponent |\n';
  md += '| 提丰登场 | 是否有人召唤提丰——黑子=出提丰且输，白子=出提丰且赢 | 🃏 其他统计 | boolean; 区分 self/opponent |\n';
  md += '| 抽干牌组 | 是否有人牌组抽空 | 🃏 其他统计 | boolean; 区分 self/opponent |\n';
  md += '\n';

  md += '---\n\n';
  md += `*由 MD Stats v${require('./package.json').version} 自动生成*\n\n`;

  // ── AI 分析规范附录 ──
  md += '---\n\n';
  md += '## 🤖 AI 综合分析规范\n\n';
  md += '以下内容供 AI 分析时参考，包含统计口径说明、分析方法和报告样式要求。\n\n';
  md += '### 1. 字段与内部ID对应\n\n';
  md += '| 导出显示 | 内部字段ID |\n';
  md += '| --- | --- |\n';
  md += '| 增殖的G | `gotMaxxc` |\n';
  md += '| 鸟G | `gotDroll` |\n';
  md += '| 水母G | `gotJellyfish` |\n';
  md += '| 锁鸟 | `gotLancea` |\n';
  md += '| 陨石 | `gotNibiru` |\n';
  md += '| 大宇宙人/次元系 | `gotDimension` |\n';
  md += '| 其他手坑 | `gotSmallHT` / `_other` |\n';
  const BASE_HT_IDS = ['gotMaxxc','gotDroll','gotJellyfish','gotLancea','gotNibiru','gotDimension','gotSmallHT','_other'];
  const customPresets = (data.handtrapPresets || []).filter(p => !BASE_HT_IDS.includes(p.id));
  if (customPresets.length > 0) {
    md += '| 以下为自定义手坑预设 | |\n';
    customPresets.forEach(p => {
      md += `| ${p.label} | \`${p.id}\` |\n`;
    });
  }
  md += '\n';
  md += '> 基础字段为硬编码输出，预设仅补充非基础自定义手坑。若对应预设已被删除，行末有⚠️标注，该数据归入其他手坑。\n';
  md += '> **⚠️ 后端字段名仅供参考，不要反推卡牌身份**：后端字段 `gotDroll` / `gotLancea` 命名不准确，不要借此推测对应卡牌的效果或原因。`gotDroll` 对应的是鸟G（多多迷宝系列中的长尾山雀），`gotLancea` 对应的是锁鸟（小丑与锁鸟）。**禁止**根据字段名猜测卡牌效果、原作系列或机制原因，全部以统计面板中的前端显示名为准。\n\n';
  md += '**卡手类型说明**：\n';
  md += '- **动不了**：关键组件全无，完全无法展开\n';
  md += '- **卡废件**：不希望开局被自然抽到的牌，应由卡组效果调度，抽到后难以处理\n';
  md += '- **卡同名牌**：上手多张同名牌，同名卡一回合通常只能用一次，多张即纯卡手\n';
  md += '- **卡后手牌**：先手时上手多张只有后手才有用的牌（如手坑、解场牌等）\n';
  md += '- **互卡**：双方都出现卡手情况\n\n';
  md += '### 2. 分析方法\n\n';
  md += '**第一部分：数据特征分析（对应第①—⑧章）** — 单纯分析数据反映的玩家和环境特征，不做归因判断。\n\n';
  md += '**投币公平性**：用 Z 检验（|观察-预期|/标准误），分数≤20 正常 / ≤50 ⚠️ 偏高 / ≤75 🔴 严重 / >75 🔥 极端。附加游程检验（Runs Test）判断正反面序列是否呈现非随机聚类。\n';
  md += '- **异常对局的硬币处理**：文档中标记为"abnormal"的对局指投完硬币、选完先后手后卡在进入流程，服务器异常退出，双方不计胜负。这些对局的硬币结果已计入统计（总投币 = 胜+负+平+abnormal），但不计入胜负统计。分析硬币序列时注意：\n';
  md += '  - 异常局前后硬币的连续性：异常局是否被视为"消耗"了一次硬币结果？检查异常局（尤其是先手异常）后当天内下一局的硬币是否偏向反面。\n';
  md += '  - 硬币统计完整性：由于异常局硬币已计入，总正率不受影响。但若异常局中先手（正）占比异常高，可能意味着"先手被浪费了"——玩家投到先手但因异常没打成，实际体验中被剥夺了一次先手机会。\n';
  md += '  - 关键局影响：晋级赛/保级赛中出现的异常局不计胜负，可能影响升降段结果判断。\n\n';
  md += '**连胜/连败补偿**：\n';
  md += '- 统计 ≥4 连胜/连败后的下一局胜率、卡手率、投币正率\n';
  md += '- 连胜/连败长度分布拟合优度检验：实际分布 vs 二项分布理论预期，判断发生频率是否显著偏离随机\n\n';
  md += '**升降段倾斜**：\n';
  md += '- 分别统计晋级赛（matchType=promotion）和保级赛（matchType=relegation）的投币正率、胜率、卡手率，对比差距\n';
  md += '- 关键局分析：晋级赛决胜局（最后一场）和保级赛决胜局的投币结果、卡手率、手坑分布，与普通对局逐一对比\n';
  md += '- 逐局过关：晋级赛/保级赛中所有对局逐场检查手牌质量（卡手类型细分）、手坑出现率（各手坑频率 vs 全局均值）、对手段位和掉线标记\n\n';
  md += '**硬币序列分析**：\n';
  md += '- 全量统计：先手（正）率是否接近50%，Z检验（分数≤20正常），游程检验（Runs Test）判断正反面序列是否非随机聚类\n';
  md += '- **按天断开分析（体验核心）**：对局以"天"为独立会话单位，天与天之间断开。按日期分组后，每一天独立计算：当天正率、最大连正/连反长度、末尾N局硬币趋势\n';
  md += '  - 标注所有出现连反≥5的日期，统计"恶劣体验日"（连反≥5且当天胜率<40%）的天数占比\n';
  md += '  - 统计"极端幸运日"（连正≥6且当天胜率>60%）的天数占比作为对比基线\n';
  md += '  - 在日均30-50场的条件下，用二项分布模拟随机期望：连反≥5的理论出现天数 vs 实际天数\n';
  md += '- 条件概率转移矩阵：前1局对后1局的条件概率——**按天计算再聚合**（先算每天矩阵再平均），禁止跨天计算，避免虚假连续性\n';
  md += '- 小样本偏移评估：按天样本量N=30~50时，使用二项分布 Clopper-Pearson 精确置信区间（95%置信水平）判断观察到的正率偏移是否仍属于正常随机波动\n';
  md += '- 后手间隔分布：统计先手（正）之间的连续后手间隔数分布，识别"孤立先手"（反→正→反）和"后手连压"（连反≥4）模式\n';
  md += '- 连败区间孤立先手审查：连败（连反≥3）中出现的孤立先手局（反→正→反），逐局检查卡手率、手坑种类/数量、对手情况和终场强度——**按天独立审查，不跨天**\n';
  md += '- 连胜区间孤立后手审查：同理按天独立分析\n\n';
  md += '**时段分析**：\n';
  md += '- **按日分析（核心分析单元）**：按具体日期分组，这是会话级体验的最小单位。天与天之间断开，序列类指标不跨天计算：\n';
  md += '  - 每天独立统计：胜率、先手率、卡手率、手坑分布、最大连正/连反\n';
  md += '  - 统计"恶劣体验日"（连反≥5且胜率<40%）天数和占比\n';
  md += '  - 统计"极端幸运日"（连正≥6且胜率>60%）天数和占比\n';
  md += '  - 全量聚合会平滑掉极端值，但玩家体验由每一天的实际情况决定——必须优先按天分析再汇总\n';
  md += '- 不同月份：按月分别统计胜率、先手率、卡手率、手坑分布，观察跨月变化的连续性和突变点\n';
  md += '- 月内阶段：月初1-10日/月中11-20日/月末21-31日分组统计，重点关注段位重置日前后的结构性变化\n';
  md += '- 不同星期：按星期几（周一至周日）分组统计各维度，识别周末与工作日的系统差异\n';
  md += '- 跨时段机制连续性：连胜连败补偿、硬币偏差等机制在不同月份/不同周/不同天之间是否持续一致，段位重置后机制触发条件是否归零重置\n\n';
  md += '**吃手坑影响**：计算各手坑出现时的胜率与全局均值对比。注意"G系列任一"（gotAnyG）= 增殖的G/鸟G/水母G 任一种，按场次计不累加。\n';
  md += '基础字段为硬编码输出，预设仅补充非基础的自定义手坑。若某字段对应预设已被删除，行末会标注⚠️，该数据在面板中归入"其他手坑"。\n\n';
  md += '**卡手与废件分析（含构筑背景）**：\n';
  md += '- "卡废件"（cantPlayGarnet）指同名卡只带1张、上手后难以处理的牌。游戏王MD常规构筑原则：同名的牌，优质动点带3，一般动点和补点带2到3，大解牌（后手为主）带1到2，后手手坑带满3，废件类卡通常同名只带1（也有带2的）。\n';
  md += '- 分析卡废件数据时需注意：\n';
  md += '  - 仅有卡废件总次数不足以判断是否异常。如果卡组中有N种同名只带1的废件，先手5张中至少抽到1张废件的概率取决于废件种类数N。N未知时无法判断。\n';
  md += '  - 社区存在体感：同名只带1张的牌上手率高得不正常。要验证此体感需要两方面数据：①具体构筑的废件清单（每种废件的投入张数）；②每局实际手牌内容（哪些废件在开局被抽到）。仅有卡废件总次数不足以区分是废件种类多还是单卡概率异常。\n';
  md += '  - 正确分析方法：如果能获取构筑数据，按卡组分组计算理论废件上手概率，再与实际卡废件率对比；如果差异显著则支持体感，否则更可能是废件种类偏多的结果。\n\n';
  md += '**对手强度分析**：连胜/连败后对手段位变化趋势；晋级赛/保级赛中对手段位分布 vs 普通对局；连败后对手卡组克制倾向\n';
  md += '- **"未知"卡组的解读修正**：对手卡组显示为"未知"的原因包括：①对手在暴露卡组特征之前就投降/吓跑了；②对手掉线/超时；③对局全程仅用泛用牌（手坑/解场牌）就结束，未使用任何卡组特征卡；④自己开局因卡手直接投降，未看到对手展开。因此"未知"卡组的胜率不能用于判断"对上不认识的卡组是否好打"——胜局的80%+是对手不战而降，不是自己打赢的。分析时应单独计算去掉"不战而胜"局（吓跑/掉线/超时）后的净胜率，才能反映真实的対位水平。\n\n';
  md += '**提丰数据分析**：提丰统计源于社区"提丰黑子"梗——玩家在对局不利或即将落败时召唤提丰整活，通常无助于提升胜率。\n';
  md += '- 提丰黑子 = 出提丰且该局输了的人（对手出提丰输 = enemyBlack，自己出提丰输 = selfBlack）\n';
  md += '- 提丰白子 = 出提丰且该局赢了的人（对手出提丰赢 = enemyWhite，自己出提丰赢 = selfWhite）\n';
  md += '- 分析时应关注：提丰黑子比例（被黑次数/总登场次数）是否显著偏高，若黑子远多于白子则佐证"提丰是败局整活"的社区共识\n';
  md += '- 对比自己 vs 对手的提丰黑子率，判断自己是白子多还是黑子多（黑子率低=自己更可能只是赢爽了随手拉个提丰）\n\n';
  md += '---\n';
  md += '**第二部分：系统公平性评估（对应第⑨章）**\n\n';
  md += '在前述数据特征分析的基础上，评估游戏王 MD 的系统机制是否在对战公平各维度产生干预。从以下维度分析，每个维度给出评级（🟢 无证据 / 🟡 中度嫌疑 / 🔴 高度嫌疑）：\n';
  md += '- **投币总体公平**：全量投币正率是否接近 50%，Z 检验+游程检验是否正常\n';
  md += '- **升降段投币倾斜**：晋级赛 vs 保级赛的投币正率差距，决胜局硬币异常\n';
  md += '- **连败后补偿**：连败≥4后下一局胜率、投币正率、卡手率是否异常向好\n';
  md += '- **连胜后惩罚**：连胜≥4后下一局胜率、投币正率、卡手率是否异常向差\n';
  md += '- **后手连压模式（双层面评估）**：\n';
  md += '  - 全量层面：连反≥4频率、时长、孤立先手占比、条件概率转移矩阵是否超出随机\n';
  md += '  - **按天层面（体验核心）**：统计每一天的最大连反长度。即使全量50%完全随机，单日内连反≥6（≈当天1/4以上对局连续后手）的天数占比才是玩家实际感受到的"被系统针对"的概率\n';
  md += '  - 体验阈值：每天30-40场中连反≥6≈6~10局连续后手，对当日胜率和体验是毁灭性的。所有出现连反≥6的日期必须逐一标注当日胜率\n';
  md += '- **硬币短期记忆**：条件概率转移矩阵是否显示前局结果影响后局\n';
  md += '- **手牌质量操控**：保级赛卡手率 vs 晋级赛；保级赛中"动不了"/"卡废件"比例 vs 普通对局\n';
  md += '- **关键局手牌异常**：晋级赛/保级赛各卡手类型分布、手坑出现频率 vs 普通对局，重要对局中手牌是否被系统性压低或抬高\n';
  md += '- **连败虚假希望**：连败≥4区间中孤立胜局的手牌质量、手坑分布、对手因素 vs 正常胜局——是否存在"给一场正常/优质手牌后继续打压"的模式\n';
  md += '- **连胜人为降温**：连胜≥4区间中败局是否以极端卡手（动不了/卡废件/卡同名牌）为主，占比异常高于全局均值\n';
  md += '- **晋级赛铺垫**：进入晋级赛/保级赛前 N 局（N=3/5/10）的硬币走势和胜负趋势，是否存在异常"铺垫"\n';
  md += '- **连胜连败长度分布**：实际分布 vs 二项分布拟合检验，是否显著偏离随机预期\n';
  md += '- **对手强度调节**：连败后对手强度是否下降、连胜后对手强度是否上升；连败后对手卡组克制比例异常\n';
  md += '  - 注意"未知"卡组的特殊性：对"未知"卡组看似高胜率（如68.3%），但需要分解胜局构成——对手吓跑占82.5%、对手掉线占7.1%、正常打完获胜仅约10%。因此不能作为"匹配系统在连败后给弱对手"的证据。分析时应先分离"不战而胜"局，再计算剩余对局的净胜率（通常接近全局均值），避免高估"未知"数据对匹配公平性的暗示。\n';
  md += '- **单日体验极端值**：\n';
  md += '  - 统计"恶劣体验日"（连反≥5且胜率<40%）天数和占比\n';
  md += '  - 统计"极端幸运日"（连正≥6且胜率>60%）天数和占比\n';
  md += '  - 对比两类天数频率的对称性。如果"恶劣体验日"显著多于"极端幸运日"，说明硬币序列虽然全量随机，但在玩家有限的每日时段内系统性偏向不利方向\n';
  md += '- **时段偏倚**：不同月份之间、月内不同阶段、不同星期、不同日之间的胜率、先手率、卡手率是否存在系统性差异。段位重置前后是否存在机制变化（如月初胜率异常上升、月末卡手率异常上升等）\n';
  md += '- **异常局硬币补偿**：检查"先手异常（正）→下一局为反"的频率是否异常偏高。玩家体感是先手出异常后下一把容易变后手，用同一天的条件概率来验证——先手异常→下一局 vs 全局正→反的条件概率对比。若先手异常后下一局为反的概率显著高于全局基线（50%），则存在系统在异常后补偿/惩罚的嫌疑。小样本（通常N<20）仅做提示性分析，不做结论。\n';
  md += '- **废件上手率**：社区体感只带1张的废件上手率高得不正常。要验证此体感需要两方面数据：①具体构筑的废件清单（每种废件的投入张数）；②每局实际手牌内容（哪些废件在开局被抽到）。仅有卡废件总次数不足以区分是废件种类多还是单卡概率异常。在缺乏构筑数据时，可将"卡废件"次数与对应卡组的废件种类预期数做交叉分析（如柜奏系废件种类较多 vs 其他卡组），若各卡组废件率差异可被废件种类数解释，则不支持异常；若差异与种类数无关，则需标记为嫌疑。\n\n';
  md += '### 3. 注意事项\n\n';
  md += '- **AI 必须直接读取本文件中的全部数据进行现场分析**，包括从「对局明细」表格中逐行提取胜负序列、硬币序列、卡手标记等，自行计算连胜连败补偿、投币间隔分布等聚合统计。**禁止**使用外部脚本或工具来解析表格。\n';
  md += '- **不要复用旧分析的战术结论到新数据**：每次新数据应重新分析，不要照搬之前的卡组点评。\n';
  md += '- 基础字段为硬编码输出，预设仅补充非基础自定义手坑。已删除预设的字段行末有⚠️标注。\n';
  md += '- 对手掉线标记对局全部对应胜利（系统判赢）。\n';
  md += '- **"异常"对局说明**：result="abnormal"的对局指投完硬币、选完先后手后卡在进入流程，服务器异常退出，双方不计入胜负场次。特征：对手卡组全部为"未知"（未进入对局无法获取）、无手坑记录、无卡手标记。异常局不计胜负但不影响硬币统计，投币分析时应注意将其纳入硬币总次数。\n';
  md += '- **"未知"卡组标记的含义**："未知"不是一种卡组，而是系统无法判定对手卡组时的兜底标签。产生条件：对局结束前对手未使用任何可识别卡组特征的主卡组卡牌（仅用手坑、泛用魔法陷阱、额外卡组怪兽等），或对局因投降/掉线/异常在对手出牌前结束。分析时不要将"未知"等同于"弱卡组"或"低分段玩家"，其看似高胜率（如68.3%）中约89.6%来自对手不战而降。对比"未知"和其他卡组的胜率时，需先剔除不战而胜局，否则对比结论无意义。\n';
  md += '- 卡组战术分析（如"某卡组不太怕某手坑"等点评）属于本次分析的主观判断，新数据应基于新数据重新评估。\n';
  md += '- **天与天之间断开分析**：对局按日期分组，每天是独立的游戏会话。跨天计算序列类指标（连胜连败补偿、投币连压、孤立先手/后手）会产生虚假连续性——昨天末局与今天首局间隔超过12小时，不存在连续体验。所有序列分析必须按天分为独立段，天与天之间不连续。\n';
  md += '- **"天"是体验分析的最小单位**：全量聚合会平滑掉极端值。必须在按天分组分析后再做全量汇总，优先呈现"有多少天的体验是不好的"而非"整体均值是多少"。\n';
  md += '- **严格基于数据，禁止无依据猜测**：所有分析结论必须来源于本文件中的实际数据（表格、统计指标）。禁止凭空猜测卡组构筑（如"这卡组里应该带了几张什么牌"）、禁止虚构废件种类数量、禁止使用个人经验替代数据支撑。对于缺乏数据支持的维度（如废件具体种类数），直接说明"数据不足无法判断"而非脑补。\n\n';
  md += '### 4. HTML 报告生成指南\n\n';
  md += '生成 HTML 报告时遵循以下规范，确保风格统一：\n\n';
  md += '**整体**：零依赖纯 HTML + CSS，无外部字体/CDN，双击即开。背景 `#f6f5f1`，文字 `#1a1a2e`。\n\n';
  md += '**Header**：渐变背景 `linear-gradient(135deg,#0a1f3d,#1a3a5c)`，白色文字居中。标题 `font-weight:800`，关键数字大字居中展示。\n\n';
  md += '**Section卡片**：白底 `border-radius:8px` `box-shadow:0 1px 4px rgba(0,0,0,.04)`，边框 `1px solid #e5e2da`，间距 `1.5em`。h2 左侧 4px 红色竖条（`#e8453e`）。\n\n';
  md += '**表格**：全宽 `border-collapse:collapse`，表头 `#f0ede8`，行交替色 `tr:nth-child(even){background:#faf9f6}`，字号 `clamp(.72rem,.85vw,.8rem)`。\n\n';
  md += '**标记**：`.tag-r`红 `.tag-g`绿 `.tag-y`黄 `.tag-b`蓝 `.tag-gr`灰。`.alert`黄底左黄条，`.callout`深蓝底白字，`.highlight-box`浅红边框，`.code`深色底代码块，`.lil-note`灰色小字，`.grid-2`/`.grid-3`网格布局。\n\n';
  md += '**章节结构**：报告分为两大部分。\n\n';
  md += '**第一部分（①—⑧）数据特征分析**：单纯分析已有数据体现了玩家和整体环境的什么特征，不做归因判断。\n';
  md += '①数据总览 ②投币序列分析 ③连胜/连败补偿效应 ④晋级赛vs保级赛 ⑤卡手率与吃手坑 ⑥自身卡组胜率 ⑦时段分析 ⑧实战影响分析\n\n';
  md += '**第二部分（⑨）系统公平性评估**：在前述数据基础上，专门分析游戏王 MD 的系统机制是否通过影响投币、匹配、手牌等维度来干预对战公平性。\n';
  md += '⑨综合结论与系统公平性评估\n\n';
  md += '**颜色**：绿色好 `#27ae60`，红色差 `#c0392b`。\n\n';

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