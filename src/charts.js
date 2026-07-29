/* ═══════════════════════════════════════════════════════════════════════════
   MD Stats - 图表模块（基于 Chart.js）
   提供各种统计数据的图表渲染函数
   ═══════════════════════════════════════════════════════════════════════════ */

/* global Chart */

// ── Chart.js 全局默认值 ──────────────────────────────────────────────
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#ffffff';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.12)';
  Chart.defaults.font.family = "'Consolas','Cascadia Code','JetBrains Mono',monospace,'思源黑体','Noto Sans CJK SC','PingFang SC',sans-serif";
}

// ── 工具 ─────────────────────────────────────────────────────────────
function fmt(v) {
  if (v === undefined || v === null) return '0.0';
  var n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? '0.0' : n.toFixed(1);
}
// 胜率颜色 >50%绿 <50%红 =50%白
function winBarCls(r) { var v = parseFloat(r); return v > 50 ? 'green' : v < 50 ? 'red' : ''; }

/** HTML 转义 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 填充 info 面板：单行 */
function infoRow(label, value, cls) {
  return '<div class="info-row"><span class="info-label">' + escapeHtml(label) + '</span><span class="info-val' + (cls ? ' ' + cls : '') + '">' + value + '</span></div>';
}

/** 填充 info 面板：带进度条 */
function infoBar(label, pct, cls) {
  var v = parseFloat(pct);
  return '<div class="info-bar"><span style="flex:1;color:var(--text-dim)">' + escapeHtml(label) + '</span><div class="info-bar-track"><div class="info-bar-fill ' + cls + '" style="width:' + Math.min(v, 100) + '%"></div></div><span class="info-val" style="font-size:10px">' + fmt(v) + '%</span></div>';
}

/** 填充 info 面板：分段标题 */
function infoSection(text) {
  return '<div class="info-section">' + text + '</div>';
}

function getColors(count) {
  var c = ['#4cd964','#ff3b30','#ffd700','#64c8ff','#c864ff','#ff9632','#ff6b62','#34c759',
           '#5e5ce6','#ff2d55','#af52de','#ff9f0a','#0a84ff','#30d158','#ff6482','#bf5af2'];
  var r = [];
  for (var i = 0; i < count; i++) r.push(c[i % c.length]);
  return r;
}

// ── 销毁旧图表 ──────────────────────────────────────────────────────
function destroyChart(chart) {
  if (chart && typeof chart.destroy === 'function') {
    try { chart.destroy(); } catch(e) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  图表渲染函数
//  每个函数接收 (canvas, stats, options?) 返回 Chart 实例或 null
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 1. 胜负饼图（总场次比例 + 中心胜率）
 */
function renderWinPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var hasData = (stats.wins + stats.losses + stats.draws + stats.abnormals) > 0;
  if (!hasData) { canvas._chart = null; return null; }
  var total = stats.wins + stats.losses;
  var wr = total > 0 ? (stats.wins / total * 100).toFixed(1) : '0.0';
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['胜', '负', '平局', '异常'],
      datasets: [{
        data: [stats.wins, stats.losses, stats.draws, stats.abnormals],
        backgroundColor: ['#4cd964', '#ff3b30', '#ffd700', '#8888a0'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 12 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var tot = ctx.dataset.data.reduce(function(a,b){return a+b;}, 0);
              return ctx.label + ': ' + ctx.parsed + ' (' + (tot > 0 ? (ctx.parsed/tot*100).toFixed(1) : 0) + '%)';
            }
          }
        }
      }
    },
    plugins: [{
      id: 'winCenterText',
      afterDraw: function(chart) {
        var area = chart.chartArea;
        var cx = (area.left + area.right) / 2;
        var cy = (area.top + area.bottom) / 2;
        var c = chart.ctx;
        c.save();
        c.shadowColor = 'rgba(0,0,0,0.7)';
        c.shadowBlur = 4;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = 'bold 22px monospace';
        c.fillStyle = '#ffffff';
        c.fillText(wr + '%', cx, cy - 6);
        c.font = '11px sans-serif';
        c.fillStyle = '#cccccc';
        c.fillText('总胜率', cx, cy + 16);
        c.restore();
      }
    }]
  });
  // info 面板
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var dw = stats.draws + stats.abnormals;
    info.innerHTML =
      infoRow('总对局', stats.total, 'info') +
      infoRow('胜', stats.wins, 'good') +
      infoRow('负', stats.losses, 'bad') +
      infoRow('平局', stats.draws, 'warn') +
      infoRow('异常', stats.abnormals) +
      infoSection('汇总') +
      infoBar('胜率', wr, winBarCls(wr)) +
      (dw > 0 ? infoRow('平+异常', dw, 'warn') : '');
  }
  return canvas._chart;
}

/**
 * 2. 先后手胜率对比（柱状图 + info面板显示平局/异常）
 */
function renderFirstSecondBar(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var gf = stats.goingFirst, gs = stats.goingSecond;
  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['先手', '后手'],
      datasets: [
        { label: '胜', data: [gf.wins, gs.wins], backgroundColor: '#4cd964', borderRadius: 4 },
        { label: '负', data: [gf.losses, gs.losses], backgroundColor: '#ff3b30', borderRadius: 4 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' } }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#e8e8f0', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            afterBody: function(items) {
              var idx = items[0].dataIndex;
              var wr = idx === 0 ? gf.winRate : gs.winRate;
              return '胜率: ' + wr + '%';
            }
          }
        }
      }
    }
  });
  // info 面板
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    info.innerHTML =
      infoSection('先手') +
      infoRow('胜', gf.wins, 'good') +
      infoRow('负', gf.losses, 'bad') +
      infoRow('平局', gf.draws || 0, 'warn') +
      infoRow('异常', gf.abnormals || 0) +
      infoBar('胜率', gf.winRate || 0, winBarCls(gf.winRate || 0)) +
      infoSection('后手') +
      infoRow('胜', gs.wins, 'good') +
      infoRow('负', gs.losses, 'bad') +
      infoRow('平局', gs.draws || 0, 'warn') +
      infoRow('异常', gs.abnormals || 0) +
      infoBar('胜率', gs.winRate || 0, winBarCls(gs.winRate || 0));
  }
  return canvas._chart;
}

/**
 * 3. 手坑分布（横向柱状图 — 多项可同时发生，不误导互斥比例）
 */
function renderHandtrapPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var ht = stats.handtrap;
  var presets = ht.presets || [];
  var cfg = ht.config || { largeIds: [], compactIds: [] };
  var counts = ht.counts || {};
  var bfAll = ht.byFirstAll || {}, bsAll = ht.bySecondAll || {};

  // 排序：large → compact → other → _other
  var largeIds = (cfg.largeIds || []).filter(function(id) { return presets.some(function(p) { return p.id === id; }); });
  var compactIds = (cfg.compactIds || []).filter(function(id) { return presets.some(function(p) { return p.id === id; }); });
  var otherIds = presets.filter(function(p) { return largeIds.indexOf(p.id) < 0 && compactIds.indexOf(p.id) < 0; }).map(function(p) { return p.id; });
  var orderedIds = largeIds.concat(compactIds).concat(otherIds);
  var visibleIds = largeIds.concat(compactIds);

  var labels = [];
  var values = [];
  visibleIds.forEach(function(id) {
    var p = presets.find(function(x) { return x.id === id; });
    labels.push(p ? p.label : id);
    values.push(counts[id] || 0);
  });
  // _other + 第3级预设数据
  var otherTotal = counts['_other'] || 0;
  otherIds.forEach(function(id) { otherTotal += (counts[id] || 0); });
  labels.push('其他手坑');
  values.push(otherTotal);

  var total = values.reduce(function(a,b){return a+b;}, 0);
  if (total === 0) { canvas._chart = null; return null; }

  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '被吃次数',
        data: values,
        backgroundColor: getColors(labels.length),
        borderRadius: 3
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { precision: 0 } },
        y: { grid: { display: false }, ticks: { font: { size: 9 } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.parsed.x + ' 次 (' + fmt(ctx.parsed.x / stats.total * 100) + '%)';
            }
          }
        }
      }
    }
  });
  // info 面板
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var infoHtml = infoSection('精确计数');
    var visibleIds = largeIds.concat(compactIds);
    visibleIds.forEach(function(id) {
      var p = presets.find(function(x) { return x.id === id; });
      if (!p) return;
      infoHtml += infoRow(p.label, (counts[id]||0) + ' 次');
    });
    infoHtml += infoRow('其他手坑', (counts['_other']||0) + ' 次');
    infoHtml += infoSection('先后手细分');
    visibleIds.forEach(function(id) {
      var p = presets.find(function(x) { return x.id === id; });
      if (!p) return;
      infoHtml += infoRow(p.label, '先 ' + (bfAll[id]||0) + ' / 后 ' + (bsAll[id]||0));
    });
    infoHtml += infoRow('其他手坑', '先 ' + (bfAll['_other']||0) + ' / 后 ' + (bsAll['_other']||0));
    info.innerHTML = infoHtml;
  }
  return canvas._chart;
}

/**
 * 4. 先手终场分布（饼图 + info面板正常率）
 */
function renderEndboardPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var eb = stats.endboard;
  if (!eb || eb.total === 0) { canvas._chart = null; return null; }
  var nPct = eb.total > 0 ? (eb.normal / eb.total * 100) : 0;
  var os = eb.opponentSurrendered || 0;
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['正常终场','妥协场','没做出来','投降','直接胜利'],
      datasets: [{
        data: [eb.normal, eb.compromised, eb.stopped, eb.surrender, os],
        backgroundColor: ['#4cd964','#ffd700','#ff3b30','#8888a0','#64c8ff'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } }
      }
    },
    plugins: [{
      id: 'endboardCenter',
      afterDraw: function(chart) {
        var area = chart.chartArea;
        var cx = (area.left + area.right) / 2;
        var cy = (area.top + area.bottom) / 2;
        var c = chart.ctx;
        c.save();
        // 文字阴影保证在任何色块上都清晰
        c.shadowColor = 'rgba(0,0,0,0.7)';
        c.shadowBlur = 4;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = 'bold 20px monospace';
        c.fillStyle = '#ffffff';
        c.fillText(fmt(nPct) + '%', cx, cy - 6);
        c.font = '11px sans-serif';
        c.fillStyle = '#cccccc';
        c.fillText('正常终场率', cx, cy + 16);
        c.restore();
      }
    }]
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var t = eb.total;
    info.innerHTML =
      infoRow('正常终场', eb.normal + ' (' + fmt(eb.normal/t*100) + '%)', 'good') +
      infoRow('妥协场', eb.compromised + ' (' + fmt(eb.compromised/t*100) + '%)', 'warn') +
      infoRow('没做出来', eb.stopped + ' (' + fmt(eb.stopped/t*100) + '%)', 'bad') +
      infoRow('投降', eb.surrender + ' (' + fmt(eb.surrender/t*100) + '%)') +
      infoRow('直接胜利', os + ' (' + fmt(os/t*100) + '%)', 'info') +
      infoSection('汇总') +
      infoBar('正常终场率', nPct, 'green');
  }
  return canvas._chart;
}

/**
 * 5. 后手突破统计（饼图 + info面板成功率+突破后胜率）
 */
function renderBreakBoardPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var bb = stats.breakBoard;
  if (!bb || (bb.success + bb.failed + bb.surrender + bb.notNeeded) === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['突破成功','突破失败','投降','不需要'],
      datasets: [{
        data: [bb.success, bb.failed, bb.surrender, bb.notNeeded],
        backgroundColor: ['#4cd964','#ff3b30','#8888a0','#64c8ff'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } }
      }
    },
    plugins: [{
      id: 'breakCenter',
      afterDraw: function(chart) {
        var sr = parseFloat(bb.successRate) || 0;
        var area = chart.chartArea;
        var cx = (area.left + area.right) / 2;
        var cy = (area.top + area.bottom) / 2;
        var c = chart.ctx;
        c.save();
        c.shadowColor = 'rgba(0,0,0,0.7)';
        c.shadowBlur = 4;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = 'bold 18px monospace';
        c.fillStyle = '#ffffff';
        c.fillText(fmt(sr) + '%', cx, cy - 6);
        c.font = '11px sans-serif';
        c.fillStyle = '#cccccc';
        c.fillText('突破成功率', cx, cy + 16);
        c.restore();
      }
    }]
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var totalSecond = bb.total;
    var swr = parseFloat(bb.successWinRate) || 0;
    var sr = parseFloat(bb.successRate) || 0;
    info.innerHTML =
      infoRow('突破成功', bb.success, 'good') +
      infoRow('突破失败', bb.failed, 'bad') +
      infoRow('后手投降', bb.surrender) +
      infoRow('不需要突破', bb.notNeeded, 'info') +
      infoSection('汇总') +
      infoBar('突破成功率', sr, 'gold') +
      infoRow('', '(' + bb.success + '/' + totalSecond + ')') +
      (bb.success > 0 ? infoBar('突破后胜率', swr, winBarCls(swr)) : '') +
      (bb.success > 0 ? infoRow('', '(' + bb.successWins + '/' + bb.success + ')') : '');
  }
  return canvas._chart;
}

/**
 * 6. 胜率趋势（折线图 + info面板总体胜率/最近场次）
 */
function renderWinTrendLine(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var history = stats.resultHistory || [];
  // 过滤出有胜负的对局
  var results = [];
  for (var i = 0; i < history.length; i++) {
    var r = history[i];
    if (r === 'win' || r === 'loss') results.push(r);
  }
  if (results.length < 2) { canvas._chart = null; return null; }

  // 计算每场的累计胜率
  var points = [];
  var wins = 0;
  for (var i = 0; i < results.length; i++) {
    if (results[i] === 'win') wins++;
    points.push({ label: '#' + (i + 1), rate: (wins / (i + 1) * 100).toFixed(1) });
  }
  // 标签太多时只显示部分
  var labelStep = points.length > 60 ? Math.ceil(points.length / 30) : 1;
  var chartLabels = points.map(function(p, idx) { return idx % labelStep === 0 ? p.label : ''; });
  var chartData = points.map(function(p){return parseFloat(p.rate);});

  canvas._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [{
        label: '胜率',
        data: chartData,
        borderColor: '#ffc832',
        backgroundColor: 'rgba(255,200,50,0.1)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#ffc832',
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: function(v){return v+'%';} } },
        x: { grid: { display: false }, ticks: { display: false } }
      },
      plugins: {
        legend: { display: false }
      }
    },
    plugins: [{
      id: 'chartBg',
      beforeDraw: function(chart) {
        var ctx = chart.ctx;
        var area = chart.chartArea;
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(area.left, area.top, area.width, area.height);
        ctx.restore();
      }
    }]
  });

  // info 面板：总体胜率 + 最近场次明细
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var winsTotal = 0;
    for (var i = 0; i < results.length; i++) { if (results[i] === 'win') winsTotal++; }
    var detailHtml = '';
    // 最近 20 场胜负小圆点
    var lastN = Math.min(20, results.length);
    for (var j = results.length - 1; j >= results.length - lastN; j--) {
      var icon = results[j] === 'win' ? 'W' : 'L';
      var bg = results[j] === 'win' ? '#4cd964' : '#ff3b30';
      var tc = results[j] === 'win' ? '#000' : '#fff';
      detailHtml += '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;font-size:8px;font-weight:700;margin:1px;background:' + bg + ';color:' + tc + '">' + icon + '</span>';
    }
    var wr = (winsTotal / results.length * 100).toFixed(1);
    info.innerHTML =
      infoRow('总胜率', wr + '%', parseFloat(wr) >= 50 ? 'good' : 'bad') +
      infoRow('总场次', results.length + ' 场', '') +
      infoRow('胜/负', winsTotal + ' / ' + (results.length - winsTotal), '') +
      infoSection('最近 ' + lastN + ' 场') +
      '<div style="display:flex;flex-wrap:wrap;gap:1px;margin-top:2px">' + detailHtml + '</div>';
  }
  return canvas._chart;
}

/**
 * 6b. 硬币胜率趋势（折线图：先手 vs 后手累计胜率）
 */
function renderCoinTrendLine(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var history = stats.coinHistory || [];
  if (history.length < 2) { canvas._chart = null; return null; }

  // 计算每个点的累计硬币胜率
  var points = [];
  var cw = 0;
  for (var i = 0; i < history.length; i++) {
    if (history[i].coinToss === true) cw++;
    points.push({ label: '#' + (i + 1), rate: (cw / (i + 1) * 100).toFixed(1) });
  }
  // 标签太多时只显示部分
  var labelStep = points.length > 60 ? Math.ceil(points.length / 30) : 1;
  var chartLabels = points.map(function(p, idx) { return idx % labelStep === 0 ? p.label : ''; });
  var chartData = points.map(function(p){return parseFloat(p.rate);});

  canvas._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [{
        label: '硬币胜率',
        data: chartData,
        borderColor: '#ffd700',
        backgroundColor: 'rgba(255,215,0,0.1)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#ffd700',
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { stepSize: 10, callback: function(v){return v+'%';} } },
        x: { grid: { display: false }, ticks: { display: false } }
      },
      plugins: { legend: { display: false } }
    },
    plugins: [{
      id: 'chartBg',
      beforeDraw: function(chart) {
        var ctx = chart.ctx;
        var area = chart.chartArea;
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(area.left, area.top, area.width, area.height);
        ctx.restore();
      }
    }, {
      id: 'fiftyLine',
      afterDraw: function(chart) {
        var yScale = chart.scales.y;
        var xScale = chart.scales.x;
        var y = yScale.getPixelForValue(50);
        var ctx = chart.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.moveTo(xScale.left, y);
        ctx.lineTo(xScale.right, y);
        ctx.stroke();
        ctx.restore();
      }
    }]
  });

  // info 面板
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var cwTotal = 0;
    var detailHtml = '';
    // 最近 20 场显示为小圆点
    var lastN = Math.min(20, history.length);
    for (var j = history.length - 1; j >= history.length - lastN; j--) {
      var r = history[j];
      if (r.coinToss === true) cwTotal++;
      var bg = r.coinToss === true ? '#ffd700' : 'rgba(255,255,255,0.12)';
      var tc = r.coinToss === true ? '#000' : '#e8e8f0';
      detailHtml += '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;font-size:7px;font-weight:700;margin:1px;background:' + bg + ';color:' + tc + '">' + (r.coinToss === true ? '正' : '反') + '</span>';
    }
    // 补全剩余场次的正数
    for (var j = history.length - lastN - 1; j >= 0; j--) {
      if (history[j].coinToss === true) cwTotal++;
    }
    var cwr = (cwTotal / history.length * 100).toFixed(1);
    info.innerHTML =
      infoRow('总硬币胜率', cwr + '%', parseFloat(cwr) >= 50 ? 'good' : 'bad') +
      infoRow('总场次', history.length + ' 场', '') +
      infoRow('正/反', cwTotal + ' / ' + (history.length - cwTotal), '') +
      infoSection('最近 ' + lastN + ' 场（金色=正 灰色=反）') +
      '<div style="display:flex;flex-wrap:wrap;gap:1px;margin-top:2px">' + detailHtml + '</div>';
  }
  return canvas._chart;
}

/**
 * 7. 自用卡组胜率排行（横向柱状图 + tooltip含W/L）
 */
function renderDeckBar(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var decks = stats.myDeckStats || [];
  if (decks.length === 0) { canvas._chart = null; return null; }
  var top = decks.slice(0, 10);
  var labels = top.map(function(d){return d.deck;});
  var winRates = top.map(function(d){return parseFloat(d.winRate);});
  var counts = top.map(function(d){return d.total;});
  var wins = top.map(function(d){return d.wins;});
  var losses = top.map(function(d){return d.losses;});

  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '胜率',
        data: winRates,
        backgroundColor: winRates.map(function(v){return v >= 50 ? '#4cd964' : '#ff3b30';}),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: function(v){return v+'%';} } },
        y: { grid: { display: false }, ticks: { font: { size: 10, family: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif" } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: function(ctx) {
              var i = ctx.dataIndex;
              return '场次: ' + counts[i] + ' | W: ' + wins[i] + ' L: ' + losses[i];
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 8. 连胜状态指示（仪表盘风格）
 */
function renderStreakGauge(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var streak = stats.currentStreak;
  if (!streak || streak.count === 0) { canvas._chart = null; return null; }
  var isWin = streak.type === 'win';
  var c = isWin ? '#4cd964' : '#ff3b30';

  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: [isWin ? '连胜' : '连败', ''],
      datasets: [{
        data: [streak.count, Math.max(streak.count, 5)],
        backgroundColor: [c, 'rgba(255,255,255,0.12)'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '75%',
      rotation: -90,
      circumference: 180,
      plugins: {
        legend: { display: false }
      }
    },
    plugins: [{
      id: 'centerText',
      afterDraw: function(chart) {
        var w = chart.width, h = chart.height;
        var ctx2 = chart.ctx;
        ctx2.save();
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        ctx2.font = 'bold 28px monospace';
        ctx2.fillStyle = c;
        ctx2.fillText(streak.count + (isWin ? '🔥' : '💧'), w / 2, h / 2 - 6);
        ctx2.font = '13px sans-serif';
        ctx2.fillStyle = '#e8e8f0';
        ctx2.fillText(isWin ? '连胜' : '连败', w / 2, h / 2 + 20);
        ctx2.restore();
      }
    }]
  });
  return canvas._chart;
}

/**
 * 9. 硬币统计（饼图 + info面板胜率+占比）
 */
function renderCoinPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var c = stats.coin || { total: 0, wins: 0, losses: 0 };
  if (c.total === 0) { canvas._chart = null; return null; }
  var cWR = (c.wins + c.losses) > 0 ? (c.wins / (c.wins + c.losses) * 100).toFixed(1) : '0.0';
  var cRatio = stats.total > 0 ? (c.total / stats.total * 100).toFixed(1) : '0.0';
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['硬币正', '硬币反'],
      datasets: [{
        data: [c.wins, c.losses],
        backgroundColor: ['#ffd700', '#8888a0'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var total = ctx.dataset.data.reduce(function(a,b){return a+b;}, 0);
              return ctx.label + ': ' + ctx.parsed + ' (' + (total > 0 ? (ctx.parsed/total*100).toFixed(1) : 0) + '%)';
            }
          }
        }
      }
    },
    plugins: [{
      id: 'coinCenter',
      afterDraw: function(chart) {
        var area = chart.chartArea;
        var cx = (area.left + area.right) / 2;
        var cy = (area.top + area.bottom) / 2;
        var c2 = chart.ctx;
        c2.save();
        c2.shadowColor = 'rgba(0,0,0,0.7)';
        c2.shadowBlur = 4;
        c2.textAlign = 'center';
        c2.textBaseline = 'middle';
        c2.font = 'bold 22px monospace';
        c2.fillStyle = '#ffffff';
        c2.fillText(cWR + '%', cx, cy - 6);
        c2.font = '11px sans-serif';
        c2.fillStyle = '#cccccc';
        c2.fillText('硬币胜率', cx, cy + 16);
        c2.restore();
      }
    }]
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    info.innerHTML =
      infoRow('硬币正', c.wins, 'good') +
      infoRow('硬币反', c.losses, 'bad') +
      infoRow('硬币局数', c.total + ' 场', 'info') +
      infoRow('占总对局', cRatio + '%') +
      infoSection('汇总') +
      infoBar('硬币胜率', cWR, winBarCls(cWR));
  }
  return canvas._chart;
}

/**
 * 9b. 硬币异常检测（双项水平柱状图：连续异常率 + 偏斜异常率）
 */
function renderCoinAnomaly(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var c = stats.coin || {};
  if (!c.streak && (!c.bias || c.bias.severity === '—')) { canvas._chart = null; return null; }
  // 数据准备
  var hasStreak = !!c.streak;
  var hasBias = !!(c.bias && c.bias.severity !== '—');
  var labels = [];
  var values = [];
  var colors = [];
  if (hasStreak) {
    labels.push('连续异常');
    values.push(c.streak.severityScore);
    colors.push(c.streak.severityScore > 50 ? '#ff6b62' : (c.streak.severityScore > 20 ? '#ffd700' : '#4cd964'));
  }
  if (hasBias) {
    labels.push('偏斜异常');
    values.push(c.bias.severityScore);
    colors.push(c.bias.severityScore > 50 ? '#ff6b62' : (c.bias.severityScore > 20 ? '#ffd700' : '#4cd964'));
  }
  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: colors,
        borderWidth: 1,
        borderRadius: 4,
        barPercentage: 0.5
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { stepSize: 20, callback: function(v){return v+'%';}, color: '#ffffff' } },
        y: { grid: { display: false }, ticks: { color: '#ffffff', font: { size: 12, weight: 'bold' } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var idx = ctx.dataIndex;
              var sev = hasStreak && idx === 0 ? c.streak.severity : (hasBias ? c.bias.severity : '');
              return ctx.raw + '% · ' + sev;
            }
          }
        }
      }
    },
    plugins: [{
      id: 'barLabels',
      afterDatasetsDraw: function(chart) {
        var ctx2 = chart.ctx;
        var meta = chart.getDatasetMeta(0);
        ctx2.save();
        ctx2.textAlign = 'right';
        ctx2.textBaseline = 'middle';
        ctx2.font = 'bold 13px monospace';
        meta.data.forEach(function(bar, i) {
          var val = values[i];
          var sev = hasStreak && i === 0 ? c.streak.severity : (hasBias ? c.bias.severity : '');
          // 分数：白色大字 + 深色阴影
          ctx2.fillStyle = '#ffffff';
          ctx2.shadowColor = 'rgba(0,0,0,0.8)';
          ctx2.shadowBlur = 4;
          ctx2.fillText(val + '%', bar.x - 6, bar.y - 2);
          ctx2.shadowBlur = 0;
          // 严重度标签：加大加粗 + 半透明底色衬托
          ctx2.font = 'bold 12px sans-serif';
          ctx2.shadowColor = 'rgba(0,0,0,0.8)';
          ctx2.shadowBlur = 3;
          ctx2.fillStyle = '#ffffff';
          ctx2.fillText(sev, bar.x - 6, bar.y + 15);
          ctx2.shadowBlur = 0;
          ctx2.font = 'bold 13px monospace';
        });
        ctx2.restore();
      }
    }]
  });
  // info 面板
  var infoEl = options && options.infoEl;
  if (infoEl) {
    var s = c.streak;
    var b = c.bias;
    var curLabel = function(v) { return v === true ? '正' : (v === false ? '反' : '—'); };
    var html = '';
    if (s) {
      html += infoSection('连续异常检测');
      html += infoRow('最长连续', curLabel(s.longest.type) + ' × ' + s.longest.length);
      if (s.current) html += infoRow('当前连续', curLabel(s.current.type) + ' × ' + s.current.length);
      html += infoRow('纯随机上限', '~' + s.expectedMax + '连');
      html += infoBar('异常率', s.severityScore, s.severityScore > 50 ? 'red' : (s.severityScore > 20 ? 'gold' : 'green'));
    }
    if (b && b.severity !== '—') {
      html += infoSection('偏斜异常检测');
      html += infoRow('正:反', b.heads + ':' + b.tails + ' (期望 1:1)');
      html += infoRow('正面率', b.pct + '%');
      html += infoBar('异常率', b.severityScore, b.severityScore > 50 ? 'red' : (b.severityScore > 20 ? 'gold' : 'green'));
    }
    infoEl.innerHTML = html;
  }
  return canvas._chart;
}

/**
 * 10. 卡手原因分布（横向柱状图 — 卡废件/卡同名牌/卡后手牌）
 */
function renderHandStatePie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var hs = stats.handState || {};
  var labels = ['卡废件','卡同名牌','卡后手牌'];
  var values = [hs.cantPlayGarnet||0, hs.cantPlayDuplicate||0, hs.cantPlayHT||0];
  var total = values.reduce(function(a,b){return a+b;}, 0);
  if (total === 0) { canvas._chart = null; return null; }
  // 改用柱状图：每种原因独立展示发生次数
  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '次数',
        data: values,
        backgroundColor: getColors(3),
        borderRadius: 3
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { precision: 0 } },
        y: { grid: { display: false }, ticks: { font: { size: 9 } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.parsed.x + ' 次 (' + fmt(ctx.parsed.x / (stats.total||1) * 100) + '%)';
            }
          }
        }
      }
    }
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var bf = hs.byFirst || {}, bs = hs.bySecond || {};
    var gft = hs.gfTotal || 0, gst = hs.gsTotal || 0;
    var fmtRate = function(n, d) { return d > 0 ? ((n/d)*100).toFixed(1)+'%' : '—'; };
    info.innerHTML =
      infoSection('卡手原因') +
      infoRow('卡废件', (hs.cantPlayGarnet||0) + '  先 ' + (bf.cantPlayGarnet||0) + '/' + gft + '  后 ' + (bs.cantPlayGarnet||0) + '/' + gst) +
      infoRow('卡同名牌', (hs.cantPlayDuplicate||0) + '  先 ' + (bf.cantPlayDuplicate||0) + '/' + gft + '  后 ' + (bs.cantPlayDuplicate||0) + '/' + gst) +
      infoRow('卡后手牌', (hs.cantPlayHT||0) + '  先 ' + (bf.cantPlayHT||0) + '/' + gft + '  后 ' + (bs.cantPlayHT||0) + '/' + gst) +
      infoRow('互卡', (hs.bothStuck||0) + '  先 ' + (bf.bothStuck||0) + '/' + gft + '  后 ' + (bs.bothStuck||0) + '/' + gst) +
      infoSection('完全动不了') +
      infoRow('完全动不了', (hs.cantPlay||0) + '  先 ' + (bf.cantPlay||0) + ' · 后 ' + (bs.cantPlay||0)) +
      infoSection('卡手率') +
      infoBar('全局', hs.cantPlayRate, 'red') +
      infoBar('先手', fmtRate(bf.totalCantPlay, gft), 'gold') +
      infoBar('后手', fmtRate(bs.totalCantPlay, gst), 'gold') +
      // ── 各卡组卡手明细 ──
      (hs.byDeck && hs.byDeck.length > 0 ? (function() {
        var h = infoSection('各卡组卡手率');
        hs.byDeck.forEach(function(d) {
          var rate = parseFloat(d.cantPlayRate) || 0;
          h += infoBar(d.deck, rate, rate > 30 ? 'red' : (rate > 15 ? 'gold' : 'green'));
        });
        return h;
      })() : '');
  }
  return canvas._chart;
}

/**
 * 10b. 完全动不了统计（横向柱状图）
 */
function renderDealerScrewed(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var hs = stats.handState || {};
  var labels = ['完全动不了'];
  var values = [hs.cantPlay||0];
  var total = values.reduce(function(a,b){return a+b;}, 0);
  if (total === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '次数',
        data: values,
        backgroundColor: getColors(1),
        borderRadius: 3
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { precision: 0 } },
        y: { grid: { display: false }, ticks: { font: { size: 9 } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.parsed.x + ' 次 (' + fmt(ctx.parsed.x / (stats.total||1) * 100) + '%)';
            }
          }
        }
      }
    }
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var bf = hs.byFirst || {}, bs = hs.bySecond || {};
    var totalScrewed = (hs.cantPlay||0) + (hs.bothStuck||0);
    var cantPlayRate = stats.total > 0 ? ((hs.cantPlay||0) / stats.total * 100) : 0;
    var bothStuckRate = stats.total > 0 ? ((hs.bothStuck||0) / stats.total * 100) : 0;
    var totalRate = stats.total > 0 ? (totalScrewed / stats.total * 100) : 0;
    info.innerHTML =
      infoRow('完全动不了', (hs.cantPlay||0) + '  先 ' + (bf.cantPlay||0) + ' · 后 ' + (bs.cantPlay||0)) +
      infoRow('互卡', (hs.bothStuck||0) + '  先 ' + (bf.bothStuck||0) + ' · 后 ' + (bs.bothStuck||0)) +
      infoSection('汇总') +
      infoBar('完全动不了率', cantPlayRate, 'red') +
      infoBar('互卡率', bothStuckRate, 'gold') +
      infoRow('合计次数', totalScrewed) +
      infoBar('占总对局', totalRate, 'red');
  }
  return canvas._chart;
}

/**
 * 11. 严重失误统计（饼图 + info面板含失误率/胜率/按卡组分布）
 */
function renderMistakeDoughnut(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var m = stats.mistake || { total: 0 };
  var noMistake = Math.max(0, (stats.wins||0) + (stats.losses||0) - m.total);
  if (m.total === 0 && noMistake === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['有失误', '无失误'],
      datasets: [{
        data: [m.total, noMistake],
        backgroundColor: ['#ff3b30', '#4cd964'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            afterBody: function() {
              return '失误率: ' + fmt(m.rate) + '%\n失误时胜率: ' + fmt(m.winRate) + '%';
            }
          }
        }
      }
    }
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var ihtml =
      infoRow('有失误', m.total, 'bad') +
      infoRow('无失误', noMistake, 'good') +
      infoSection('汇总') +
      infoBar('失误率', m.rate || 0, 'red') +
      infoBar('失误时胜率', m.winRate || 0, winBarCls(m.winRate || 0));
    // 按卡组分布
    if (m.byDeck && m.byDeck.length > 0) {
      ihtml += infoSection('按卡组分布');
      var topDecks = m.byDeck.slice(0, 6);
      for (var i = 0; i < topDecks.length; i++) {
        var d = topDecks[i];
        var dwr = (d.wins + d.losses) > 0 ? (d.wins / (d.wins + d.losses) * 100).toFixed(1) : '0.0';
        ihtml += infoRow(d.deck, d.total + ' 次 (' + dwr + '%)');
      }
    }
    info.innerHTML = ihtml;
  }
  return canvas._chart;
}

/**
 * 12. 对手 T0 动统计（饼图 + info面板含胜率/按卡组分布）
 */
function renderOpponentT0Doughnut(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var t = stats.opponentT0 || { total: 0, wins: 0, losses: 0 };
  var noT0 = Math.max(0, (stats.total||0) - t.total);
  if (t.total === 0 && noT0 === 0) { canvas._chart = null; return null; }
  var t0Wr = (t.wins + t.losses) > 0 ? ((t.wins / (t.wins + t.losses)) * 100).toFixed(1) : '0.0';
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['被T0动', '未被T0'],
      datasets: [{
        data: [t.total, noT0],
        backgroundColor: ['#ff9632', '#4cd964'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            afterBody: function() {
              return '被T0动时胜率: ' + t0Wr + '%';
            }
          }
        }
      }
    }
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var ihtml =
      infoRow('被T0动', t.total, 'bad') +
      infoRow('未被T0', noT0, 'good') +
      infoSection('被T0时') +
      infoRow('胜', t.wins, 'good') +
      infoRow('负', t.losses, 'bad') +
      infoBar('胜率', t0Wr, winBarCls(t0Wr));
    // 按卡组分布
    if (t.byDeck && t.byDeck.length > 0) {
      ihtml += infoSection('遇到T0动最多的对手卡组');
      var topD = t.byDeck.slice(0, 5);
      for (var i = 0; i < topD.length; i++) {
        ihtml += infoRow(topD[i].deck, topD[i].total + ' 次');
      }
    }
    info.innerHTML = ihtml;
  }
  return canvas._chart;
}

/**
 * 13. 吓跑对手（仪表盘 + info面板含率和按卡组分布）
 */
function renderOpponentRanGauge(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var or = stats.opponentRan || { total: 0 };
  if (or.total === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['吓跑对手', ''],
      datasets: [{
        data: [or.total, Math.max(or.total, 5)],
        backgroundColor: ['#ff9632', 'rgba(255,255,255,0.12)'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '75%',
      rotation: -90, circumference: 180,
      plugins: { legend: { display: false } }
    },
    plugins: [{
      id: 'centerText',
      afterDraw: function(chart) {
        var w = chart.width, h = chart.height;
        var ctx2 = chart.ctx;
        ctx2.save();
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        ctx2.font = 'bold 32px monospace';
        ctx2.fillStyle = '#ff9632';
        ctx2.fillText(or.total + '🏃', w / 2, h / 2 - 6);
        ctx2.font = '13px sans-serif';
        ctx2.fillStyle = '#e8e8f0';
        ctx2.fillText('吓跑对手', w / 2, h / 2 + 20);
        ctx2.restore();
      }
    }]
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var ranRate = stats.total > 0 ? (or.total / stats.total * 100) : 0;
    var ihtml =
      infoRow('吓跑次数', or.total + ' 次', 'warn') +
      infoBar('占总对局比', ranRate, 'gold');
    // 先手细分
    if (or.firstTotal > 0) {
      var fe = or.firstEndboard;
      ihtml += infoSection('先手·跑时终场状况');
      ihtml += infoRow('正常终场后跑了', fe.normal + ' 次');
      ihtml += infoRow('妥协场后跑了', fe.compromised + ' 次');
      ihtml += infoRow('没做出来对方跑了', fe.stopped + ' 次');
    }
    // 后手细分
    if (or.secondTotal > 0) {
      var sb = or.secondBroke;
      ihtml += infoSection('后手·跑时突破状况');
      ihtml += infoRow('不须突破直接跑了', sb.notNeeded + ' 次');
      ihtml += infoRow('成功突破后跑了', sb.success + ' 次');
      ihtml += infoRow('没突破成功也跑了', sb.failed + ' 次');
    }
    // 按卡组分布
    if (or.byDeck && or.byDeck.length > 0) {
      ihtml += infoSection('按自用卡组');
      var topD = or.byDeck.slice(0, 5);
      for (var i = 0; i < topD.length; i++) {
        ihtml += infoRow(topD[i].deck, topD[i].count + ' 次');
      }
    }
    info.innerHTML = ihtml;
  }
  return canvas._chart;
}

/**
 * 14. 提丰趣味统计（饼图 + info面板含汇总）
 */
function renderTyphonPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var t = stats.typhon || { total: 0, enemyBlack: 0, enemyWhite: 0, selfBlack: 0, selfWhite: 0 };
  if (t.total === 0) { canvas._chart = null; return null; }
  var blackened = t.enemyBlack + t.selfBlack;
  var whitened = t.enemyWhite + t.selfWhite;
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['对手出🖤输', '对手出🤍赢', '自己出🖤输', '自己出🤍赢'],
      datasets: [{
        data: [t.enemyBlack, t.enemyWhite, t.selfBlack, t.selfWhite],
        backgroundColor: ['#ff3b30', '#4cd964', '#8888a0', '#64c8ff'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 10 }, padding: 6 } }
      }
    }
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    info.innerHTML =
      infoRow('提丰登场', t.total + ' 次', 'info') +
      infoSection('🖤 提丰被黑') +
      infoRow('合计', blackened + ' 次', 'bad') +
      infoRow('对手出输', t.enemyBlack) +
      infoRow('自己出输', t.selfBlack) +
      infoSection('🤍 提丰漂白') +
      infoRow('合计', whitened + ' 次', 'good') +
      infoRow('对手出赢', t.enemyWhite) +
      infoRow('自己出赢', t.selfWhite);
  }
  return canvas._chart;
}

/**
 * 15. 对战卡组胜率排行（横向柱状图 + tooltip含W/L）
 */
function renderOppDeckBar(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var decks = stats.deckStats || [];
  if (decks.length === 0) { canvas._chart = null; return null; }
  var top = decks.slice(0, 10);
  var labels = top.map(function(d){return d.deck;});
  var winRates = top.map(function(d){return parseFloat(d.winRate);});
  var counts = top.map(function(d){return d.total;});
  var wins = top.map(function(d){return d.wins;});
  var losses = top.map(function(d){return d.losses;});
  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '胜率',
        data: winRates,
        backgroundColor: winRates.map(function(v){return v >= 50 ? '#4cd964' : '#ff3b30';}),
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: {
        x: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: function(v){return v+'%';} } },
        y: { grid: { display: false }, ticks: { font: { size: 10, family: "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif" } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: function(ctx) {
              var i = ctx.dataIndex;
              return '场次: ' + counts[i] + ' | W: ' + wins[i] + ' L: ' + losses[i];
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 16. 连接异常统计（饼图 + info面板掉线率）
 */
function renderDisconnectPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var con = stats.connectivity || {};
  var dSelf = con.disconnectSelf || 0;
  var dOpp = con.disconnectOpponent || 0;
  var totalDC = dSelf + dOpp;
  if (totalDC === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['自己掉线', '对手掉线'],
      datasets: [{
        data: [dSelf, dOpp],
        backgroundColor: ['#ff3b30', '#ffd700'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var tot = ctx.dataset.data.reduce(function(a,b){return a+b;}, 0);
              return ctx.label + ': ' + ctx.parsed + ' (' + (tot > 0 ? (ctx.parsed/tot*100).toFixed(1) : 0) + '%)';
            }
          }
        }
      }
    }
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var dRate = con.disconnectRate || (stats.total > 0 ? (totalDC / stats.total * 100) : 0);
    info.innerHTML =
      infoRow('掉线次数', totalDC + ' 次', 'bad') +
      infoBar('掉线率', dRate, 'red') +
      infoRow('自己掉线', dSelf + ' 次') +
      infoRow('对手掉线', dOpp + ' 次');
  }
  return canvas._chart;
}

/**
 * 17. 超时统计（饼图 + info面板超时率+按卡组分布）
 */
function renderTimeoutPie(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var con = stats.connectivity || {};
  var tSelf = con.timeoutSelf || 0;
  var tOpp = con.timeoutOpponent || 0;
  var totalTO = tSelf + tOpp;
  if (totalTO === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['自己超时', '对手超时'],
      datasets: [{
        data: [tSelf, tOpp],
        backgroundColor: ['#c864ff', '#64c8ff'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var tot = ctx.dataset.data.reduce(function(a,b){return a+b;}, 0);
              return ctx.label + ': ' + ctx.parsed + ' (' + (tot > 0 ? (ctx.parsed/tot*100).toFixed(1) : 0) + '%)';
            }
          }
        }
      }
    }
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var tRate = con.timeoutRate || (stats.total > 0 ? (totalTO / stats.total * 100) : 0);
    var ihtml =
      infoRow('超时次数', totalTO + ' 次', 'warn') +
      infoBar('超时率', tRate, 'gold') +
      infoRow('自己超时', tSelf + ' 次') +
      infoRow('对手超时', tOpp + ' 次');
    // 按卡组分布
    if (con.timeoutSelfByDeck && con.timeoutSelfByDeck.length > 0) {
      ihtml += infoSection('自己超时卡组');
      var top = con.timeoutSelfByDeck.slice(0, 4);
      for (var i = 0; i < top.length; i++) {
        ihtml += infoRow(top[i].deck, top[i].count + ' 次');
      }
    }
    if (con.timeoutOppByDeck && con.timeoutOppByDeck.length > 0) {
      ihtml += infoSection('对手超时卡组');
      var top2 = con.timeoutOppByDeck.slice(0, 4);
      for (var j = 0; j < top2.length; j++) {
        ihtml += infoRow(top2[j].deck, top2[j].count + ' 次');
      }
    }
    info.innerHTML = ihtml;
  }
  return canvas._chart;
}

/**
 * 18. 对手大牌统计（仪表盘 + info面板占比）
 */
function renderBigHandGauge(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var bh = stats.bigHand || { total: 0 };
  if (bh.total === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['遇到大牌哥', ''],
      datasets: [{
        data: [bh.total, Math.max(bh.total, 5)],
        backgroundColor: ['#ff2d55', 'rgba(255,255,255,0.12)'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '75%',
      rotation: -90, circumference: 180,
      plugins: { legend: { display: false } }
    },
    plugins: [{
      id: 'centerText',
      afterDraw: function(chart) {
        var w = chart.width, h = chart.height;
        var ctx2 = chart.ctx;
        ctx2.save();
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        ctx2.font = 'bold 32px monospace';
        ctx2.fillStyle = '#ff2d55';
        ctx2.fillText(bh.total + '🃏', w / 2, h / 2 - 6);
        ctx2.font = '13px sans-serif';
        ctx2.fillStyle = '#e8e8f0';
        ctx2.fillText('遇到大牌哥', w / 2, h / 2 + 20);
        ctx2.restore();
      }
    }]
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var bhRate = stats.total > 0 ? (bh.total / stats.total * 100) : 0;
    var hs = stats.handState || {};
    info.innerHTML =
      infoRow('遇到大牌哥次数', bh.total + ' 次', 'bad') +
      infoBar('占总对局比', bhRate, 'red') +
      infoSection('先后手细分') +
      infoRow('先手', bh.first + ' 次') +
      infoRow('后手', bh.second + ' 次') +
      infoSection('关联统计') +
      infoRow('自己卡手次数', ((hs.cantPlay||0) + (hs.cantPlayGarnet||0) + (hs.cantPlayDuplicate||0) + (hs.cantPlayHT||0)) + ' 次');
  }
  return canvas._chart;
}

/**
 * 19. 概览大数字（无图表，纯数字展示）
 */
function renderHero(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var total = stats.total || 0;
  var wins = stats.wins || 0;
  var losses = stats.losses || 0;
  var draws = stats.draws || 0;
  var abnormals = stats.abnormals || 0;
  var dw = draws + abnormals;
  var wr = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : '0.0';
  if (total === 0) { canvas._chart = null; return null; }

  // 清除 canvas，改为纯 HTML 展示
  var parent = canvas.parentNode;
  canvas.style.display = 'none';
  parent.innerHTML =
    '<div class="hero-grid">' +
      '<div class="hero-box total"><div class="hero-val">' + total + '</div><div class="hero-lbl">总对局</div></div>' +
      '<div class="hero-box wins-box"><div class="hero-val">' + wins + '</div><div class="hero-lbl">胜场</div></div>' +
      '<div class="hero-box losses-box"><div class="hero-val">' + losses + '</div><div class="hero-lbl">负场</div></div>' +
      '<div class="hero-box draws-box"><div class="hero-val">' + dw + '</div><div class="hero-lbl">平局+异常</div></div>' +
      '<div class="hero-box rate-box"><div class="hero-val">' + wr + '%</div><div class="hero-lbl">总胜率</div></div>' +
    '</div>';
  return null;
}

/**
 * 21. 互卡子选项详情（纯信息展示）
 */
function renderBothStuckDetail(canvas, stats, options) {
  destroyChart(canvas._chart);
  var hs = stats.handState || {};
  var bd = hs.bothStuckDetail;
  var ctx = canvas.getContext('2d');
  if (!bd || bd.total === 0) { canvas._chart = null; return null; }
  var parent = canvas.parentNode;
  canvas.style.display = 'none';
  parent.innerHTML =
    '<div style="padding:10px;text-align:center">' +
      '<div style="font-size:28px;font-weight:700;color:#ffd700">' + bd.total + '</div>' +
      '<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px">互卡总次数</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:8px">' +
        '<div style="font-size:13px;color:#4cd964;margin-bottom:4px">有人先动 ' + bd.firstMove + ' 次</div>' +
        '<div style="font-size:11px;color:var(--text-dim)">　自己 ' + bd.firstMoveSelf + ' · 对方 ' + bd.firstMoveOpp + '</div>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:6px;margin-top:4px">' +
        '<div style="font-size:13px;color:#ff6b62;margin-bottom:4px">有人投降 ' + bd.surrender + ' 次</div>' +
        '<div style="font-size:11px;color:var(--text-dim)">　自己投降 ' + bd.surrenderSelf + ' · 对方投降 ' + bd.surrenderOpp + '</div>' +
      '</div>' +
      (bd.other > 0 ? '<div style="border-top:1px solid var(--border);padding-top:6px;margin-top:4px"><div style="font-size:13px;color:#64c8ff">其他 ' + bd.other + ' 次</div></div>' : '') +
    '</div>';
  return null;
}

/**
 * 20. 抽干牌组统计（仪表盘 + info面板）
 */
function renderDeckOutChart(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var d = stats.deckOut;
  if (!d || d.total === 0) { canvas._chart = null; return null; }

  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['抽干对手', '自己抽干'],
      datasets: [{
        data: [d.opponent, d.self],
        backgroundColor: ['#4cd964', '#ff3b30'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 11 }, padding: 10 } }
      }
    },
    plugins: [{
      id: 'deckoutCenter',
      afterDraw: function(chart) {
        var area = chart.chartArea;
        var cx = (area.left + area.right) / 2;
        var cy = (area.top + area.bottom) / 2;
        var c = chart.ctx;
        c.save();
        c.shadowColor = 'rgba(0,0,0,0.7)';
        c.shadowBlur = 4;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = 'bold 24px monospace';
        c.fillStyle = '#ffffff';
        c.fillText(d.total + '', cx, cy - 6);
        c.font = '12px sans-serif';
        c.fillStyle = '#cccccc';
        c.fillText('抽干总次数', cx, cy + 16);
        c.restore();
      }
    }]
  });
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    info.innerHTML =
      infoRow('抽干总次数', d.total + ' 次', 'info') +
      infoRow('抽干对手', d.opponent + ' 次', 'good') +
      infoRow('自己抽干', d.self + ' 次', 'bad');
  }
  return canvas._chart;
}

/**
 * 21. 对阵交叉统计（分组横向柱状图 — 按对手卡组显示各卡组胜率）
 */
function renderMatchupChart(canvas, stats, options) {
  destroyChart(canvas._chart);
  var matchupStats = stats.matchupStats;
  if (!matchupStats || matchupStats.length === 0) { canvas._chart = null; return null; }

  // 按 myDeck 分组
  var groups = {};
  matchupStats.forEach(function(m) {
    if (!groups[m.myDeck]) groups[m.myDeck] = [];
    groups[m.myDeck].push(m);
  });

  var myDecks = Object.keys(groups).sort(function(a, b) {
    var ta = groups[a].reduce(function(s, m) { return s + m.total; }, 0);
    var tb = groups[b].reduce(function(s, m) { return s + m.total; }, 0);
    return tb - ta;
  });

  // 收集所有对手卡组（取 top 8）
  var oppDeckSet = {};
  matchupStats.forEach(function(m) {
    oppDeckSet[m.opponentDeck] = true;
  });
  var oppDecks = Object.keys(oppDeckSet);

  if (oppDecks.length === 0 || myDecks.length === 0) { canvas._chart = null; return null; }

  // 构建查找表：[myDeck][opponentDeck] = { wins, losses, total }
  var lookup = {};
  matchupStats.forEach(function(m) {
    if (!lookup[m.myDeck]) lookup[m.myDeck] = {};
    lookup[m.myDeck][m.opponentDeck] = { wins: m.wins, losses: m.losses, total: m.total };
  });

  // 每个 myDeck 作为一个 dataset
  var colors = ['#4cd964', '#64c8ff', '#ffd700', '#c864ff', '#ff9632'];
  var datasets = [];
  myDecks.forEach(function(myDeck, di) {
    var data = oppDecks.map(function(opp) {
      var m = lookup[myDeck] && lookup[myDeck][opp];
      if (!m || (m.wins + m.losses) === 0) return null;
      return parseFloat((m.wins / (m.wins + m.losses) * 100).toFixed(1));
    });
    // 统计该卡组总场次
    var totalGames = groups[myDeck].reduce(function(s, m) { return s + m.total; }, 0);
    datasets.push({
      label: myDeck + ' (' + totalGames + '场)',
      data: data,
      backgroundColor: colors[di % colors.length],
      borderRadius: 3
    });
  });

  var ctx = canvas.getContext('2d');

  // 预先设定 canvas 尺寸（responsive=false 后 Chart.js 不会自动调整）
  var wrap = canvas.parentElement;
  var wrapRect = wrap.getBoundingClientRect();
  var totalH = Math.max(oppDecks.length * 32, 120);
  canvas.width = Math.max(wrapRect.width, 100);
  canvas.height = totalH;
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = totalH + 'px';

  canvas._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: oppDecks,
      datasets: datasets
    },
    options: {
      indexAxis: 'y',
      responsive: false,
      maintainAspectRatio: false,
      scales: {
        x: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: function(v) { return v + '%'; } } },
        y: { grid: { display: false }, ticks: { font: { size: 9 } } }
      },
      plugins: {
        legend: { position: 'top', labels: { color: '#e8e8f0', font: { size: 9 }, padding: 6, boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var opp = ctx.label;
              var myDeck = ctx.dataset.label.split(' (')[0];
              var m = lookup[myDeck] && lookup[myDeck][opp];
              if (!m) return ctx.parsed.x + '%';
              return m.wins + 'W ' + m.losses + 'L (' + ctx.parsed.x + '%)';
            }
          }
        }
      }
    }
  });

  // 启用滚动：chart-body 默认 overflow:hidden 会裁剪，这里覆盖
  var chartBody = canvas.closest('.chart-body');
  if (chartBody) chartBody.style.overflow = 'visible';
  var slide = canvas.closest('.chart-slide');
  if (slide) {
    slide.style.overflowY = 'auto';
    slide.style.height = '100%';
  }
  // canvas 上滚轮时滚动 slide
  canvas.addEventListener('wheel', function(e) {
    if (slide) { slide.scrollTop += e.deltaY; }
    e.preventDefault();
  }, { passive: false });

  // info 面板：W/L 明细
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    // 限制高度使滚动生效
    info.style.maxHeight = '100%';
    info.style.overflowY = 'auto';
    var ihtml = infoSection('对局明细');
    myDecks.forEach(function(myDeck) {
      var items = groups[myDeck];
      var subTotal = items.reduce(function(s, m) { return s + m.total; }, 0);
      var subWins = items.reduce(function(s, m) { return s + m.wins; }, 0);
      var subLosses = items.reduce(function(s, m) { return s + m.losses; }, 0);
      var subRate = (subWins + subLosses) > 0 ? (subWins / (subWins + subLosses) * 100).toFixed(1) : '0.0';
      ihtml += '<div style="margin-top:3px;font-weight:700;font-size:10px;color:var(--accent)">' + myDeck + ' (' + subTotal + '·' + subRate + '%)</div>';
      items.forEach(function(m) {
        var wr = (m.wins + m.losses) > 0 ? (m.wins / (m.wins + m.losses) * 100).toFixed(1) : '0.0';
        ihtml += infoRow(m.opponentDeck, m.wins + 'W ' + m.losses + 'L ' + wr + '%');
      });
    });
    info.innerHTML = ihtml;
  }
  return canvas._chart;
}

/**
 * 22. 晋级赛/保级赛统计（纯 HTML 展示，类似 hero 风格）
 */
function renderRankedStats(canvas, stats, options) {
  destroyChart(canvas._chart);
  var rs = stats.rankedStats;
  var hasPromo = rs && rs.promotion;
  var hasReleg = rs && rs.relegation;
  if (!hasPromo && !hasReleg) { canvas._chart = null; return null; }

  function buildBlock(data, icon, label, color) {
    if (!data) return '';
    var ht = data.handtrap;
    // 手坑摘要（仅显示 large + compact 级别）
    var htPresets = ht.presets || [];
    var htCounts = ht.counts || {};
    var htCfg = ht.config || { largeIds: [], compactIds: [] };
    var visibleSet = {};
    (htCfg.largeIds || []).forEach(function(id) { visibleSet[id] = true; });
    (htCfg.compactIds || []).forEach(function(id) { visibleSet[id] = true; });
    var htSummaryParts = [];
    htPresets.forEach(function(p) {
      if (!visibleSet[p.id]) return;
      var cnt = htCounts[p.id] || 0;
      htSummaryParts.push(p.label + ' ' + cnt);
    });
    var otherCnt = htCounts['_other'] || 0;
    if (otherCnt > 0) htSummaryParts.push('其他 ' + otherCnt);
    return '<div style="flex:1;min-width:0;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:8px;text-align:center">' +
      '<div style="font-size:14px;font-weight:700;color:' + color + ';margin-bottom:4px">' + icon + ' ' + label + '</div>' +
      '<div style="font-size:24px;font-weight:800;color:' + color + '">' + data.winRate + '%</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin-bottom:4px">对局胜率 · ' + data.total + '场</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:10px;text-align:left;margin-top:4px">' +
        '<span style="color:var(--text-dim)">硬币</span><span style="color:var(--text-bright);font-weight:700;font-family:var(--font-mono);text-align:right">' + data.coinWinRate + '%</span>' +
        '<span style="color:var(--text-dim)">先手</span><span style="color:var(--text-bright);font-weight:700;font-family:var(--font-mono);text-align:right">' + data.firstWinRate + '%</span>' +
        '<span style="color:var(--text-dim)">后手</span><span style="color:var(--text-bright);font-weight:700;font-family:var(--font-mono);text-align:right">' + data.secondWinRate + '%</span>' +
        '<span style="color:var(--text-dim)">卡手率</span><span style="color:#ff3b30;font-weight:700;font-family:var(--font-mono);text-align:right">' + data.cantPlayRate + '%</span>' +
        '<span style="color:var(--text-dim)">遇到大牌哥</span><span style="color:#ff3b30;font-weight:700;font-family:var(--font-mono);text-align:right">' + data.bigHandRate + '%</span>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin-top:4px;border-top:1px solid rgba(255,255,255,0.05);padding-top:3px">手坑: ' + htSummaryParts.join(' · ') + '</div>' +
    '</div>';
  }

  // 清除 canvas，改为可视化区块
  var parent = canvas.parentNode;
  canvas.style.display = 'none';
  var html = '<div style="display:flex;gap:8px;padding:4px;height:100%;align-items:stretch">';
  if (hasPromo) html += buildBlock(rs.promotion, '🔥', '晋级赛', '#ffc832');
  if (hasPromo && hasReleg) html += '<div style="width:1px;background:rgba(255,255,255,0.08);flex-shrink:0"></div>';
  if (hasReleg) html += buildBlock(rs.relegation, '💧', '保级赛', '#ff6b62');
  html += '</div>';

  parent.innerHTML = html;

  // info 面板：对手卡组分布
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var ihtml = '';
    if (hasPromo && rs.promotion.oppDecks && rs.promotion.oppDecks.length > 0) {
      ihtml += infoSection('🔥 晋级赛对手');
      rs.promotion.oppDecks.slice(0, 5).forEach(function(d) {
        ihtml += infoRow(d.deck, d.wins + 'W ' + d.losses + 'L ' + d.winRate + '%', winBarCls(d.winRate));
      });
    }
    if (hasReleg && rs.relegation.oppDecks && rs.relegation.oppDecks.length > 0) {
      ihtml += infoSection('💧 保级赛对手');
      rs.relegation.oppDecks.slice(0, 5).forEach(function(d) {
        ihtml += infoRow(d.deck, d.wins + 'W ' + d.losses + 'L ' + d.winRate + '%', winBarCls(d.winRate));
      });
    }
    info.innerHTML = ihtml || infoRow('', '暂无对手卡组数据');
  }
  return null;
}

var ChartManager = {
  instances: {},

  /** 注册并渲染一个图表 */
  render: function(id, canvas, renderFn, stats, options) {
    var inst = this.instances[id];
    if (inst) destroyChart(inst);
    this.instances[id] = renderFn(canvas, stats, options);
  },

  /** 销毁所有图表 */
  destroyAll: function() {
    for (var k in this.instances) {
      destroyChart(this.instances[k]);
    }
    this.instances = {};
  }
};

/**
 * 24. 特定卡组胜率趋势（折线图）
 */
function renderDeckTrendLine(canvas, stats, options) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var sel = document.getElementById('deck-trend-selector');
  var deckName = sel ? sel.value : '';
  if (!deckName) { canvas._chart = null; return null; }

  var deckData = stats.deckResults || {};
  var results = deckData[deckName];
  if (!results || results.length < 2) { canvas._chart = null; return null; }

  // 更新 subtitle
  var subEl = canvas.closest('.chart-slide').querySelector('.chart-sub');
  if (subEl) subEl.textContent = deckName + ' 累计胜率';

  // 计算累计胜率
  var points = [];
  var w = 0;
  for (var i = 0; i < results.length; i++) {
    if (results[i] === 'win') w++;
    points.push({ label: '#' + (i + 1), rate: (w / (i + 1) * 100).toFixed(1) });
  }
  var labelStep = points.length > 60 ? Math.ceil(points.length / 30) : 1;
  var chartLabels = points.map(function(p, idx) { return idx % labelStep === 0 ? p.label : ''; });
  var chartData = points.map(function(p){return parseFloat(p.rate);});

  canvas._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [{
        label: deckName,
        data: chartData,
        borderColor: '#ffc832',
        backgroundColor: 'rgba(255,200,50,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: function(v){return v+'%';} } },
        x: { grid: { display: false }, ticks: { maxRotation: 0, font: { size: 9 } } }
      },
      plugins: { legend: { display: false } }
    },
    plugins: [{
      id: 'chartBg',
      beforeDraw: function(chart) {
        var ctx = chart.ctx;
        var area = chart.chartArea;
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(area.left, area.top, area.width, area.height);
        ctx.restore();
      }
    }]
  });

  // info 面板
  var info = options && options.infoEl;
  if (info) {
    info.className = 'chart-info active';
    var wins = 0, total = results.length;
    for (var i = 0; i < results.length; i++) { if (results[i] === 'win') wins++; }
    var wr = (wins / total * 100).toFixed(1);
    var detailHtml = '';
    var lastN = Math.min(20, total);
    for (var j = total - 1; j >= total - lastN; j--) {
      var bg = results[j] === 'win' ? '#4cd964' : '#ff3b30';
      var tc = results[j] === 'win' ? '#000' : '#fff';
      detailHtml += '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;font-size:8px;font-weight:700;margin:1px;background:' + bg + ';color:' + tc + '">' + (results[j] === 'win' ? 'W' : 'L') + '</span>';
    }
    info.innerHTML =
      infoRow('总胜率', wr + '%', parseFloat(wr) >= 50 ? 'good' : 'bad') +
      infoRow('总场次', total + ' 场', '') +
      infoRow('胜/负', wins + ' / ' + (total - wins), '') +
      infoSection('最近 ' + lastN + ' 场') +
      '<div style="display:flex;flex-wrap:wrap;gap:1px;margin-top:2px">' + detailHtml + '</div>';
  }
  return canvas._chart;
}