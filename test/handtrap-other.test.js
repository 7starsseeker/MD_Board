// ═══════════════════════════════════════════════════════════════════════
// MD_Board — 「其他手坑」(_other) 统计与录入连通性守卫
// 运行: npm test  或  node --test test/handtrap-other.test.js
//
// 为什么单开一个文件：test/stats-core.test.js 里的 getMatchHandtraps 是一份
// **手抄副本**，测副本无法证明 main.js 是对的。本文件直接从 main.js 源码里
// 抽取函数来执行，测的是生产代码。
// ═══════════════════════════════════════════════════════════════════════

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const CONTROL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'control.html'), 'utf8');

/** 从源码里按名字抠出一个函数声明（花括号配平），然后执行它 */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'main.js 里找不到 function ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的花括号不配平');
}

const PROD = new Function(
  ['pct', 'getMatchHandtraps', 'computeHandtrapStats']
    .map(n => extractFn(MAIN_SRC, n)).join('\n') +
  '\nreturn { getMatchHandtraps, computeHandtrapStats };'
)();

const PRESETS = [
  { id: 'gotMaxxc', label: '增殖的G' },
  { id: 'gotDroll', label: '鸟G' },
  { id: 'gotJellyfish', label: '水母G' },
  { id: 'gotLancea', label: '锁鸟' },
  { id: 'gotNibiru', label: '陨石' },
  { id: 'gotDimension', label: '大宇宙人/次元系' }
];
const HT_CONFIG = { largeIds: ['gotMaxxc', 'gotDroll', 'gotJellyfish', 'gotLancea'], compactIds: ['gotNibiru', 'gotDimension'] };

// ── getMatchHandtraps：_other 的两个来源必须合并 ─────────────────────
describe('getMatchHandtraps — 其他手坑(_other)', () => {
  it('数组里有预设 + gotSmallHT 为真 → 两者都要在（v1.2.0 回归的核心用例）', () => {
    const m = { handtraps: ['gotMaxxc'], gotSmallHT: true };
    assert.deepEqual(PROD.getMatchHandtraps(m), ['gotMaxxc', '_other']);
  });

  it('只有 gotSmallHT、handtraps 为 null → 只有 _other', () => {
    const m = { handtraps: null, gotSmallHT: true };
    assert.deepEqual(PROD.getMatchHandtraps(m), ['_other']);
  });

  it('数组里已经带 _other 且 gotSmallHT 也为真 → 不重复', () => {
    const m = { handtraps: ['gotMaxxc', '_other'], gotSmallHT: true };
    const ids = PROD.getMatchHandtraps(m);
    assert.deepEqual(ids, ['gotMaxxc', '_other']);
    assert.equal(ids.filter(id => id === '_other').length, 1);
  });

  it('数组里带 _other 但 gotSmallHT 为假 → 仍认数组（老数据兼容）', () => {
    const m = { handtraps: ['_other'], gotSmallHT: null };
    assert.deepEqual(PROD.getMatchHandtraps(m), ['_other']);
  });

  it('只有预设、没勾其他手坑 → 不能凭空冒出 _other', () => {
    const m = { handtraps: ['gotMaxxc', 'gotNibiru'], gotSmallHT: false };
    assert.deepEqual(PROD.getMatchHandtraps(m), ['gotMaxxc', 'gotNibiru']);
  });

  it('旧数据回退：数组缺失时仍读老布尔字段，且 _other 一并计入', () => {
    const m = { handtraps: undefined, gotMaxxc: true, gotDroll: true, gotSmallHT: true };
    assert.deepEqual(PROD.getMatchHandtraps(m), ['gotMaxxc', 'gotDroll', '_other']);
  });

  it('空数组视同没有数组，走回退分支', () => {
    const m = { handtraps: [], gotLancea: true, gotSmallHT: true };
    assert.deepEqual(PROD.getMatchHandtraps(m), ['gotLancea', '_other']);
  });

  it('数组非空时不再重复叠加老布尔字段（避免双计）', () => {
    const m = { handtraps: ['gotMaxxc'], gotMaxxc: true, gotDroll: true };
    assert.deepEqual(PROD.getMatchHandtraps(m), ['gotMaxxc']);
  });
});

// ── computeHandtrapStats：口径必须反映 _other ───────────────────────
describe('computeHandtrapStats — 其他手坑计数', () => {
  it('一局「预设 + 其他手坑」→ total 2、gotSmallHT 1', () => {
    const s = PROD.computeHandtrapStats([{ result: 'win', goingFirst: true, handtraps: ['gotMaxxc'], gotSmallHT: true }], 1, PRESETS, HT_CONFIG);
    assert.equal(s.gotMaxxc, 1);
    assert.equal(s.gotSmallHT, 1);
    assert.equal(s.total, 2);
  });

  it('一局「只有其他手坑」→ total 1、gotSmallHT 1', () => {
    const s = PROD.computeHandtrapStats([{ result: 'loss', goingFirst: false, handtraps: null, gotSmallHT: true }], 1, PRESETS, HT_CONFIG);
    assert.equal(s.gotSmallHT, 1);
    assert.equal(s.total, 1);
    assert.equal(s.bySecond.gotSmallHT, 1);
    assert.equal(s.byFirst.gotSmallHT, 0);
  });

  it('没勾其他手坑的局不计数', () => {
    const s = PROD.computeHandtrapStats([{ result: 'win', goingFirst: true, handtraps: ['gotMaxxc'], gotSmallHT: false }], 1, PRESETS, HT_CONFIG);
    assert.equal(s.gotSmallHT, 0);
    assert.equal(s.total, 1);
  });
});

// ── 源码守卫：防止退回旧实现 ────────────────────────────────────────
describe('源码守卫 — 旧实现不得回归', () => {
  it('getMatchHandtraps 不能再出现「数组非空就直接 return」的写法', () => {
    const body = extractFn(MAIN_SRC, 'getMatchHandtraps');
    assert.ok(!/length\s*>\s*0\)\s*\{\s*return match\.handtraps;/.test(body),
      '又回到数组优先直接 return 了 —— 那样 gotSmallHT 会被吞掉');
  });

  it('getMatchHandtraps 必须在末尾合并 _other', () => {
    const body = extractFn(MAIN_SRC, 'getMatchHandtraps');
    assert.ok(/match\.gotSmallHT\s*\|\|/.test(body), '缺少 gotSmallHT 的合并条件');
    assert.ok(/push\('_other'\)/.test(body), '缺少 push(_other)');
  });

  it('提交路径必须把 gotSmallHT 落进 handtraps 数组', () => {
    assert.ok(
      CONTROL_SRC.includes("if (state.gotSmallHT && handtrapIds.indexOf('_other') < 0) handtrapIds.push('_other');"),
      'control.html 提交路径丢失了 _other 合并'
    );
  });
});

// ── 控件连通性：每个 chk-* 都必须真的接到 state ────────────────────
// v1.2.0 那次回归就是「HTML 有控件、JS 没绑定」，勾了有视觉反馈但不写 state。
describe('控件连通性 — 每个 chk-* 都要有写入路径', () => {
  const checkboxIds = [...CONTROL_SRC.matchAll(/id="(chk-[a-z0-9-]+)"/g)].map(m => m[1]);
  const uniqueIds = [...new Set(checkboxIds)];

  it('至少能扫到复选框（防止正则失效导致空跑通过）', () => {
    assert.ok(uniqueIds.length >= 15, '只扫到 ' + uniqueIds.length + ' 个 chk-*，正则可疑');
  });

  it('chk-small-ht 必须存在并绑定到 gotSmallHT', () => {
    assert.ok(uniqueIds.includes('chk-small-ht'), 'HTML 里没有 chk-small-ht');
    assert.ok(/bindCheckbox\('chk-small-ht',\s*'gotSmallHT'\)/.test(CONTROL_SRC),
      'chk-small-ht 没有绑定到 gotSmallHT');
  });

  for (const id of uniqueIds) {
    it('#' + id + ' 有写入路径（bindCheckbox 或 change 监听）', () => {
      const bound = CONTROL_SRC.includes("bindCheckbox('" + id + "'");
      const listener = new RegExp("getElementById\\('" + id + "'\\)[\\s\\S]{0,400}?addEventListener\\('change'").test(CONTROL_SRC);
      assert.ok(bound || listener,
        '#' + id + ' 既没有 bindCheckbox 也没有 change 监听 —— 勾了不会写入 state');
    });
  }

  it('不允许出现重复绑定同一个 id（会叠两条监听）', () => {
    const calls = [...CONTROL_SRC.matchAll(/bindCheckbox\('([a-z0-9-]+)'/g)].map(m => m[1]);
    const dup = calls.filter((id, i) => calls.indexOf(id) !== i);
    assert.deepEqual([...new Set(dup)], [], '重复绑定: ' + [...new Set(dup)].join(', '));
  });
});
