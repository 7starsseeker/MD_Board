// ═══════════════════════════════════════════════════════════════════════
// MD_Board — 核心统计逻辑单元测试
// 运行: npm test  或  node --test test/stats-core.test.js
// ═══════════════════════════════════════════════════════════════════════

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// ── 从 main.js 提取的纯函数 ────────────────────────────────────────

function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

function getMatchHandtraps(match) {
  if (match.handtraps && Array.isArray(match.handtraps) && match.handtraps.length > 0) {
    return match.handtraps;
  }
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

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
}

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

function computeCoinStats(matches) {
  const arr = matches.filter(m => m.coinToss === true || m.coinToss === false);
  const wins = arr.filter(m => m.coinToss === true).length;
  const losses = arr.filter(m => m.coinToss === false).length;
  const n = arr.length;
  const coinHistory = arr.map(m => ({ coinToss: m.coinToss, result: m.result, goingFirst: m.goingFirst }));
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
  const bias = (function() {
    if (n < 10) return { heads: wins, tails: losses, pct: '—', zScore: 0, severity: '—', severityScore: 0 };
    var expected = n / 2, se = Math.sqrt(n) / 2, z = Math.abs(wins - expected) / se;
    var pctStr = ((wins / n) * 100).toFixed(1), score = Math.min(100, Math.round((z / 4) * 100));
    var s = score <= 20 ? '正常' : score <= 50 ? '⚠️ 偏高' : score <= 75 ? '🔴 显著' : '🔥 异常';
    return { heads: wins, tails: losses, pct: pctStr, zScore: z, severity: s, severityScore: score };
  })();
  return { total: n, wins, losses, coinHistory, winRate: pct(wins, n), streak, bias };
}

// ── 自包含 AES-256-GCM 加密（与 main.js 同步） ─────────────────────

function getWrapKey() {
  return crypto.pbkdf2Sync('md-board-enc-v1', 'md-stats-salt', 10000, 32, 'sha256');
}

function selfEncrypt(plaintext) {
  const wrapKey = getWrapKey();
  const dataKey = crypto.randomBytes(32);
  const wrapIv = crypto.randomBytes(16);
  const wrapCipher = crypto.createCipheriv('aes-256-gcm', wrapKey, wrapIv);
  const encKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();
  const dataIv = crypto.randomBytes(16);
  const dataCipher = crypto.createCipheriv('aes-256-gcm', dataKey, dataIv);
  const encData = Buffer.concat([dataCipher.update(plaintext, 'utf-8'), dataCipher.final()]);
  const dataTag = dataCipher.getAuthTag();
  return Buffer.concat([wrapIv, wrapTag, encKey, dataIv, dataTag, encData]);
}

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

// ═══════════════════════════════════════════════════════════════════════
//  测试
// ═══════════════════════════════════════════════════════════════════════

describe('escapeHtml', async () => {
  it('转义 & < > " \'', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#39;');
  });

  it('转义组合字符串', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('安全字符串不变', () => {
    assert.equal(escapeHtml('Hello World'), 'Hello World');
    assert.equal(escapeHtml('先手/后手/胜率50%'), '先手/后手/胜率50%');
  });

  it('非字符串原样返回', () => {
    assert.equal(escapeHtml(123), 123);
    assert.equal(escapeHtml(null), null);
    assert.equal(escapeHtml(undefined), undefined);
  });
});

describe('sanitizeMatchData', async () => {
  it('截断超长卡组名', () => {
    const longName = 'A'.repeat(200);
    const result = sanitizeMatchData({ opponentDeck: longName });
    assert.equal(result.opponentDeck.length, 100);
  });

  it('截断超长备注', () => {
    const longNotes = 'B'.repeat(1000);
    const result = sanitizeMatchData({ notes: longNotes });
    assert.equal(result.notes.length, 500);
  });

  it('非法 result 降级为 abnormal', () => {
    const result = sanitizeMatchData({ result: 'cheat' });
    assert.equal(result.result, 'abnormal');
  });

  it('合法 result 保持不变', () => {
    assert.equal(sanitizeMatchData({ result: 'win' }).result, 'win');
    assert.equal(sanitizeMatchData({ result: 'loss' }).result, 'loss');
    assert.equal(sanitizeMatchData({ result: 'draw' }).result, 'draw');
  });

  it('非数组 handtraps 重置为空数组', () => {
    const result = sanitizeMatchData({ handtraps: 'string' });
    assert.deepEqual(result.handtraps, []);
  });

  it('正常数据不变', () => {
    const input = { myDeck: '烙印', opponentDeck: '蛇眼', notes: 'good game', result: 'win', handtraps: ['gotMaxxc'] };
    const result = sanitizeMatchData(input);
    assert.equal(result.myDeck, '烙印');
    assert.equal(result.opponentDeck, '蛇眼');
    assert.equal(result.notes, 'good game');
    assert.deepEqual(result.handtraps, ['gotMaxxc']);
  });
});

describe('getMatchHandtraps', async () => {
  it('新格式 handtraps 数组优先', () => {
    const m = { handtraps: ['gotMaxxc', 'gotNibiru'], gotMaxxc: true, gotNibiru: true };
    assert.deepEqual(getMatchHandtraps(m), ['gotMaxxc', 'gotNibiru']);
  });

  it('旧格式布尔字段回退', () => {
    const m = { gotMaxxc: true, gotDroll: false, gotJellyfish: true, gotSmallHT: true };
    const result = getMatchHandtraps(m);
    assert.ok(result.includes('gotMaxxc'));
    assert.ok(result.includes('gotJellyfish'));
    assert.ok(result.includes('_other'));
    assert.ok(!result.includes('gotDroll'));
  });

  it('无手坑返回空数组', () => {
    assert.deepEqual(getMatchHandtraps({}), []);
  });
});

describe('pct', async () => {
  it('计算百分比', () => {
    assert.equal(pct(5, 10), '50.0');
    assert.equal(pct(1, 3), '33.3');
    assert.equal(pct(0, 100), '0.0');
  });

  it('除以零返回 0.0', () => {
    assert.equal(pct(5, 0), '0.0');
    assert.equal(pct(0, 0), '0.0');
  });
});

describe('computeBasicStats', async () => {
  const matches = [
    { result: 'win', goingFirst: true },
    { result: 'win', goingFirst: false },
    { result: 'loss', goingFirst: true },
    { result: 'loss', goingFirst: false },
    { result: 'draw', goingFirst: true },
    { result: 'abnormal', goingFirst: false },
  ];

  it('统计胜负平异常', () => {
    const s = computeBasicStats(matches);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 2);
    assert.equal(s.draws, 1);
    assert.equal(s.abnormals, 1);
    assert.equal(s.total, 6);
    assert.equal(s.winRate, '50.0');
  });
});

describe('computeStreak', async () => {
  it('3连胜', () => {
    const matches = [
      { result: 'loss' }, { result: 'win' }, { result: 'win' }, { result: 'win' }
    ];
    assert.deepEqual(computeStreak(matches), { type: 'win', count: 3 });
  });

  it('2连败', () => {
    const matches = [
      { result: 'win' }, { result: 'loss' }, { result: 'loss' }
    ];
    assert.deepEqual(computeStreak(matches), { type: 'loss', count: 2 });
  });

  it('跳过平局和异常', () => {
    const matches = [
      { result: 'win' }, { result: 'draw' }, { result: 'abnormal' }, { result: 'win' }
    ];
    assert.deepEqual(computeStreak(matches), { type: 'win', count: 2 });
  });

  it('空列表返回 null', () => {
    assert.deepEqual(computeStreak([]), { type: null, count: 0 });
  });
});

describe('computeCoinStats', async () => {
  it('硬币胜负统计', () => {
    const matches = [
      { coinToss: true, result: 'win', goingFirst: true },
      { coinToss: true, result: 'loss', goingFirst: true },
      { coinToss: false, result: 'win', goingFirst: false },
    ];
    const c = computeCoinStats(matches);
    assert.equal(c.total, 3);
    assert.equal(c.wins, 2);
    assert.equal(c.losses, 1);
    assert.equal(c.winRate, '66.7');
  });

  it('无硬币数据', () => {
    const matches = [{ result: 'win' }];
    const c = computeCoinStats(matches);
    assert.equal(c.total, 0);
    assert.equal(c.winRate, '0.0');
    assert.equal(c.streak.severity, '—');
    assert.equal(c.bias.severity, '—');
  });
});

describe('自包含加密/解密', async () => {
  it('加密后能解密回原文', () => {
    const plaintext = JSON.stringify({ matches: [{ id: 'test', result: 'win' }] });
    const encrypted = selfEncrypt(plaintext);
    const decrypted = selfDecrypt(encrypted);
    assert.equal(decrypted, plaintext);
  });

  it('不同的 IV 产生不同的密文', () => {
    const plaintext = 'test data';
    const c1 = selfEncrypt(plaintext);
    const c2 = selfEncrypt(plaintext);
    assert.notDeepEqual(c1, c2);
    assert.equal(selfDecrypt(c1), plaintext);
    assert.equal(selfDecrypt(c2), plaintext);
  });

  it('文件格式：头部固定 96 字节', () => {
    const enc = selfEncrypt('hello');
    assert.equal(enc.length, 96 + Buffer.from('hello', 'utf-8').length);
    assert.equal(enc.slice(0, 16).length, 16); // wrapIv
    assert.equal(enc.slice(16, 32).length, 16); // wrapTag
    assert.equal(enc.slice(32, 64).length, 32); // encKey
    assert.equal(enc.slice(64, 80).length, 16); // dataIv
    assert.equal(enc.slice(80, 96).length, 16); // dataTag
  });

  it('任意机器使用相同 wrapKey', () => {
    assert.deepEqual(getWrapKey(), getWrapKey());
    assert.equal(getWrapKey().length, 32);
  });
});
