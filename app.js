/* 交易日记 · Trade Journal
   开仓 → 关仓 → 结算。关仓之后才计算盈亏得失。
   数据存本地 localStorage，可导出 JSON 备份。 */
(function () {
  'use strict';

  var KEY = 'trade-journal.v1';
  var store = [];
  var editingId = null;
  var modalMode = 'open';   // 'open' 开仓表单 | 'close' 关仓表单

  var DEV_LABELS = {
    none:       '无偏差',
    planEdited: '计划事后改过',
    impulse:   '临时无计划开仓',
    stopMoved: '止损位挪过',
    sizeUp:    '手数临时加过',
    missed:    '该进的没进',
    lateExit:  '止损晚走',
    earlyExit: '提前跑',
    noExit:    '浮亏扛着没走'
  };
  var MOOD_LABELS = { calm: '稳', neutral: '一般', urgent: '急', fomo: '怕踏空', revenge: '想扳回来' };
  var CAT_LABELS = { A: '守规矩赚的', B: '守规矩亏的', C: '破规矩亏的', D: '破规矩赚的' };
  var MODE_TIP = {
    planned: '下单之前就想清楚了：什么信号进、止损在哪、什么情况下走人。三样先写下来，再下单 —— 很多冲动的单子会死在你动笔的那半分钟里。',
    impulse: '这笔没有事前条件：可能是看到它涨了、听了个消息、或者单纯手痒。锁定后会自动记为偏差「临时无计划开仓」。下面那栏如实写事后理由 —— 它叫解释，不叫条件。'
  };

  /* ---------------- utils ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null || isNaN(n)) return '—';
    var v = Math.round(n);
    return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('zh-CN');
  }
  function num(el) { var v = parseFloat($(el).value); return isNaN(v) ? null : v; }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function ym(s) { return (s || '').slice(0, 7); }
  function monthLabel(m) { return m ? m.slice(0, 4) + '年' + Number(m.slice(5)) + '月' : ''; }
  function prevMonth(m) {
    var y = Number(m.slice(0, 4)), mo = Number(m.slice(5));
    mo -= 1; if (mo === 0) { mo = 12; y -= 1; }
    return y + '-' + String(mo).padStart(2, '0');
  }
  function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nowStr() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function daysBetween(a, b) {
    if (!a || !b) return null;
    var d = (new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000;
    return isNaN(d) ? null : Math.round(d);
  }

  /* 存储层：localStorage 在部分浏览器、以本地文件方式直接打开或隐私模式下会被禁用并直接抛错。
     一旦不可用就降级为内存存储，保证页面仍能正常打开与使用，
     同时明确告知用户「关掉页面数据会丢」，引导其导出备份。 */
  var memStore = {}, storageOK = true;
  try {
    localStorage.setItem('__tj_probe__', '1');
    localStorage.removeItem('__tj_probe__');
  } catch (e) { storageOK = false; }

  function lsGet(k) {
    if (storageOK) {
      try { return localStorage.getItem(k); } catch (e) { storageOK = false; }
    }
    return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null;
  }
  function lsSet(k, v) {
    if (storageOK) {
      try { localStorage.setItem(k, v); return; } catch (e) { storageOK = false; }
    }
    memStore[k] = String(v);
  }

  function warnStorageOnce() {
    setTimeout(function () {
      try {
        toast('当前环境禁止本地存储，数据只留在内存中，关闭页面即丢失 —— 请用菜单里的「导出备份」保存。');
      } catch (e) { /* 提示失败不影响主流程 */ }
    }, 600);
  }

  function load() {
    try { store = JSON.parse(lsGet(KEY) || '[]'); } catch (e) { store = []; }
    if (!Array.isArray(store)) store = [];
    if (!storageOK) warnStorageOnce();
  }
  function save() { lsSet(KEY, JSON.stringify(store)); }
  function byId(id) { for (var i = 0; i < store.length; i++) if (store[i].id === id) return store[i]; return null; }

  /* ---------------- 记录状态 ---------------- */
  function isClosed(t) {
    if (t && t.status) return t.status === 'closed';
    return !!(t && t.exec && t.exec.exit != null);   // 兼容旧数据
  }
  function isHolding(t) { return !isClosed(t); }
  function holdings() {
    return store.filter(function (t) { return isHolding(t) && t.plan && t.plan.lockedAt; })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  }
  function monthOf(t) { return isClosed(t) && t.exec.closeDate ? ym(t.exec.closeDate) : ym(t.date); }
  function pnlOf(t) { return isClosed(t) && t.exec && typeof t.exec.pnl === 'number' ? t.exec.pnl : null; }
  // 「无偏差」是显式确认，不算偏差项
  function realDevs(t) { return (t && t.devs ? t.devs : []).filter(function (d) { return d !== 'none'; }); }
  function noDevMarked(t) { return !!(t && t.devs && t.devs.indexOf('none') >= 0); }
  function isBreak(t) { return realDevs(t).length > 0; }
  function isReviewed(t) { return isClosed(t) && !!(t.review && t.review.cat); }
  function openQtyOf(t) { var e = (t && t.exec) || {}; return e.openSize != null ? e.openSize : (e.size != null ? e.size : null); }
  function qtyOf(t) { var e = (t && t.exec) || {}; return e.closeSize != null ? e.closeSize : openQtyOf(t); }
  function realStopOf(t) { var e = (t && t.exec) || {}; return e.realStop || e.stop || ''; }
  function statOf(arr) {
    var s = 0, n = 0, w = 0;
    arr.forEach(function (t) { var p = pnlOf(t); if (p != null) { s += p; n++; if (p > 0) w++; } });
    return { n: arr.length, avg: n ? Math.round(s / n) : null, sum: n ? s : null, win: n ? Math.round(w / n * 100) : null };
  }

  /* ---------------- header ---------------- */
  function renderKpi() {
    var rev = store.filter(isReviewed);
    var cleanN = rev.filter(function (t) { return !isBreak(t); }).length;
    var el = $('#kpiDisciplineVal');
    el.textContent = rev.length ? Math.round(cleanN / rev.length * 100) + '%' : '—';
    el.style.color = rev.length ? (cleanN / rev.length >= .8 ? 'var(--down)' : cleanN / rev.length >= .6 ? 'var(--warn)' : 'var(--up)') : '';

    var sum = 0, n = 0;
    store.filter(isClosed).forEach(function (t) { var p = pnlOf(t); if (p != null) { sum += p; n++; } });
    var pe = $('#kpiPnlVal');
    pe.textContent = n ? money(sum) : '—';
    pe.style.color = n ? (sum > 0 ? 'var(--up)' : sum < 0 ? 'var(--down)' : 'var(--muted)') : '';

    var hn = holdings().length;
    $('#openBadge').textContent = String(hn);
    $('#openBadge').style.display = hn ? '' : 'none';
    $('#btnClosePos').disabled = !hn;
    $('#btnClosePos').style.opacity = hn ? '' : '.5';
  }

  /* ---------------- 列表 ---------------- */
  function renderList() {
    var m = $('#filterMonth').value, c = $('#filterCat').value, d = $('#filterDev').value;
    var all = store.slice().sort(function (a, b) {
      var ka = (isClosed(a) && a.exec.closeDate ? a.exec.closeDate : (a.date || ''));
      var kb = (isClosed(b) && b.exec.closeDate ? b.exec.closeDate : (b.date || ''));
      return kb.localeCompare(ka);
    });
    if (m) all = all.filter(function (t) { return monthOf(t) === m; });
    if (d === 'any') all = all.filter(isBreak);
    if (d === 'clean') all = all.filter(function (t) { return !isBreak(t); });

    var held = all.filter(function (t) { return isHolding(t) && !c; });
    var done = all.filter(isClosed);
    if (c) done = done.filter(function (t) { return t.review && t.review.cat === c; });

    var closedAll = all.filter(isClosed);
    var brk = closedAll.filter(isBreak).length;
    var s = statOf(closedAll);
    $('#listCounts').innerHTML = '持仓中 <b>' + held.length + '</b> · 已关仓 <b>' + closedAll.length + '</b>' +
      (closedAll.length ? ' · 破规矩 <b>' + brk + '</b>（' + Math.round(brk / closedAll.length * 100) + '%）' : '') +
      (s.sum != null ? ' · 合计 <b>' + money(s.sum) + '</b>' : '');

    var html = '';
    if (held.length) {
      html += '<div class="group-title">持仓中 <span class="cnt">' + held.length + ' 笔 · 关仓后才结算盈亏</span></div>' +
        held.map(function (t) { return cardHtml(t); }).join('');
    }
    if (done.length) {
      html += '<div class="group-title">已关仓 <span class="cnt">' + done.length + ' 笔</span></div>' +
        done.map(function (t) { return cardHtml(t); }).join('');
    }
    $('#tradeList').innerHTML = html;
    $('#emptyRecords').classList.toggle('hidden', html !== '');
  }

  function cardHtml(t) {
    var closed = isClosed(t);
    var p = pnlOf(t);
    var pcls = p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
    var devs = realDevs(t);
    var cat = t.review && t.review.cat;
    var mode = t.plan && t.plan.mode;
    var pills = [];
    if (mode) pills.push('<span class="pill ' + (mode === 'impulse' ? 'dev late' : 'ok') + '">' + (mode === 'impulse' ? '随意开仓' : '计划开仓') + '</span>');
    if (t.plan && t.plan.unlockCount > 0) {
      pills.push('<span class="pill dev">计划事后改过' + (t.plan.unlockCount > 1 ? ' ×' + t.plan.unlockCount : '') + '</span>');
    }
    if (cat && closed) pills.push('<span class="pill cat"><span class="cat-tag ' + cat.toLowerCase() + '">' + cat + '</span>' + CAT_LABELS[cat] + '</span>');
    if (!devs.length && t.plan && t.plan.lockedAt) {
      pills.push('<span class="pill ok">' + (noDevMarked(t) ? '无偏差 ✓' : '零偏差') + '</span>');
    }
    devs.forEach(function (k) {
      var cls = (k === 'lateExit' || k === 'noExit') ? 'pill dev late' : 'pill dev';
      pills.push('<span class="' + cls + '">' + DEV_LABELS[k] + (k === 'lateExit' && t.exec && t.exec.lateDays ? ' ' + t.exec.lateDays + '天' : '') + '</span>');
    });
    if (t.state) {
      var st = [];
      if (t.state.sleep != null) st.push('睡' + t.state.sleep + 'h');
      if (t.state.mood) st.push(MOOD_LABELS[t.state.mood]);
      if (t.state.conflict) st.push('有情绪波动');
      if (t.state.prevLoss) st.push('上笔刚亏');
      if (t.state.prevWin) st.push('上笔刚赚');
      if (st.length) pills.push('<span class="pill state">' + esc(st.join(' · ')) + '</span>');
    }
    if (closed && t.review && t.review.market) pills.push('<span class="pill">' + esc(t.review.market) + (t.review.holdDays != null ? ' · 持' + t.review.holdDays + '天' : '') + '</span>');

    var sizeDiff = '';
    if (t.plan && t.plan.size != null && openQtyOf(t) != null && Number(t.plan.size) !== Number(openQtyOf(t))) {
      sizeDiff = '<span class="pill dev">仓位 ' + t.plan.size + ' → ' + openQtyOf(t) + '</span>';
    }

    var dateTxt = '开仓 ' + esc(t.date || '');
    if (closed && t.exec && t.exec.closeDate) dateTxt += ' · 关仓 ' + esc(t.exec.closeDate);

    var head = '<div class="card-top">' +
      '<span class="sym">' + esc(t.symbol || '未命名标的') + '</span>' +
      '<span class="dir ' + (t.direction === 'short' ? 'short' : 'long') + '">' + (t.direction === 'short' ? '做空' : '做多') + '</span>' +
      '<span class="date">' + dateTxt + '</span>' +
      '<span class="spacer"></span>' +
      (closed
        ? '<span class="pnl ' + pcls + '">' + (p == null ? '未结算' : money(p)) + '</span>'
        : '<span class="badge-hold">持仓中</span>') +
      '</div>';

    var mid = '<div class="card-mid"><div class="trigger"><span class="label">' +
      (mode === 'impulse' ? '事后解释' : '触发') + '</span>' +
      esc((t.plan && t.plan.trigger) || (mode === 'impulse' ? '（连理由都没写）' : '（未写）')) + '</div></div>';

    var actions = '';
    if (!closed) {
      actions = '<div class="card-actions">' +
        '<button class="btn mini warn" data-unlock="' + t.id + '">解锁改计划</button>' +
        '<button class="btn mini primary" data-close="' + t.id + '">关仓结算</button>' +
        '<span class="sb-tip">开仓价 ' + esc((t.exec && t.exec.entry) != null ? t.exec.entry : '—') +
        ' × ' + esc(openQtyOf(t) == null ? '—' : openQtyOf(t)) +
        (t.plan && t.plan.size != null ? '（计划 ' + t.plan.size + '）' : '') + '</span></div>';
    }

    return '<div class="card' + (closed ? '' : ' holding') + '" data-id="' + t.id + '">' +
      head + mid +
      '<div class="card-bottom">' + pills.join('') + sizeDiff + '</div>' +
      actions + '</div>';
  }

  /* ---------------- 弹窗 ---------------- */
  function currentMode() {
    var b = $('#modeSeg .seg-opt.sel');
    return b ? b.dataset.mode : null;
  }
  function syncMode() {
    var mode = currentMode();
    $$('#modeSeg .seg-opt').forEach(function (b) {
      b.classList.toggle('sel', b.dataset.mode === mode);
      b.classList.toggle('impulse', b.dataset.mode === 'impulse');
    });
    var tip = $('#modeTip');
    if (!mode) { tip.className = 'seg-tip'; tip.textContent = '先定性：这一笔是事前想好的，还是临时起意。'; }
    else if (mode === 'impulse') { tip.className = 'seg-tip warn'; tip.textContent = MODE_TIP.impulse; }
    else { tip.className = 'seg-tip'; tip.textContent = MODE_TIP.planned; }
    var isImp = mode === 'impulse';
    $('#triggerLabel').innerHTML = isImp ? '事后解释 · 当时脑子里想的是什么' : '触发条件 · 凭什么进这一笔 <span class="req">*</span>';
    $('#f_trigger').placeholder = isImp
      ? '例：看到板块突然拉升怕踏空；朋友提了一句；没什么理由，就是想做一笔'
      : '出现哪个信号？例如：放量突破20日箱体上沿且板块同步翻红；回踩MA20不破且缩量。';
  }
  function syncDevChecks() {
    var t = editingId ? byId(editingId) : null;
    var devs = (t && t.devs) || [];
    $$('#devChecks input').forEach(function (cb) { cb.checked = devs.indexOf(cb.dataset.dev) >= 0; });
    var le = $('#devChecks input[data-dev="lateExit"]');
    $('#lateDaysWrap').style.display = le && le.checked ? '' : 'none';
  }

  function openModal(id, mode) {
    modalMode = mode || 'open';
    var t = id ? byId(id) : null;

    if (modalMode === 'close') {
      var hs = holdings();
      if (!hs.length) { alert('还没有持仓中的开仓记录 —— 先点「＋ 开仓」。'); return; }
      if (!t || isClosed(t)) t = hs[0];
      id = t.id;
    }
    editingId = id || null;

    $('#modalTitle').textContent = modalMode === 'close' ? '关仓结算' : (t ? '编辑开仓 · ' + (t.symbol || '') : '开仓');
    $('#modalSub').textContent = modalMode === 'close'
      ? '先选一笔已开仓的持仓，再填实际出场 —— 结算之后才算得失'
      : '先写条件，再下单；开仓只开了个头';

    var pick = $('#closePickWrap');
    pick.style.display = modalMode === 'close' ? '' : 'none';
    if (modalMode === 'close') populateCloseTargets(id);

    $('#f_date').value = t ? (t.date || '') : today();
    $('#f_symbol').value = t ? (t.symbol || '') : '';
    $('#f_direction').value = t ? (t.direction || 'long') : 'long';
    $('#f_planSize').value = t && t.plan ? (t.plan.size == null ? '' : t.plan.size) : '';
    $('#f_trigger').value = t && t.plan ? (t.plan.trigger || '') : '';
    $('#f_planStop').value = t && t.plan ? (t.plan.stop || '') : '';
    $('#f_planExit').value = t && t.plan ? (t.plan.exit || '') : '';
    $('#f_planExitNote').value = t && t.plan ? (t.plan.exitNote || '') : '';

    $('#f_entry').value = t && t.exec && t.exec.entry != null ? t.exec.entry : '';
    $('#f_openSize').value = openQtyOf(t) == null ? '' : openQtyOf(t);
    $('#f_closeDate').value = t && t.exec && t.exec.closeDate ? t.exec.closeDate : today();
    $('#f_exit').value = t && t.exec && t.exec.exit != null ? t.exec.exit : '';
    $('#f_closeSize').value = t && t.exec && t.exec.closeSize != null ? t.exec.closeSize : '';
    $('#f_realStop').value = t ? realStopOf(t) : '';
    $('#f_execNote').value = t && t.exec ? (t.exec.note || '') : '';
    $('#f_pnl').value = t && t.exec && t.exec.pnl != null ? t.exec.pnl : '';
    $('#f_multiplier').value = t && t.exec && t.exec.multiplier != null ? t.exec.multiplier : 1;
    $('#f_lateDays').value = t && t.exec && t.exec.lateDays != null ? t.exec.lateDays : '';

    syncDevChecks();

    var st = (t && t.state) || {};
    $('#f_sleep').value = st.sleep != null ? st.sleep : 7;
    $('#sleepVal').textContent = $('#f_sleep').value + ' h';
    $('#f_mood').value = st.mood || 'calm';
    $('#f_conflict').checked = !!st.conflict;
    $('#f_prevLoss').checked = !!st.prevLoss;
    $('#f_prevWin').checked = !!st.prevWin;
    $('#f_busy').checked = !!st.busy;
    $('#f_stateNote').value = st.note || '';
    $('#f_stateExtra').value = st.extraNote || '';
    renderStateRecap();

    var rv = (t && t.review) || {};
    $('#f_market').value = rv.market || '';
    $('#f_holdDays').value = rv.holdDays == null ? '' : rv.holdDays;
    $('#f_lesson').value = rv.lesson || '';
    $$('#catPicker .cat-opt').forEach(function (b) { b.classList.toggle('sel', b.dataset.cat === rv.cat); });

    $$('#modeSeg .seg-opt').forEach(function (b) {
      b.classList.toggle('sel', !!(t && t.plan && t.plan.mode === b.dataset.mode));
    });
    syncMode();

    var locked = !!(t && t.plan && t.plan.lockedAt);
    applyLock(locked, t);
    renderOpenRecap(t);
    gotoStep(locked && modalMode === 'close' ? 2 : 1);
    syncOpenCompare();
    syncCloseCompare();
    syncPnlPreview();
    syncCatSuggest();
    $('#modalMask').classList.remove('hidden');
  }

  function populateCloseTargets(selId) {
    var hs = holdings();
    $('#f_closeTarget').innerHTML = hs.map(function (t) {
      return '<option value="' + t.id + '"' + (t.id === selId ? ' selected' : '') + '>' +
        esc(t.date + '  ' + (t.symbol || '未命名')) + ' · ' + (t.direction === 'short' ? '做空' : '做多') +
        ' · 开仓价 ' + esc((t.exec && t.exec.entry) != null ? t.exec.entry : '—') +
        ' × ' + esc(openQtyOf(t) == null ? '—' : openQtyOf(t)) + '</option>';
    }).join('');
    $('#closePickTip').textContent = '共 ' + hs.length + ' 笔持仓中 —— 只有这些标的可以关仓。';
  }

  /* 解锁：把已冻结的计划放开。代价是这笔计划不再算「事前条件」——
     自动记为偏差，并留一份改之前的快照，改动全部留痕。 */
  function unlockPlan() {
    var t = editingId ? byId(editingId) : null;
    if (!t || !t.plan) return;
    if (isClosed(t)) {
      alert('这笔已经关仓结算了。\n\n结算之后的开仓计划不再允许改动 —— 改成对的也没用，它已经不参与这笔的复盘了。');
      return;
    }
    if (!t.plan.lockedAt) { gotoStep(1); return; }
    if (!confirm(
      '解锁之后，这笔交易的计划就不再算「事前条件」了。\n\n' +
      '系统会自动做三件事：\n' +
      '· 打上偏差「计划事后改过」\n' +
      '· 累计解锁次数，显示在记录卡片上\n' +
      '· 保留改之前的原始计划，用于对照\n\n' +
      '改动会全部留痕。确定要解锁？')) return;

    collect(t);
    if (!t.plan.orig) {
      t.plan.orig = {
        mode: t.plan.mode, size: t.plan.size, trigger: t.plan.trigger,
        stop: t.plan.stop, exit: t.plan.exit, exitNote: t.plan.exitNote,
        lockedAt: t.plan.lockedAt
      };
    }
    t.plan.unlockCount = (t.plan.unlockCount || 0) + 1;
    t.plan.unlockedAt = nowStr();
    t.plan.lockedAt = null;
    t.devs = t.devs || [];
    if (t.devs.indexOf('planEdited') < 0) t.devs.push('planEdited');
    save();

    applyLock(false, t);
    syncDevChecks();
    renderUnlockBanner(t);
    gotoStep(1);
    renderList(); renderKpi();
  }

  function renderUnlockBanner(t) {
    var box = $('#unlockBanner');
    var show = !!(t && t.plan && !t.plan.lockedAt && t.plan.unlockCount > 0);
    if (!show) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    var o = t.plan.orig || {};
    box.innerHTML = '<strong>已解锁 ' + t.plan.unlockCount + ' 次 · 此后的修改不再算事前条件</strong>' +
      '<div class="recap-row"><span class="k">改之前</span><span>' +
      '触发：' + esc(o.trigger || '（未写）') +
      ' ｜ 止损：' + esc(o.stop || '—') +
      ' ｜ 离场：' + esc(o.exit || '—') +
      ' ｜ 计划仓位：' + esc(o.size == null ? '—' : o.size) +
      '</span></div>';
  }

  function renderOpenRecap(t) {
    var box = $('#openRecap');
    if (!t || !t.plan || !t.plan.lockedAt) { box.innerHTML = ''; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML =
      '<b>这一笔的开仓记录</b> · ' + esc(t.date) + ' ' + esc(t.symbol || '未命名') +
      ' ' + (t.direction === 'short' ? '做空' : '做多') +
      ' · 计划仓位 <b>' + esc(t.plan.size == null ? '—' : t.plan.size) + '</b>' +
      ' · 实际开仓 <b>' + esc((t.exec && t.exec.entry) != null ? t.exec.entry : '—') + '</b> × <b>' + esc(openQtyOf(t) == null ? '—' : openQtyOf(t)) + '</b>' +
      ' · 已持仓 <b>' + (daysBetween(t.date, isClosed(t) && t.exec.closeDate ? t.exec.closeDate : today()) == null ? '—' : daysBetween(t.date, isClosed(t) && t.exec.closeDate ? t.exec.closeDate : today())) + '</b> 天<br>' +
      '<span style="color:var(--muted)">触发：' + esc(t.plan.trigger || '（未写）') + ' ｜ 止损：' + esc(t.plan.stop || '—') + ' ｜ 离场：' + esc(t.plan.exit || '—') + '</span>';
  }

  function applyLock(locked, t) {
    ['#f_date', '#f_symbol', '#f_direction', '#f_planSize', '#f_trigger', '#f_planStop', '#f_planExit', '#f_planExitNote']
      .forEach(function (s) { $(s).disabled = locked; });
    $$('#modeSeg .seg-opt').forEach(function (b) { b.disabled = locked; });
    $('#btnLock').classList.toggle('hidden', locked);
    $('#btnGotoClose').classList.toggle('hidden', !locked);
    // 第 1 步也要能解锁：计划一旦冻结，就地给出口，不必绕到关仓步骤
    var buOpen = $('#btnUnlockOpen');
    if (buOpen) buOpen.classList.toggle('hidden', !locked || isClosed(t));
    var tip = $('#lockTip');
    if (locked) {
      tip.className = 'lock-tip done';
      tip.textContent = '已锁定 · ' + (t && t.plan.lockedAt ? t.plan.lockedAt.replace('T', ' ').slice(0, 16) : '') + ' — 计划已冻结，现在填实际成交价，或直接去关仓';
      $('#lockedBanner').innerHTML = '<strong>计划已冻结。</strong>下面填的是实际出场。只有关仓之后，这笔交易的盈亏与得失才会被结算 —— 在此之前它只是一笔持仓。';
    } else {
      tip.className = 'lock-tip';
      tip.textContent = '未锁定 · 现在改不算数，锁定后即为事前条件';
      $('#lockedBanner').innerHTML = '';
    }
    renderUnlockBanner(t);
    var bu = $('#btnUnlock');
    if (bu) bu.classList.toggle('hidden', isClosed(t));   // 已结算的不允许再改计划
  }

  function gotoStep(n) {
    $$('#stepBar .step').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.step) === n); });
    $$('.step-pane').forEach(function (p) { p.classList.toggle('active', Number(p.dataset.pane) === n); });
    if (n === 3) renderStateRecap();
  }

  // 第 3 步复查：把开仓时记录的当天状态回显出来
  function renderStateRecap() {
    var t = editingId ? byId(editingId) : null;
    var s = (t && t.state) || {};
    var flags = [];
    if (s.conflict) flags.push('刚吵完架 / 情绪有波动');
    if (s.prevLoss) flags.push('上一笔刚亏');
    if (s.prevWin) flags.push('上一笔刚赚');
    if (s.busy) flags.push('看盘碎片化');
    var rows = [
      ['睡眠', s.sleep != null ? s.sleep + ' 小时' : '未填'],
      ['情绪', MOOD_LABELS[s.mood] || '未填'],
      ['前置事件', flags.length ? flags.join(' · ') : '无'],
      ['备注', s.note || '—']
    ];
    $('#stateRecap').innerHTML = '<div class="recap-title">开仓时记录的当天状态</div>' +
      rows.map(function (r) {
        return '<div class="recap-row"><span class="k">' + r[0] + '</span><span>' + esc(r[1]) + '</span></div>';
      }).join('');
  }

  function lockPlan() {
    var mode = currentMode();
    if (!mode) { alert('先定性：这笔是「计划开仓」还是「随意开仓」。'); return; }
    if (mode === 'planned') {
      if (!$('#f_trigger').value.trim()) { alert('先把触发条件写下来 —— 凭什么进这一笔。'); $('#f_trigger').focus(); return; }
      if (!$('#f_planStop').value.trim()) { alert('止损放在哪？没写止损的计划不算计划。'); $('#f_planStop').focus(); return; }
      if (!$('#f_planExit').value.trim()) { alert('什么情况下走人？先想清楚出场。'); $('#f_planExit').focus(); return; }
    }
    var t = editingId ? byId(editingId) : null;
    if (!t) { t = { id: uid(), plan: {}, exec: {}, state: {}, review: {}, devs: [] }; store.push(t); editingId = t.id; }
    collect(t);
    t.plan.mode = mode;
    t.plan.lockedAt = nowStr();
    t.devs = t.devs || [];
    if (mode === 'impulse' && t.devs.indexOf('impulse') < 0) t.devs.push('impulse');
    t.plan.lockedAt = nowStr();
    t.status = 'open';
    save();
    applyLock(true, t);
    if (t.plan.unlockCount > 0) {
      var tp = $('#lockTip');
      tp.className = 'lock-tip done';
      tp.textContent = '已重新锁定 · 解锁后的第 ' + t.plan.unlockCount + ' 次重锁 —— 解锁期间的改动已记为偏差「计划事后改过」，抹不掉';
    }
    syncDevChecks();
    renderOpenRecap(t);
    refreshMonthSelects(); renderKpi(); renderList();
  }

  function syncOpenCompare() {
    var ps = num('#f_planSize'), rs = num('#f_openSize');
    var html;
    if (ps != null || rs != null) {
      var diff = ps != null && rs != null && ps !== rs;
      html = '<div class="cmp-row' + (diff ? ' diff' : '') + '"><span class="k">开仓仓位</span><span>' +
        esc(ps == null ? '—' : ps) + (diff ? ' → <b>' + esc(rs) + '</b>' : '') + '</span></div>';
    } else {
      html = '<div class="cmp-row"><span class="k">自动比对</span><span style="color:var(--muted)">填入实际开仓仓位后，这里会显示与计划仓位的差值</span></div>';
    }
    $('#devCompare').innerHTML = html;
    var cbSize = $('#devChecks input[data-dev="sizeUp"]');
    if (ps != null && rs != null && rs > ps && cbSize) { cbSize.checked = true; clearNoneDev(); }
  }

  /* ---------------- 「无偏差」与具体偏差项互斥 ---------------- */
  function clearNoneDev() {
    var n = $('#devChecks input[data-dev="none"]');
    if (n) n.checked = false;
  }
  function clearOtherDevs() {
    $$('#devChecks input').forEach(function (b) { if (b.dataset.dev !== 'none') b.checked = false; });
  }
  function checkedDevs() {
    return $$('#devChecks input:checked').map(function (c) { return c.dataset.dev; });
  }
  // 互斥规则：点「无偏差」→ 清空其它；点任何具体项 → 「无偏差」取消。
  // 以「最后点的那个」为准，而不是让某一方永远优先。
  function normalizeDevs(target) {
    var none = $('#devChecks input[data-dev="none"]');
    if (!none) return;
    var dev = target && target.dataset ? target.dataset.dev : null;
    if (dev === 'none') { if (none.checked) clearOtherDevs(); return; }
    if (dev) { clearNoneDev(); return; }
    // 无事件来源时的兜底
    var others = $$('#devChecks input').filter(function (b) { return b.dataset.dev !== 'none'; });
    if (none.checked) clearOtherDevs();
    else if (others.some(function (b) { return b.checked; })) none.checked = false;
  }

  function syncCloseCompare() {
    var pstop = $('#f_planStop').value.trim(), rstop = $('#f_realStop').value.trim();
    var cbStop = $('#devChecks input[data-dev="stopMoved"]');
    if (rstop && pstop && rstop !== pstop && cbStop) { cbStop.checked = true; clearNoneDev(); }
    var le = $('#devChecks input[data-dev="lateExit"]');
    $('#lateDaysWrap').style.display = le && le.checked ? '' : 'none';
  }

  function syncPnlPreview() {
    var t = editingId ? byId(editingId) : null;
    var e = num('#f_entry') != null ? num('#f_entry') : (t && t.exec ? t.exec.entry : null);
    var x = num('#f_exit');
    var q = num('#f_closeSize') != null ? num('#f_closeSize') : (num('#f_openSize') != null ? num('#f_openSize') : openQtyOf(t));
    var mult = num('#f_multiplier') != null ? num('#f_multiplier') : 1;
    var box = $('#pnlPreview');
    if (x == null) { box.innerHTML = '未关仓 · 填了「实际出场价」之后才会结算盈亏得失。'; return; }
    if (e == null || q == null) { box.innerHTML = '还需补上实际开仓价与实际仓位，才能算出盈亏。'; return; }
    var v = ($('#f_direction').value === 'short' ? (e - x) : (x - e)) * q * mult;
    var manual = num('#f_pnl');
    box.innerHTML = '结算：（' + e + ' − ' + x + '）× ' + q + (mult !== 1 ? ' × ' + mult : '') + ' = <b style="color:' +
      (v >= 0 ? 'var(--up)' : 'var(--down)') + '">' + money(v) + '</b>' +
      (manual != null && Math.round(manual) !== Math.round(v) ? ' <span style="color:var(--warn)">（已手动覆盖为 ' + money(manual) + '）</span>' : '');
  }

  function autoPnl() {
    var e = num('#f_entry'), x = num('#f_exit');
    var q = num('#f_closeSize') != null ? num('#f_closeSize') : num('#f_openSize');
    var mult = num('#f_multiplier') != null ? num('#f_multiplier') : 1;
    if (e != null && x != null && q != null && $('#f_pnl').value.trim() === '') {
      var v = ($('#f_direction').value === 'short' ? (e - x) : (x - e)) * q * mult;
      $('#f_pnl').value = Math.round(v * 100) / 100;
    }
    syncPnlPreview();
    syncCatSuggest();
  }

  function syncCatSuggest() {
    var devs = checkedDevs().filter(function (d) { return d !== 'none'; });
    var p = num('#f_pnl');
    var closed = num('#f_exit') != null;
    var el = $('#catSuggest');
    if (!closed) {
      el.innerHTML = '这笔还在持仓中 —— <b>关仓之后再贴标签</b>。四类里没有「还没走」这一档。';
      return;
    }
    var cat = null;
    if (p != null || devs.length) {
      if (!devs.length) cat = (p == null || p > 0) ? 'A' : 'B';
      else cat = (p == null || p <= 0) ? 'C' : 'D';
    }
    if (!cat) { el.innerHTML = '填完盈亏与偏差后，这里会给一个建议归类，最终以你的判断为准。'; return; }
    var extra = cat === 'D' ? ' <b>这笔赚了，但它是破规矩赚的 —— 它会训练你下次继续破规矩。别把它记成功劳。</b>'
      : cat === 'C' ? ' 破规矩亏的，是你要修的地方。'
        : cat === 'B' ? ' 守规矩亏的，是成本，不用自责。' : ' 守规矩赚的，这是你的粮食。';
    el.innerHTML = '建议归类：<b>' + cat + ' ' + CAT_LABELS[cat] + '</b>（依据：' +
      (devs.length ? '偏差 ' + devs.length + ' 项' : '零偏差') + '，盈亏 ' + (p == null ? '未填' : money(p)) + '）' + extra;
  }

  function collect(t) {
    if (!t) {
      t = editingId ? byId(editingId) : null;
      if (!t) { t = { id: uid(), devs: [] }; store.push(t); editingId = t.id; }
    }
    t.date = $('#f_date').value || today();
    t.symbol = $('#f_symbol').value.trim();
    t.direction = $('#f_direction').value;
    t.plan = t.plan || {};
    t.plan.mode = currentMode() || t.plan.mode || null;
    t.plan.size = num('#f_planSize');
    t.plan.trigger = $('#f_trigger').value.trim();
    t.plan.stop = $('#f_planStop').value.trim();
    t.plan.exit = $('#f_planExit').value.trim();
    t.plan.exitNote = $('#f_planExitNote').value.trim();

    t.exec = t.exec || {};
    t.exec.entry = num('#f_entry');
    t.exec.openSize = num('#f_openSize');
    t.exec.closeDate = $('#f_closeDate').value || '';
    t.exec.exit = num('#f_exit');
    t.exec.closeSize = num('#f_closeSize');
    t.exec.realStop = $('#f_realStop').value.trim();
    t.exec.lateDays = num('#f_lateDays');
    t.exec.note = $('#f_execNote').value.trim();
    t.exec.multiplier = num('#f_multiplier');
    t.exec.pnl = t.exec.exit != null ? num('#f_pnl') : null;

    t.devs = checkedDevs();
    if (t.plan.mode === 'impulse' && t.devs.indexOf('impulse') < 0) {
      t.devs = t.devs.filter(function (d) { return d !== 'none'; });   // 随意开仓本身就是偏差，与「无偏差」互斥
      t.devs.push('impulse');
    }
    if (t.plan.unlockCount > 0 && t.devs.indexOf('planEdited') < 0) t.devs.push('planEdited');   // 事后改过计划，强制留痕

    t.state = {
      sleep: parseFloat($('#f_sleep').value),
      mood: $('#f_mood').value,
      conflict: $('#f_conflict').checked,
      prevLoss: $('#f_prevLoss').checked,
      prevWin: $('#f_prevWin').checked,
      busy: $('#f_busy').checked,
      note: $('#f_stateNote').value.trim(),
      extraNote: $('#f_stateExtra').value.trim()
    };

    t.review = t.review || {};
    t.review.market = $('#f_market').value;
    var hd = num('#f_holdDays');
    if (hd == null) hd = daysBetween(t.date, t.exec.closeDate);
    t.review.holdDays = hd;
    t.review.lesson = $('#f_lesson').value.trim();
    var sel = $('#catPicker .cat-opt.sel');
    if (sel) t.review.cat = sel.dataset.cat;

    t.status = t.exec.exit != null ? 'closed' : 'open';
    return t;
  }

  function saveTrade(forceOpen) {
    var t = editingId ? byId(editingId) : null;
    if (!t || !t.plan || !t.plan.lockedAt) { alert('计划还没锁定。没有事前写下来的条件，这笔记录就没有意义。'); gotoStep(1); return; }
    collect(t);
    if (t.status === 'open') {
      t.exec.pnl = null;
      if (!forceOpen && !confirm('还没填「实际出场价」—— 先存为持仓中？之后随时点「关仓结算」再结算。')) return;
    } else if (!t.review.cat) {
      alert('这笔已关仓，还没贴标签 —— 收盘后四选一，一分钟的事。');
      gotoStep(4);
      return;
    }
    save(); closeModal(); renderAll();
  }

  function closeModal() {
    var t = editingId ? byId(editingId) : null;
    if (t && t.plan && t.plan.lockedAt) {           // 锁定过的记录，关窗即落盘
      collect(t);
      if (t.status === 'open') t.exec.pnl = null;
      save();
    }
    $('#modalMask').classList.add('hidden');
    editingId = null;
    renderAll();
  }

  /* ---------------- 月度复盘 ---------------- */
  function renderReview() {
    var m = $('#reviewMonth').value;
    var items = store.filter(function (t) { return isClosed(t) && monthOf(t) === m; });
    var box = $('#reviewBody');
    if (!items.length) {
      box.innerHTML = '<div class="empty">' + monthLabel(m) + ' 没有已关仓的记录。换一个月份，或者先去关掉两笔仓。</div>';
      return;
    }
    var prevM = prevMonth(m);
    var reviewed = items.filter(function (t) { return t.review && t.review.cat; });
    var brk = reviewed.filter(isBreak);
    var prevBrk = store.filter(function (t) { return isClosed(t) && monthOf(t) === prevM && t.review && t.review.cat; }).filter(isBreak).length;
    var base = reviewed.length ? reviewed : items;

    /* --- 第一问 --- */
    var months = [], mm = m;
    for (var i = 0; i < 6; i++) { months.unshift(mm); mm = prevMonth(mm); }
    var series = months.map(function (mo) {
      var it = store.filter(function (t) { return isClosed(t) && monthOf(t) === mo && t.review && t.review.cat; });
      return { m: mo, n: it.filter(isBreak).length, total: it.length };
    });
    var maxN = Math.max.apply(null, series.map(function (s) { return s.n; }).concat([1]));
    var bars = series.map(function (s) {
      var h = Math.round(s.n / maxN * 54);
      return '<div class="bar-wrap"><div class="bar' + (s.m === m ? ' bad' : '') + '" style="height:' + Math.max(h, 2) + 'px"></div>' +
        '<span class="bar-lbl">' + Number(s.m.slice(5)) + '月</span></div>';
    }).join('');

    var delta = brk.length - prevBrk;
    var dcls = delta < 0 ? 'good' : delta > 0 ? 'bad' : 'flat';
    var dTxt = delta === 0 ? '与上月持平' : (delta < 0 ? '比上月少 ' + Math.abs(delta) + ' 次' : '比上月多 ' + delta + ' 次');
    var rate = base.length ? Math.round(brk.length / base.length * 100) : 0;

    var q1 = '<div class="q-block">' +
      '<div class="q-head"><span class="q-no">第一件事</span><span class="q-title">这个月破规矩的次数，比上个月多了还是少了？</span></div>' +
      '<div class="q-sub">盈亏里有运气，破规矩的次数里没有。这个数字比盈亏更能说明你的进步。</div>' +
      '<div class="big-row">' +
        '<div><div class="big-num">' + brk.length + '<small>次</small></div><div style="font-size:12px;color:var(--muted)">本月破规矩（C + D）</div></div>' +
        '<div><div class="big-num" style="font-size:22px">' + prevBrk + '<small>次</small></div><div style="font-size:12px;color:var(--muted)">' + monthLabel(prevM) + '</div></div>' +
        '<div class="delta ' + dcls + '">' + dTxt + '</div>' +
        '<div><div class="big-num" style="font-size:22px">' + rate + '%</div><div style="font-size:12px;color:var(--muted)">破规矩率（' + brk.length + '/' + base.length + '）</div></div>' +
      '</div>' +
      '<div class="bars">' + bars + '</div>' +
      '<div class="verdict ' + (delta > 0 ? 'bad' : rate >= 40 ? 'warn' : '') + '">' +
        (brk.length === 0
          ? '<strong>本月零破规矩。</strong>这就是进步本身 —— 哪怕这个月是亏的，只要每一笔都按写下来的做，曲线迟早会回来。'
          : delta > 0
            ? '<strong>破规矩次数在上升。</strong>本月 ' + brk.length + ' 次，上月 ' + prevBrk + ' 次。别急着看收益，先把这个数字压回去。'
            : delta < 0
              ? '<strong>在变好。</strong>破规矩从 ' + prevBrk + ' 次降到 ' + brk.length + ' 次。账户的反应会滞后于纪律，继续。'
              : '<strong>持平。</strong>破规矩 ' + brk.length + ' 次，占 ' + rate + '%。目标很明确：下个月比这个数字小。') +
      '</div></div>';

    /* --- 第二问 --- */
    var withPnl = items.filter(function (t) { return pnlOf(t) != null; });
    var losers = withPnl.slice().sort(function (a, b) { return pnlOf(a) - pnlOf(b); }).slice(0, 3);
    var q2 = '';
    if (!losers.length) {
      q2 = '<div class="q-block"><div class="q-head"><span class="q-no">第二件事</span><span class="q-title">亏得最多的三笔，是不是同一类？</span></div><div class="q-sub">本月没有已关仓的亏损记录。</div></div>';
    } else {
      var tagCount = {};
      losers.forEach(function (t) {
        var ds = realDevs(t);
        ds.forEach(function (d) { tagCount[d] = (tagCount[d] || 0) + 1; });
        if (!ds.length) tagCount['__none'] = (tagCount['__none'] || 0) + 1;
      });
      var topTag = null, topN = 0;
      Object.keys(tagCount).forEach(function (k) { if (tagCount[k] > topN) { topN = tagCount[k]; topTag = k; } });

      var rows = losers.map(function (t) {
        var devs = realDevs(t);
        return '<tr><td>' + esc((t.exec.closeDate || t.date).slice(5)) + '</td>' +
          '<td>' + esc(t.symbol || '—') + '</td>' +
          '<td style="color:var(--down);font-weight:600">' + money(pnlOf(t)) + '</td>' +
          '<td>' + (devs.length ? '<div class="tags-line">' + devs.map(function (d) {
            return '<span class="mini-tag' + (d === topTag && topN > 1 ? ' hot' : '') + '">' + DEV_LABELS[d] + '</span>';
          }).join('') + '</div>' : '<span class="mini-tag good">零偏差</span>') + '</td>' +
          '<td>' + ((t.review && t.review.cat) ? '<span class="cat-tag ' + t.review.cat.toLowerCase() + '">' + t.review.cat + '</span>' : '—') + '</td>' +
          '<td>' + esc((t.review && t.review.lesson) || (t.exec && t.exec.note) || '—') + '</td></tr>';
      }).join('');

      var hist = { n: 0, sum: 0 };
      store.filter(isClosed).forEach(function (t) {
        if (realDevs(t).indexOf(topTag) >= 0 && pnlOf(t) != null) { hist.n++; hist.sum += pnlOf(t); }
      });

      q2 = '<div class="q-block">' +
        '<div class="q-head"><span class="q-no">第二件事</span><span class="q-title">亏得最多的三笔，它们是不是同一类？</span></div>' +
        '<div class="q-sub">多数人会惊讶地发现：一年里绝大部分的亏损，都来自同一个动作的反复上演。</div>' +
        '<table class="mini"><thead><tr><th>关仓日</th><th>标的</th><th>盈亏</th><th>偏差动作</th><th>归类</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="verdict ' + (topTag && topN > 1 && topTag !== '__none' ? 'bad' : '') + '">' +
          (topTag && topN > 1 && topTag !== '__none'
            ? '<strong>是同一类。</strong>亏损前三笔里有 ' + topN + ' 笔出现了同一个动作：<b>' + DEV_LABELS[topTag] + '</b>。' +
              '历史上这个动作共出现 <b>' + hist.n + '</b> 次，合计 <b>' + money(hist.sum) + '</b>。你不用改十个毛病，你只要改这一个。'
            : topTag === '__none'
              ? '<strong>亏损前三笔都是零偏差。</strong>它们守规矩了还是亏 —— 这是成本，不是错误。要检查的是策略本身（信号是否失效、止损是否太紧），而不是你的手。'
              : '<strong>暂时还看不出共同点。</strong>样本还不够，继续记 —— 这个结论通常要几十笔才浮出来。') +
        '</div></div>';
    }

    /* --- 第三问 --- */
    var winners = withPnl.slice().sort(function (a, b) { return pnlOf(b) - pnlOf(a); }).slice(0, 3);
    var q3 = '';
    if (!winners.length) {
      q3 = '<div class="q-block"><div class="q-head"><span class="q-no">第三件事</span><span class="q-title">赚得最多的三笔，当时你在做什么？</span></div><div class="q-sub">本月没有已关仓的盈利记录。</div></div>';
    } else {
      var rowsW = winners.map(function (t) {
        var clean = !isBreak(t);
        return '<tr><td>' + esc((t.exec.closeDate || t.date).slice(5)) + '</td>' +
          '<td>' + esc(t.symbol || '—') + '</td>' +
          '<td style="color:var(--up);font-weight:600">' + money(pnlOf(t)) + '</td>' +
          '<td>' + esc((t.review && t.review.market) || '未标注') + '</td>' +
          '<td>' + ((t.review && t.review.holdDays != null) ? t.review.holdDays + ' 天' : '—') + '</td>' +
          '<td>' + (clean ? '<span class="mini-tag good">守规矩</span>' : '<span class="mini-tag hot">破规矩</span>') + '</td>' +
          '<td>' + esc((t.review && t.review.lesson) || '—') + '</td></tr>';
      }).join('');

      var mkCount = {};
      winners.forEach(function (t) { var k = (t.review && t.review.market) || '未标注'; mkCount[k] = (mkCount[k] || 0) + 1; });
      var topMk = null, mn = 0;
      Object.keys(mkCount).forEach(function (k) { if (mkCount[k] > mn) { mn = mkCount[k]; topMk = k; } });
      var cleanW = winners.filter(function (t) { return !isBreak(t); }).length;
      var avgHold = winners.filter(function (t) { return t.review && t.review.holdDays != null; });
      var avg = avgHold.length ? Math.round(avgHold.reduce(function (s, t) { return s + t.review.holdDays; }, 0) / avgHold.length) : null;

      var mkAll = { n: 0, sum: 0 };
      store.filter(isClosed).forEach(function (t) {
        if (((t.review && t.review.market) || '未标注') === topMk && pnlOf(t) != null) { mkAll.n++; mkAll.sum += pnlOf(t); }
      });

      q3 = '<div class="q-block">' +
        '<div class="q-head"><span class="q-no">第三件事</span><span class="q-title">赚得最多的三笔，当时是什么样的行情，你在做什么？</span></div>' +
        '<div class="q-sub">那种机会一年出现几次 —— 你将来要靠的，就是它们。</div>' +
        '<table class="mini"><thead><tr><th>关仓日</th><th>标的</th><th>盈亏</th><th>行情</th><th>持仓</th><th>是否守规矩</th><th>备注</th></tr></thead><tbody>' + rowsW + '</tbody></table>' +
        '<div class="verdict">' +
          (topMk && topMk !== '未标注'
            ? '<strong>你的粮食来自「' + esc(topMk) + '」。</strong>本月赚钱最多的三笔里有 ' + mn + ' 笔属于这类行情' +
              (avg != null ? '，平均持仓 <b>' + avg + ' 天</b>' : '') + '，其中 ' + cleanW + '/3 笔守规矩。' +
              '历史上这类行情共 <b>' + mkAll.n + '</b> 笔，合计 <b>' + money(mkAll.sum) + '</b>。把标准动作固化下来，别的行情少伸手。'
            : '<strong>还没标注行情类型。</strong>给每笔交易选一个行情标签，几次之后这里就能告诉你：哪类行情值得等，哪类不值得。') +
        '</div></div>';
    }

    /* --- 开仓性质 --- */
    var imp = reviewed.filter(function (t) { return t.plan && t.plan.mode === 'impulse'; });
    var pln = reviewed.filter(function (t) { return t.plan && t.plan.mode === 'planned'; });
    var si = statOf(imp), sp = statOf(pln);
    var q0 = '';
    if (imp.length || pln.length) {
      q0 = '<div class="q-block">' +
        '<div class="q-head"><span class="q-title">计划开仓 vs 随意开仓</span></div>' +
        '<div class="q-sub">「随意开仓」那一栏，是唯一一个不需要技术、只需要不下单就能消掉的亏损来源。</div>' +
        '<div class="grid-cards">' +
          '<div class="stat-card' + (imp.length ? ' alert' : '') + '"><div class="t">随意开仓</div>' +
            '<div class="v">' + imp.length + ' <small style="font-size:12px;color:var(--muted);font-weight:400">笔</small></div>' +
            '<div class="d">' + (si.avg == null ? '—' : '胜率 ' + si.win + '% · 均 ' + money(si.avg) + ' · 合计 ' + money(si.sum)) + '</div></div>' +
          '<div class="stat-card"><div class="t">计划开仓</div>' +
            '<div class="v">' + pln.length + ' <small style="font-size:12px;color:var(--muted);font-weight:400">笔</small></div>' +
            '<div class="d">' + (sp.avg == null ? '—' : '胜率 ' + sp.win + '% · 均 ' + money(sp.avg) + ' · 合计 ' + money(sp.sum)) + '</div></div>' +
        '</div>' +
        (imp.length
          ? '<div class="verdict ' + (si.avg != null && si.avg < 0 ? 'bad' : 'warn') + '">' +
            '<strong>本月随意开仓 ' + imp.length + ' 笔</strong>，占已复盘笔数的 ' + Math.round(imp.length / reviewed.length * 100) + '%' +
            (si.avg != null ? '，平均单笔 <b>' + money(si.avg) + '</b>，合计 <b>' + money(si.sum) + '</b>' : '') + '。' +
            '这一项不需要改进技术，只需要一件事：没有事前写下来的条件，就不下单。下个月把这个数字压到 0。' +
            '</div>'
          : '<div class="verdict"><strong>本月零随意开仓。</strong>每一笔都是事前写下来的 —— 这本身就是纪律。</div>') +
        '</div>';
    }

    /* --- 四类分布 --- */
    var cnt = { A: 0, B: 0, C: 0, D: 0 }, sum = { A: 0, B: 0, C: 0, D: 0 };
    reviewed.forEach(function (t) {
      var c = t.review.cat; cnt[c]++; var p = pnlOf(t); if (p != null) sum[c] += p;
    });
    var dist = '<div class="q-block">' +
      '<div class="q-head"><span class="q-title">本月四类分布</span></div>' +
      '<div class="q-sub">A 是粮食，B 是成本，C 是要修的地方，D 是下一次大亏的种子。</div>' +
      '<div class="grid-cards">' +
      ['A', 'B', 'C', 'D'].map(function (c) {
        return '<div class="stat-card' + (c === 'D' && cnt.D ? ' alert' : '') + '">' +
          '<div class="t"><span class="cat-tag ' + c.toLowerCase() + '" style="margin-right:6px">' + c + '</span>' + CAT_LABELS[c] + '</div>' +
          '<div class="v">' + cnt[c] + ' <small style="font-size:12px;color:var(--muted);font-weight:400">笔</small></div>' +
          '<div class="d">合计 ' + money(sum[c]) + '</div></div>';
      }).join('') + '</div>' +
      (cnt.D ? '<div class="verdict warn"><strong>本月有 ' + cnt.D + ' 笔「破规矩居然赚了」。</strong>这类交易最危险：它用盈利奖励了你一次错误的动作，下一次同样动作大概率会带走更多。把它当成亏损来复盘。</div>' : '') +
      '</div>';

    box.innerHTML = q1 + q0 + q2 + q3 + dist;
  }

  /* ---------------- 状态洞察 ---------------- */
  function renderInsight() {
    var box = $('#insightBody');
    var items = store.filter(isReviewed);
    if (items.length < 3) {
      box.innerHTML = '<div class="empty">至少要 3 笔已关仓且已归类的记录，状态与失手的关联才会开始显形。现在有 ' + items.length + ' 笔。</div>';
      return;
    }

    function groupStat(name, filterFn) {
      var it = items.filter(filterFn);
      if (!it.length) return null;
      var b = it.filter(isBreak).length;
      var s = 0, n = 0;
      it.forEach(function (t) { var p = pnlOf(t); if (p != null) { s += p; n++; } });
      return { name: name, n: it.length, brk: b, rate: Math.round(b / it.length * 100), avg: n ? Math.round(s / n) : null, sum: n ? s : null };
    }

    function block(title, sub, groups, conclusionFn) {
      var gs = groups.filter(Boolean);
      if (!gs.length) return '';
      var worst = gs.slice().sort(function (a, b) { return b.rate - a.rate; })[0];
      var best = gs.slice().sort(function (a, b) { return a.rate - b.rate; })[0];
      return '<div class="q-block">' +
        '<div class="q-head"><span class="q-title">' + title + '</span></div>' +
        (sub ? '<div class="q-sub">' + sub + '</div>' : '') +
        '<table class="mini"><thead><tr><th>状态</th><th>笔数</th><th>破规矩率</th><th>平均盈亏</th><th>合计盈亏</th></tr></thead><tbody>' +
        gs.map(function (g) {
          return '<tr><td>' + g.name + '</td><td>' + g.n + '</td>' +
            '<td><b style="color:' + (g.rate >= 50 ? 'var(--up)' : g.rate >= 25 ? 'var(--warn)' : 'var(--down)') + '">' + g.rate + '%</b> (' + g.brk + '/' + g.n + ')</td>' +
            '<td style="color:' + (g.avg == null ? 'var(--muted)' : g.avg >= 0 ? 'var(--up)' : 'var(--down)') + '">' + (g.avg == null ? '—' : money(g.avg)) + '</td>' +
            '<td style="color:' + (g.sum == null ? 'var(--muted)' : g.sum >= 0 ? 'var(--up)' : 'var(--down)') + '">' + (g.sum == null ? '—' : money(g.sum)) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="verdict ' + (worst.rate >= 50 ? 'bad' : '') + '">' + conclusionFn(worst, best) + '</div></div>';
    }

    var h = '';
    h += block('睡眠 vs 失手', '睡几个小时和破规矩的关系 —— 只有你自己的数据能回答。', [
      groupStat('睡眠 < 6 小时', function (t) { return t.state && t.state.sleep != null && t.state.sleep < 6; }),
      groupStat('睡眠 6–7 小时', function (t) { return t.state && t.state.sleep >= 6 && t.state.sleep < 7.5; }),
      groupStat('睡眠 ≥ 7.5 小时', function (t) { return t.state && t.state.sleep >= 7.5; })
    ], function (w, b) {
      if (w === b) return '样本还少，看不出差别。继续记。';
      return '<strong>睡得越少，手越容易乱。</strong>「' + w.name + '」时破规矩率 <b>' + w.rate + '%</b>；「' + b.name + '」时只有 <b>' + b.rate + '%</b>。' +
        (w.avg != null && b.avg != null ? '平均盈亏 ' + money(w.avg) + ' vs ' + money(b.avg) + '。' : '') +
        ' 差别不在行情，在你。状态不对的时候，最好的仓位是零。';
    });

    h += block('情绪 vs 失手', '', [
      groupStat('稳', function (t) { return t.state && t.state.mood === 'calm'; }),
      groupStat('一般', function (t) { return t.state && t.state.mood === 'neutral'; }),
      groupStat('急', function (t) { return t.state && t.state.mood === 'urgent'; }),
      groupStat('怕踏空 / 手痒', function (t) { return t.state && t.state.mood === 'fomo'; }),
      groupStat('想扳回来', function (t) { return t.state && t.state.mood === 'revenge'; })
    ], function (w) {
      return '<strong>最容易失手的状态是「' + w.name + '」</strong>，破规矩率 <b>' + w.rate + '%</b>（' + w.brk + '/' + w.n + ' 笔）。' +
        '把它写成一条硬规则：只要出现这种状态，当天不下新单。';
    });

    h += block('前置事件 vs 失手', '上一笔刚亏过、刚吵完架 —— 这些才是真正的风险因子。', [
      groupStat('上一笔刚亏过', function (t) { return t.state && t.state.prevLoss; }),
      groupStat('上一笔刚大赚', function (t) { return t.state && t.state.prevWin; }),
      groupStat('有情绪波动', function (t) { return t.state && t.state.conflict; }),
      groupStat('看盘碎片化', function (t) { return t.state && t.state.busy; }),
      groupStat('以上都没有', function (t) {
        var s = t.state || {};
        return !s.prevLoss && !s.prevWin && !s.conflict && !s.busy;
      })
    ], function (w, b) {
      return '<strong>「' + w.name + '」时破规矩率 ' + w.rate + '%</strong>，是这组里最高的。' +
        (b ? '对照「' + b.name + '」的 ' + b.rate + '%。' : '') + ' 这不是巧合，是规律 —— 把它列进你的禁止下单清单。';
    });

    var impAll = items.filter(function (t) { return t.plan && t.plan.mode === 'impulse'; });
    var plnAll = items.filter(function (t) { return t.plan && t.plan.mode === 'planned'; });
    if (impAll.length && plnAll.length) {
      var a = statOf(impAll), c = statOf(plnAll);
      h += '<div class="q-block">' +
        '<div class="q-head"><span class="q-title">计划开仓 vs 随意开仓（全部历史）</span></div>' +
        '<div class="q-sub">随意开仓哪怕赚钱，也是在奖励一个不可复制的动作。</div>' +
        '<table class="mini"><thead><tr><th>开仓性质</th><th>笔数</th><th>胜率</th><th>平均盈亏</th><th>合计盈亏</th></tr></thead><tbody>' +
        [['随意开仓', a], ['计划开仓', c]].map(function (r) {
          return '<tr><td>' + r[0] + '</td><td>' + r[1].n + '</td>' +
            '<td>' + (r[1].win == null ? '—' : r[1].win + '%') + '</td>' +
            '<td style="color:' + (r[1].avg == null ? 'var(--muted)' : r[1].avg >= 0 ? 'var(--up)' : 'var(--down)') + '">' + (r[1].avg == null ? '—' : money(r[1].avg)) + '</td>' +
            '<td style="color:' + (r[1].sum == null ? 'var(--muted)' : r[1].sum >= 0 ? 'var(--up)' : 'var(--down)') + '">' + (r[1].sum == null ? '—' : money(r[1].sum)) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="verdict ' + (a.avg != null && c.avg != null && a.avg < c.avg ? 'bad' : '') + '">' +
        '随意开仓 <b>' + a.n + '</b> 笔' + (a.avg != null ? '，平均 <b>' + money(a.avg) + '</b>、合计 <b>' + money(a.sum) + '</b>' : '') +
        '；计划开仓 <b>' + c.n + '</b> 笔' + (c.avg != null ? '，平均 <b>' + money(c.avg) + '</b>、合计 <b>' + money(c.sum) + '</b>' : '') + '。' +
        (a.sum != null && c.sum != null && a.sum < 0 ? ' 把随意开仓那一栏清零，你不需要学任何新东西，只要不动手。' : '') +
        '</div></div>';
    }

    box.innerHTML = h;
  }

  /* ---------------- 数据 ---------------- */
  function refreshMonthSelects() {
    var months = {};
    store.forEach(function (t) { var m = monthOf(t); if (m) months[m] = 1; });
    var list = Object.keys(months).sort().reverse();
    var fm = $('#filterMonth'), rm = $('#reviewMonth');
    var fv = fm.value, rv = rm.value;
    fm.innerHTML = '<option value="">全部月份</option>' + list.map(function (m) {
      return '<option value="' + m + '">' + monthLabel(m) + '</option>';
    }).join('');
    rm.innerHTML = list.length ? list.map(function (m) {
      return '<option value="' + m + '">' + monthLabel(m) + '</option>';
    }).join('') : '<option value="' + ym(today()) + '">' + monthLabel(ym(today())) + '</option>';
    if (fv && list.indexOf(fv) >= 0) fm.value = fv;
    rm.value = (rv && list.indexOf(rv) >= 0) ? rv : (list.indexOf(ym(today())) >= 0 ? ym(today()) : (list[0] || ym(today())));

    var syms = {};
    store.forEach(function (t) { if (t.symbol) syms[t.symbol] = 1; });
    $('#symbolList').innerHTML = Object.keys(syms).map(function (s) { return '<option value="' + esc(s) + '">'; }).join('');
  }

  function renderAll() {
    refreshMonthSelects();
    renderKpi(); renderList(); renderReview(); renderInsight();
  }

  function toCSV() {
    var head = ['状态', '开仓日期', '关仓日期', '标的', '方向', '开仓性质', '触发条件', '计划止损', '计划仓位', '实际开仓价', '实际开仓仓位', '出场价', '实际出场仓位', '实际止损', '盈亏', '偏差动作', '晚走天数', '持仓天数', '睡眠', '情绪', '状态标记', '状态补充', '行情', '归类', '总结'];
    var rows = store.slice().sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); }).map(function (t) {
      var s = t.state || {}, r = t.review || {}, e = t.exec || {}, p = t.plan || {};
      var flags = [s.conflict ? '有情绪波动' : '', s.prevLoss ? '上笔刚亏' : '', s.prevWin ? '上笔刚赚' : '', s.busy ? '看盘碎片化' : ''].filter(Boolean).join(' ');
      return [
        isClosed(t) ? '已关仓' : '持仓中', t.date, e.closeDate, t.symbol, t.direction === 'short' ? '做空' : '做多',
        p.mode === 'impulse' ? '随意开仓' : p.mode === 'planned' ? '计划开仓' : '',
        p.trigger, p.stop, p.size, e.entry, openQtyOf(t), e.exit, e.closeSize, realStopOf(t),
        pnlOf(t), realDevs(t).map(function (d) { return DEV_LABELS[d]; }).join(' '),
        e.lateDays, r.holdDays, s.sleep, MOOD_LABELS[s.mood] || '', flags, s.extraNote, r.market, r.cat, r.lesson
      ].map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    });
    return '\ufeff' + head.join(',') + '\n' + rows.join('\n');
  }

  /* ---------------- 导出 ---------------- */
  var lastExport = null;

  // 真正落盘的下载。注意：不能在 click() 之后立刻 revokeObjectURL，
  // Chrome / Edge 会在文件还没写完时把下载掐掉，表现就是「点了没反应」。
  function download(name, content, type) {
    var url;
    try {
      var blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
      url = URL.createObjectURL(blob);
    } catch (err) { return false; }
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    var ok = true;
    try { a.click(); } catch (err) { ok = false; }
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 4000);
    return ok;
  }

  // 判断是否跑在内嵌预览窗口里（这种环境浏览器默认拦截下载）
  function inFrame() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }

  function toast(msg, actionText, fn, ms) {
    var wrap = $('#toastWrap');
    if (!wrap) return null;
    var el = document.createElement('div');
    el.className = 'toast';
    el.appendChild(Object.assign(document.createElement('span'), { textContent: msg }));
    var timer = null;
    if (actionText) {
      var b = document.createElement('button');
      b.className = 'toast-btn';
      b.textContent = actionText;
      b.addEventListener('click', function () { kill(); if (fn) fn(); });
      el.appendChild(b);
    }
    function kill() {
      if (timer) clearTimeout(timer);
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    timer = setTimeout(kill, ms || 8000);
    wrap.appendChild(el);
    return el;
  }

  function copyText(str, ta) {
    function fallback() {
      try {
        ta.focus(); ta.select();
        var ok = document.execCommand('copy');
        toast(ok ? '已复制，粘贴进记事本另存即可' : '复制失败，请手动全选复制');
      } catch (e) { toast('复制失败，请手动全选复制'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(function () {
        toast('已复制，粘贴进记事本另存即可');
      })['catch'](fallback);
    } else { fallback(); }
  }

  function exportFile(name, content, type) {
    $('#dataMenu').classList.add('hidden');
    lastExport = { name: name, content: content, type: type };
    var ok = download(name, content, type);
    if (inFrame() || !ok) {
      showExportPanel();
    } else {
      toast('已开始下载 ' + name, '没反应？', showExportPanel);
    }
  }

  function showExportPanel() {
    if (!lastExport) return;
    $('#exportHint').innerHTML = '文件：<b>' + esc(lastExport.name) + '</b>（' + lastExport.content.length.toLocaleString('zh-CN') +
      ' 字符）<br>如果刚才没有跳出保存提示，多半是当前预览窗口拦截了下载 —— 用下面任一方式取走内容即可。';
    $('#exportName').textContent = lastExport.name;
    $('#exportText').value = lastExport.content;
    $('#exportMask').classList.remove('hidden');
  }

  function hideExportPanel() { $('#exportMask').classList.add('hidden'); }

  /* ---------------- 演示数据 ---------------- */
  function demoData() {
    var syms = ['金斯瑞 1548.HK', '信达生物 1801.HK', '康方生物 9926.HK', '凯莱英 002821', '药明康德 603259', '恒瑞医药 600276'];
    var triggers = [
      '放量突破20日箱体上沿，板块同步翻红',
      '回踩MA20不破且缩量，南向连续净流入',
      'BD 交易落地后回踩确认，量能未散',
      '日线底背离 + 周线趋势未破',
      '业绩预告超预期，跳空缺口未回补'
    ];
    var markets = ['趋势突破', '回调企稳', '消息/事件驱动', '业绩驱动', '超跌反弹', '板块轮动'];
    var lessons = ['按计划吃到趋势段，别被日内噪音晃出去', '信号成立但仓位偏重，下次等回踩再加', '逻辑失效就该走，不要等解套', '计划内的止损就是成本，接受它'];
    var out = [];
    var months = [prevMonth(prevMonth(ym(today()))), prevMonth(ym(today())), ym(today())];
    var id = 0;
    months.forEach(function (mo, mi) {
      var n = [9, 11, 8][mi];
      for (var i = 0; i < n; i++) {
        id++;
        var day = String(1 + Math.floor(Math.random() * 22)).padStart(2, '0');
        var holding = (mi === 2 && i >= n - 2);          // 最近两笔仍持仓中
        var r = Math.random();
        var devs = [];
        if (r < 0.34) devs.push('lateExit');
        if (r > 0.72) devs.push('stopMoved');
        if (r > 0.85) devs.push('sizeUp');
        if (r > 0.86) devs.push('impulse');
        if (devs.length && Math.random() < 0.25) devs = [];
        var clean = devs.length === 0;
        var win = clean ? Math.random() < 0.62 : Math.random() < 0.3;
        var mag = Math.round(500 + Math.random() * 9000);
        var pnl = win ? mag : -Math.round(mag * (0.4 + Math.random() * 0.9));
        var cat = clean ? (win ? 'A' : 'B') : (win ? 'D' : 'C');
        var planSize = 1000 + Math.floor(Math.random() * 4) * 500;
        var late = devs.indexOf('lateExit') >= 0 ? 1 + Math.floor(Math.random() * 3) : null;
        var closeDay = String(Math.min(28, Number(day) + 1 + Math.floor(Math.random() * 6))).padStart(2, '0');
        var entry = +(18 + Math.random() * 30).toFixed(2);
        out.push({
          id: 'demo' + id,
          date: mo + '-' + day,
          symbol: syms[Math.floor(Math.random() * syms.length)],
          direction: Math.random() < 0.85 ? 'long' : 'short',
          status: holding ? 'open' : 'closed',
          plan: {
            mode: devs.indexOf('impulse') >= 0 ? 'impulse' : 'planned',
            size: planSize,
            trigger: triggers[Math.floor(Math.random() * triggers.length)],
            stop: '跌破 ' + (15 + Math.random() * 20).toFixed(1),
            exit: '到 ' + (25 + Math.random() * 20).toFixed(1) + ' 减半',
            exitNote: '',
            lockedAt: mo + '-' + day + 'T09:2' + (i % 9)
          },
          exec: {
            entry: entry,
            openSize: devs.indexOf('sizeUp') >= 0 ? planSize + 500 : planSize,
            closeDate: holding ? '' : mo + '-' + closeDay,
            exit: holding ? null : +(18 + Math.random() * 30).toFixed(2),
            closeSize: null,
            realStop: devs.indexOf('stopMoved') >= 0 ? '挪到 ' + (13 + Math.random() * 18).toFixed(1) : '',
            note: devs.length ? '当时觉得还能再等等' : '',
            multiplier: 1, lateDays: late,
            pnl: holding ? null : pnl
          },
          devs: devs,
          state: {
            sleep: [4.5, 5.5, 6, 6.5, 7, 7.5, 8][Math.floor(Math.random() * 7)],
            mood: ['calm', 'calm', 'neutral', 'urgent', 'fomo', 'revenge'][Math.floor(Math.random() * 6)],
            conflict: Math.random() < 0.15,
            prevLoss: Math.random() < 0.3,
            prevWin: Math.random() < 0.15,
            busy: Math.random() < 0.3,
            note: ''
          },
          review: holding ? {} : {
            cat: cat,
            market: markets[Math.floor(Math.random() * markets.length)],
            holdDays: 1 + Math.floor(Math.random() * 25),
            lesson: lessons[Math.floor(Math.random() * lessons.length)]
          }
        });
      }
    });
    return out;
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $$('.tab').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.tab').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        $$('.view').forEach(function (v) { v.classList.remove('active'); });
        $('#view-' + b.dataset.view).classList.add('active');
        if (b.dataset.view === 'review') renderReview();
        if (b.dataset.view === 'insight') renderInsight();
      });
    });

    $('#btnNew').addEventListener('click', function () { openModal(null, 'open'); });
    $('#btnClosePos').addEventListener('click', function () { openModal(null, 'close'); });
    $('#btnCloseModal').addEventListener('click', closeModal);
    $('#modalMask').addEventListener('click', function (e) { if (e.target === $('#modalMask')) closeModal(); });

    $('#btnLock').addEventListener('click', lockPlan);
    $('#btnGotoClose').addEventListener('click', function () { gotoStep(2); });
    $('#btnUnlock').addEventListener('click', unlockPlan);
    $('#btnUnlockOpen').addEventListener('click', unlockPlan);
    $('#btnSave').addEventListener('click', function () { saveTrade(false); });
    $('#btnSaveOpen').addEventListener('click', function () { saveTrade(true); });
    $('#btnSaveOpen2').addEventListener('click', function () { saveTrade(true); });

    $$('#stepBar .step').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.classList.contains('locked')) { alert('先把第 1 步的开仓计划锁定。'); return; }
        gotoStep(Number(b.dataset.step));
      });
    });
    $$('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () { gotoStep(Number(b.dataset.nav)); });
    });

    ['#f_planSize', '#f_openSize', '#f_realStop', '#f_planStop', '#f_entry', '#f_exit', '#f_closeSize', '#f_multiplier', '#f_direction']
      .forEach(function (s) { $(s).addEventListener('input', function () { syncOpenCompare(); syncCloseCompare(); autoPnl(); }); });
    $('#f_pnl').addEventListener('input', function () { syncPnlPreview(); syncCatSuggest(); });
    $('#devChecks').addEventListener('change', function (e) {
      normalizeDevs(e.target);          // 「无偏差」与具体偏差项互斥
      syncCloseCompare(); autoPnl(); syncCatSuggest();
      if (editingId) {
        var t = byId(editingId); collect(t);
        if (t.status === 'open') t.exec.pnl = null;
        save(); renderKpi(); renderList();
      }
    });
    $('#f_sleep').addEventListener('input', function () { $('#sleepVal').textContent = $('#f_sleep').value + ' h'; });

    $('#modeSeg').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg-opt') : null;
      if (!b || b.disabled) return;
      $$('#modeSeg .seg-opt').forEach(function (x) { x.classList.toggle('sel', x === b); });
      syncMode();
    });

    $('#catPicker').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.cat-opt') : null;
      if (!b) return;
      $$('#catPicker .cat-opt').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
    });

    $('#f_closeTarget').addEventListener('change', function () {
      var t = editingId ? byId(editingId) : null;
      if (t) { collect(t); if (t.status === 'open') t.exec.pnl = null; save(); }
      openModal(this.value, 'close');
    });

    $('#tradeList').addEventListener('click', function (e) {
      var ub = e.target.closest ? e.target.closest('[data-unlock]') : null;
      if (ub) { e.stopPropagation(); openModal(ub.dataset.unlock, 'open'); unlockPlan(); return; }
      var btn = e.target.closest ? e.target.closest('[data-close]') : null;
      if (btn) { e.stopPropagation(); openModal(btn.dataset.close, 'close'); return; }
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (card) openModal(card.dataset.id, 'open');
    });

    $('#filterMonth').addEventListener('change', renderList);
    $('#filterCat').addEventListener('change', renderList);
    $('#filterDev').addEventListener('change', renderList);
    $('#reviewMonth').addEventListener('change', renderReview);

    $('#btnMenu').addEventListener('click', function (e) {
      e.stopPropagation();
      $('#dataMenu').classList.toggle('hidden');
    });
    document.addEventListener('click', function () { $('#dataMenu').classList.add('hidden'); });

    $('#dataMenu').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      var act = btn ? btn.dataset.act : (e.target.dataset && e.target.dataset.act);
      if (!act) return;
      $('#dataMenu').classList.add('hidden');
      if (act === 'export-json') {
        exportFile('交易日记备份_' + today() + '.json', JSON.stringify(store, null, 2), 'application/json');
      } else if (act === 'export-csv') {
        exportFile('交易日记_' + today() + '.csv', toCSV(), 'text/csv;charset=utf-8');
      } else if (act === 'import-json') {
        $('#fileInput').click();
      } else if (act === 'demo') {
        if (store.length && !confirm('载入演示数据会覆盖当前 ' + store.length + ' 笔记录，继续？')) return;
        store = demoData(); save(); renderAll();
      } else if (act === 'clear') {
        if (!confirm('确定清空全部 ' + store.length + ' 笔记录？此操作不可恢复，建议先导出备份。')) return;
        store = []; save(); renderAll();
      }
    });

    /* 导出兜底面板 */
    $('#btnExportClose').addEventListener('click', hideExportPanel);
    $('#exportMask').addEventListener('click', function (e) { if (e.target === this) hideExportPanel(); });
    $('#btnExportCopy').addEventListener('click', function () {
      if (lastExport) copyText(lastExport.content, $('#exportText'));
    });
    $('#btnExportRetry').addEventListener('click', function () {
      if (!lastExport) return;
      var ok = download(lastExport.name, lastExport.content, lastExport.type);
      if (ok && !inFrame()) toast('已再次请求下载 ' + lastExport.name);
      else toast('下载被当前窗口拒绝，请改用「复制全部内容」');
    });

    $('#fileInput').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(rd.result);
          if (!Array.isArray(d)) throw new Error('格式不对');
          if (!confirm('导入 ' + d.length + ' 笔记录，覆盖当前数据？')) return;
          store = d; save(); renderAll();
        } catch (err) { alert('导入失败：' + err.message); }
      };
      rd.readAsText(f);
      e.target.value = '';
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('#exportMask').classList.contains('hidden')) { hideExportPanel(); return; }
      if (!$('#modalMask').classList.contains('hidden')) closeModal();
    });
  }

  load(); bind(); renderAll();
})();
