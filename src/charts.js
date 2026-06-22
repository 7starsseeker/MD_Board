/* ═══════════════════════════════════════════════════════════════════════════
   MD Stats - 图表模块（基于 Chart.js）
   提供各种统计数据的图表渲染函数
   ═══════════════════════════════════════════════════════════════════════════ */

/* global Chart */

// ── Chart.js 全局默认值 ──────────────────────────────────────────────
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#8888a0';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Consolas','Cascadia Code','JetBrains Mono',monospace,'思源黑体','Noto Sans CJK SC','PingFang SC',sans-serif";
}

// ── 工具 ─────────────────────────────────────────────────────────────
function fmt(v) {
  if (v === undefined || v === null) return '0.0';
  var n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? '0.0' : n.toFixed(1);
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
 * 1. 胜负饼图（总场次比例）
 */
function renderWinPie(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var hasData = (stats.wins + stats.losses + stats.draws + stats.abnormals) > 0;
  if (!hasData) { canvas._chart = null; return null; }
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
              var total = ctx.dataset.data.reduce(function(a,b){return a+b;}, 0);
              return ctx.label + ': ' + ctx.parsed + ' (' + (total > 0 ? (ctx.parsed/total*100).toFixed(1) : 0) + '%)';
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 2. 先后手胜率对比（柱状图）
 */
function renderFirstSecondBar(canvas, stats) {
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
  return canvas._chart;
}

/**
 * 3. 手坑分布（饼图）
 */
function renderHandtrapPie(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var ht = stats.handtrap;
  var labels = ['增殖的G','鸟G','水母G','锁鸟','陨石','大宇宙人','其他手坑'];
  var values = [ht.gotMaxxc, ht.gotDroll, ht.gotJellyfish, ht.gotLancea, ht.gotNibiru, ht.gotDimension, ht.gotSmallHT];
  var total = values.reduce(function(a,b){return a+b;}, 0);
  if (total === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: getColors(7),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 10 }, padding: 8 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.label + ': ' + ctx.parsed + ' 次 (' + fmt(ctx.parsed / stats.total * 100) + '%)';
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 4. 先手终场分布（饼图）
 */
function renderEndboardPie(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var eb = stats.endboard;
  if (!eb || eb.total === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['正常终场','妥协场','停牌','投降'],
      datasets: [{
        data: [eb.normal, eb.compromised, eb.stopped, eb.surrender],
        backgroundColor: ['#4cd964','#ffd700','#ff3b30','#8888a0'],
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
    }
  });
  return canvas._chart;
}

/**
 * 5. 后手突破统计（饼图）
 */
function renderBreakBoardPie(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var bb = stats.breakBoard;
  if (!bb || (bb.success + bb.failed + bb.surrender) === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['突破成功','突破失败','投降'],
      datasets: [{
        data: [bb.success, bb.failed, bb.surrender],
        backgroundColor: ['#4cd964','#ff3b30','#8888a0'],
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
    }
  });
  return canvas._chart;
}

/**
 * 6. 胜率趋势（折线图 - 每 N 场为一个点）
 */
function renderWinTrendLine(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  // 使用 last10 场数据生成胜率趋势
  var last10 = stats.last10 || [];
  if (last10.length < 2) { canvas._chart = null; return null; }

  // 按时间顺序累计胜率
  var points = [];
  var wins = 0, total = 0;
  for (var i = 0; i < last10.length; i++) {
    var r = last10[i].result;
    if (r === 'win' || r === 'loss') {
      total++;
      if (r === 'win') wins++;
      if (total >= 2 && total % 2 === 0) {
        points.push({ label: '#' + total, rate: (wins / total * 100).toFixed(1) });
      }
    }
  }
  if (points.length < 2 && total > 0) {
    points.push({ label: '#' + total, rate: (wins / total * 100).toFixed(1) });
  }
  if (points.length < 2) { canvas._chart = null; return null; }

  canvas._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(function(p){return p.label;}),
      datasets: [{
        label: '胜率',
        data: points.map(function(p){return parseFloat(p.rate);}),
        borderColor: '#ffc832',
        backgroundColor: 'rgba(255,200,50,0.1)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#ffc832',
        pointRadius: 3,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: function(v){return v+'%';} } },
        x: { grid: { display: false } }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
  return canvas._chart;
}

/**
 * 7. 自用卡组胜率排行（横向柱状图）
 */
function renderDeckBar(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var decks = stats.myDeckStats || [];
  if (decks.length === 0) { canvas._chart = null; return null; }
  // 取前 10
  var top = decks.slice(0, 10);
  var labels = top.map(function(d){return d.deck;});
  var winRates = top.map(function(d){return parseFloat(d.winRate);});
  var counts = top.map(function(d){return d.total;});

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
        y: { grid: { display: false } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: function(ctx) {
              return '场次: ' + counts[ctx.dataIndex];
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
        backgroundColor: [c, 'rgba(255,255,255,0.06)'],
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
        ctx2.fillStyle = '#8888a0';
        ctx2.fillText(isWin ? '连胜' : '连败', w / 2, h / 2 + 20);
        ctx2.restore();
      }
    }]
  });
  return canvas._chart;
}

/**
 * 9. 硬币统计（饼图）
 */
function renderCoinPie(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var c = stats.coin || { total: 0, wins: 0, losses: 0 };
  if (c.total === 0) { canvas._chart = null; return null; }
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
    }
  });
  return canvas._chart;
}

/**
 * 10. 卡手原因分布（饼图）
 */
function renderHandStatePie(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var hs = stats.handState || {};
  var values = [hs.cantPlay||0, hs.cantPlayGarnet||0, hs.cantPlayDuplicate||0, hs.cantPlayHT||0, hs.bothStuck||0];
  var total = values.reduce(function(a,b){return a+b;}, 0);
  if (total === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['无法动', '卡组件', '卡同名', '卡手坑', '互卡'],
      datasets: [{
        data: values,
        backgroundColor: getColors(5),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        legend: { position: 'right', labels: { color: '#e8e8f0', font: { size: 10 }, padding: 8 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              return ctx.label + ': ' + ctx.parsed + ' 次 (' + fmt(ctx.parsed / (stats.total||1) * 100) + '%)';
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 11. 严重失误统计（饼图 + 附胜率）
 */
function renderMistakeDoughnut(canvas, stats) {
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
  return canvas._chart;
}

/**
 * 12. 对手 T0 动统计（饼图）
 */
function renderOpponentT0Doughnut(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var t = stats.opponentT0 || { total: 0, wins: 0, losses: 0 };
  var noT0 = Math.max(0, (stats.total||0) - t.total);
  if (t.total === 0 && noT0 === 0) { canvas._chart = null; return null; }
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
              var wr = (t.wins + t.losses) > 0 ? ((t.wins / (t.wins + t.losses)) * 100).toFixed(1) : '0.0';
              return '被T0时胜率: ' + wr + '%';
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 13. 吓跑对手（仪表盘风格）
 */
function renderOpponentRanGauge(canvas, stats) {
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
        backgroundColor: ['#ff9632', 'rgba(255,255,255,0.06)'],
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
        ctx2.fillStyle = '#8888a0';
        ctx2.fillText('吓跑对手', w / 2, h / 2 + 20);
        ctx2.restore();
      }
    }]
  });
  return canvas._chart;
}

/**
 * 14. 提丰趣味统计（饼图）
 */
function renderTyphonPie(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var t = stats.typhon || { total: 0, enemyBlack: 0, enemyWhite: 0, selfBlack: 0, selfWhite: 0 };
  if (t.total === 0) { canvas._chart = null; return null; }
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
  return canvas._chart;
}

/**
 * 15. 对战卡组胜率排行（横向柱状图）
 */
function renderOppDeckBar(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var decks = stats.deckStats || [];
  if (decks.length === 0) { canvas._chart = null; return null; }
  var top = decks.slice(0, 10);
  var labels = top.map(function(d){return d.deck;});
  var winRates = top.map(function(d){return parseFloat(d.winRate);});
  var counts = top.map(function(d){return d.total;});
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
        y: { grid: { display: false } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: function(ctx) { return '场次: ' + counts[ctx.dataIndex]; }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 16. 连接异常统计（饼图）
 */
function renderDisconnectPie(canvas, stats) {
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
              var total = ctx.dataset.data.reduce(function(a,b){return a+b;}, 0);
              return ctx.label + ': ' + ctx.parsed + ' (' + (total > 0 ? (ctx.parsed/total*100).toFixed(1) : 0) + '%)';
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 17. 超时统计（饼图：自己超时 vs 对手超时）
 */
function renderTimeoutPie(canvas, stats) {
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
              var total = ctx.dataset.data.reduce(function(a,b){return a+b;}, 0);
              return ctx.label + ': ' + ctx.parsed + ' (' + (total > 0 ? (ctx.parsed/total*100).toFixed(1) : 0) + '%)';
            }
          }
        }
      }
    }
  });
  return canvas._chart;
}

/**
 * 18. 对手大牌统计（仪表盘风格）
 */
function renderBigHandGauge(canvas, stats) {
  destroyChart(canvas._chart);
  var ctx = canvas.getContext('2d');
  var bh = stats.bigHand || 0;
  if (bh === 0) { canvas._chart = null; return null; }
  canvas._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['对手大牌', ''],
      datasets: [{
        data: [bh, Math.max(bh, 5)],
        backgroundColor: ['#ff2d55', 'rgba(255,255,255,0.06)'],
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
        ctx2.fillText(bh + '🃏', w / 2, h / 2 - 6);
        ctx2.font = '13px sans-serif';
        ctx2.fillStyle = '#8888a0';
        ctx2.fillText('对手大牌', w / 2, h / 2 + 20);
        ctx2.restore();
      }
    }]
  });
  return canvas._chart;
}

// ═══════════════════════════════════════════════════════════════════════════
//  全局图表管理器（用于批量渲染/更新）
// ═══════════════════════════════════════════════════════════════════════════

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
