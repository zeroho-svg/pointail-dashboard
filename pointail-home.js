/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 🏠 홈 (대표용 요약) (pointail-home.js)
 *
 *  첫 화면용 요약 뷰. "숫자 나열"이 아니라 "오늘 할 일"이 보이는 홈.
 *   · KPI 카드: 이번달 실행 매출 · 이번달 영업이익(비용 KV 반영) ·
 *               이번달 신규 가입 · 진행 캠페인 — 각각 전월비 델타, 클릭 시 상세 탭 이동
 *   · 월별 영업이익 미니 차트(올해, 순매출−비용)
 *   · 오늘의 액션: 이탈위험(60일+ 무신청) · 재영업(15~60일) · 첫 영업(가입만 미진행)
 *  금액은 원본 sd_vatIncl/sd_date 기준(매출·손익 화면과 동일). 비용은 Worker /costs.
 *  탭 버튼(tab-btn-home)·패널(tab-home)을 만들고 pointail-nav.js(v2)가 그룹 배치.
 *  원본 index.html은 수정하지 않는다(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var ACTIVE = ['모집중', '선정 완료', '등록 대기', '추가 모집중', '등록 완료', '일시 중지'];
  var COSTS = null;

  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s₩¥]/g, '')) || 0; }
  function f(v) { return Math.round(n(v)).toLocaleString('ko-KR'); }
  function comp(v) {
    v = Math.round(v || 0); var s = v < 0 ? '-' : ''; v = Math.abs(v);
    if (v >= 100000000) return s + (v / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
    if (v >= 10000) return s + Math.round(v / 10000).toLocaleString('ko-KR') + '만';
    return s + v.toLocaleString('ko-KR');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function camps() { return (typeof DB !== 'undefined' && DB && DB.camp) ? DB.camp : []; }
  function members() { return (typeof DB !== 'undefined' && DB && DB.member) ? DB.member : []; }
  function sdDate(r) { try { return (typeof sd_date === 'function') ? (sd_date(r) || '') : String(r.createdAt || '').slice(0, 10); } catch (e) { return ''; } }
  function sdVat(r, k) { try { return (typeof sd_vatIncl === 'function') ? sd_vatIncl(r, k) : n(r[k]); } catch (e) { return n(r[k]); } }
  function ym(d) { return String(d || '').slice(0, 7); }

  function pullCosts(cb) {
    fetch(WORKER + 'costs?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && Array.isArray(j.items)) COSTS = j.items; if (cb) cb(); })
      .catch(function () { if (cb) cb(); });
  }

  function stats() {
    var t = new Date(), cy = t.getFullYear();
    var curK = cy + '-' + ('0' + (t.getMonth() + 1)).slice(-2);
    var pv = new Date(cy, t.getMonth() - 1, 1);
    var prvK = pv.getFullYear() + '-' + ('0' + (pv.getMonth() + 1)).slice(-2);
    var o = { curK: curK, prvK: prvK, cy: cy, curMo: t.getMonth() + 1,
      cur: { gross: 0, net: 0, cost: 0 }, prv: { gross: 0, net: 0, cost: 0 },
      year: {}, active: 0, recruit: 0, joinCur: 0, joinPrv: 0,
      risk: 0, re: 0, first: 0, totCamps: camps().length };
    var i, k;
    for (i = 1; i <= 12; i++) { k = cy + '-' + ('0' + i).slice(-2); o.year[k] = { net: 0, cost: 0 }; }

    var last = {};
    camps().forEach(function (c) {
      var d = sdDate(c); if (d) {
        k = ym(d);
        var g = sdVat(c, 'execTotalAmount'), nt = sdVat(c, 'execNetAmount');
        if (k === curK) { o.cur.gross += g; o.cur.net += nt; }
        if (k === prvK) { o.prv.gross += g; o.prv.net += nt; }
        if (o.year[k]) o.year[k].net += nt;
        var co = String(c.corpName || '').trim();
        if (co && (!last[co] || d > last[co])) last[co] = d;
      }
      if (ACTIVE.indexOf(c.campaignStatus) >= 0) o.active++;
      if (c.campaignStatus === '모집중') o.recruit++;
    });
    (COSTS || []).forEach(function (it) {
      k = ym(it.date); var a = n(it.amount);
      if (k === curK) o.cur.cost += a;
      if (k === prvK) o.prv.cost += a;
      if (o.year[k]) o.year[k].cost += a;
    });
    var today = new Date();
    function days(d) { var x = (today - new Date(d)) / 86400000; return isFinite(x) ? Math.round(x) : null; }
    members().forEach(function (m) {
      var jk = ym(m.joinDate);
      if (jk === curK) o.joinCur++;
      if (jk === prvK) o.joinPrv++;
      var co = String(m.company || '').trim();
      var ld = co ? last[co] : null;
      if (!ld) { o.first++; return; }
      var s = days(ld);
      if (s == null) return;
      if (s > 60) o.risk++;
      else if (s > 14) o.re++;
    });
    return o;
  }

  function chip(cur, prv, goodUp) {
    if (!prv) return '';
    var d = Math.round((cur - prv) / Math.abs(prv) * 100);
    if (!isFinite(d)) return '';
    var up = d >= 0, good = goodUp ? up : !up, col = good ? '#128a3a' : '#c0392b';
    return ' <span style="font-size:11px;font-weight:600;color:' + col + '">' + (up ? '▲' : '▼') + Math.abs(d) + '%</span>';
  }
  function go(btnId) { var b = document.getElementById(btnId); if (b) b.click(); }

  function render() {
    var host = document.getElementById('tab-home'); if (!host) return;
    if (!camps().length && !members().length) {
      host.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#8a94a6;line-height:1.8">' +
        '<div style="font-size:34px;margin-bottom:10px">🏠</div>' +
        '<div style="font-size:16px;font-weight:700;color:#48505c">아직 데이터가 없습니다</div>' +
        '<div style="font-size:13px;margin-top:6px">상단 <b>⚡ API 동기화</b> 버튼을 누르면 캠페인·회원 데이터를 불러와 홈 요약이 표시됩니다.</div></div>';
      return;
    }
    var o = stats();
    var costReady = COSTS !== null;
    var curProf = o.cur.net - o.cur.cost, prvProf = o.prv.net - o.prv.cost;
    var t = new Date();
    var dateLabel = t.getMonth() + 1 + '월 ' + t.getDate() + '일 기준';

    function card(icon, label, value, sub, target, color) {
      return '<div onclick="document.getElementById(\'' + target + '\')&&document.getElementById(\'' + target + '\').click()" ' +
        'style="flex:1;min-width:180px;background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px;cursor:pointer" ' +
        'onmouseover="this.style.borderColor=\'#c9d2de\'" onmouseout="this.style.borderColor=\'#eef0f3\'">' +
        '<div style="font-size:12px;color:#8a94a6;line-height:1.4">' + icon + ' ' + esc(label) + '</div>' +
        '<div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.02em;color:' + (color || '#1a1f29') + '">' + value + '</div>' +
        '<div style="font-size:11.5px;color:#8a94a6;margin-top:4px;line-height:1.5">' + sub + '</div></div>';
    }
    var cards =
      card('💵', '이번달 실행 매출', comp(o.cur.gross) + '<span style="font-size:13px;font-weight:500;color:#8a94a6">원</span>',
        '전월 ' + comp(o.prv.gross) + chip(o.cur.gross, o.prv.gross, true), 'tab-btn-sales-dash', '#185fa5') +
      card('💰', '이번달 영업이익', costReady ? (comp(curProf) + '<span style="font-size:13px;font-weight:500;color:#8a94a6">원</span>') : '<span style="font-size:14px;color:#8a94a6">비용 불러오는 중…</span>',
        costReady ? ('전월 ' + comp(prvProf) + chip(curProf, prvProf, true) + ' · 순매출−비용') : '손익 오버뷰 기준', 'tab-btn-cost', curProf < 0 && costReady ? '#c0392b' : '#8e44ad') +
      card('👥', '이번달 신규 가입', o.joinCur + '<span style="font-size:13px;font-weight:500;color:#8a94a6">개</span>',
        '전월 ' + o.joinPrv + '개' + chip(o.joinCur, o.joinPrv, true), 'tab-btn-advmgr', '#128a3a') +
      card('📦', '진행 캠페인', o.active + '<span style="font-size:13px;font-weight:500;color:#8a94a6">건</span>',
        '모집중 ' + o.recruit + '건 · 전체 ' + o.totCamps + '건', 'tab-btn-dashboard', '#1a1f29');

    var maxSc = 1, mk;
    for (mk in o.year) { var pf = o.year[mk].net - o.year[mk].cost; maxSc = Math.max(maxSc, Math.abs(pf)); }
    var bars = '';
    for (var m = 1; m <= 12; m++) {
      mk = o.cy + '-' + ('0' + m).slice(-2);
      var y = o.year[mk], prof = y.net - y.cost, has = y.net || y.cost;
      var h = Math.round(Math.abs(prof) / maxSc * 76), neg = prof < 0;
      bars += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0">' +
        '<div style="font-size:9.5px;line-height:1;color:' + (neg ? '#c0392b' : '#8a94a6') + ';white-space:nowrap">' + (has ? comp(prof) : '') + '</div>' +
        '<div style="display:flex;align-items:flex-end;height:80px"><div style="width:14px;height:' + Math.max(has ? 3 : 0, h) + 'px;background:' + (neg ? '#e24b4a' : '#8e44ad') + ';opacity:.85;border-radius:3px 3px 0 0"></div></div>' +
        '<div style="font-size:10px;color:#8a94a6;border-top:1px solid #eef0f3;width:100%;text-align:center;padding-top:3px' + (m === o.curMo ? ';font-weight:700;color:#48505c' : '') + '">' + m + '월</div></div>';
    }

    function act(badge, bg, fg, label, count, target) {
      return '<div onclick="document.getElementById(\'' + target + '\')&&document.getElementById(\'' + target + '\').click()" ' +
        'style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:8px 2px;border-bottom:1px solid #f2f4f7;cursor:pointer;line-height:1.5">' +
        '<span style="font-size:10px;padding:1px 8px;border-radius:20px;background:' + bg + ';color:' + fg + ';white-space:nowrap">' + badge + '</span>' +
        '<span style="flex:1">' + esc(label) + '</span><b>' + count + '곳</b></div>';
    }
    var actions =
      act('이탈위험', '#fceaea', '#c0392b', '2개월+ 캠페인 무신청 광고주', o.risk, 'tab-btn-advmgr') +
      act('재영업', '#fef3e2', '#b45309', '마지막 신청 후 2주~2개월 경과', o.re, 'tab-btn-advmgr') +
      act('첫영업', '#e6f1fb', '#185fa5', '가입만 하고 미진행(첫 캠페인 대상)', o.first, 'tab-btn-advmgr');

    host.innerHTML =
      '<div style="padding:18px 20px;line-height:1.55">' +
        '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
          '<h2 style="margin:0;font-size:18px;letter-spacing:-0.01em">🏠 오늘의 포인테일</h2>' +
          '<span style="font-size:12px;color:#8a94a6">' + dateLabel + ' · 카드 클릭 시 상세 화면 이동</span></div>' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">' + cards + '</div>' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:stretch">' +
          '<div style="flex:1.5;min-width:320px;background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px">' +
            '<div style="font-size:12.5px;font-weight:600;color:#8a94a6;margin-bottom:10px">' + o.cy + '년 월별 영업이익' + (costReady ? '' : ' <span style="font-weight:400">(비용 반영 전 — 순매출 기준)</span>') + '</div>' +
            '<div style="display:flex;align-items:flex-end;gap:5px">' + bars + '</div></div>' +
          '<div style="flex:1;min-width:260px;background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px">' +
            '<div style="font-size:12.5px;font-weight:600;color:#8a94a6;margin-bottom:6px">🔔 오늘의 액션 <span style="font-weight:400">— 광고주 관리로 이동</span></div>' + actions +
            '<div style="font-size:11px;color:#98a2b3;margin-top:8px">기준: 법인명별 마지막 캠페인 신청일 · ⚡ 동기화 시점 데이터</div></div>' +
        '</div>' +
      '</div>';
  }

  function show() {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (x) { x.classList.remove('active'); });
    var p = document.getElementById('tab-home'); if (p) p.classList.add('active');
    var b = document.getElementById('tab-btn-home'); if (b) b.classList.add('active');
    render();
    if (COSTS === null) pullCosts(function () { var pp = document.getElementById('tab-home'); if (pp && pp.classList.contains('active')) render(); });
  }

  function ensure() {
    var nav = document.getElementById('main-tabs'); if (!nav) return;
    if (!document.getElementById('tab-home')) {
      var ref = document.querySelector('.panel');
      if (ref && ref.parentNode) { var p = document.createElement('div'); p.id = 'tab-home'; p.className = 'panel'; ref.parentNode.appendChild(p); }
    }
    if (!document.getElementById('tab-btn-home')) {
      var anyTab = nav.querySelector('.tab');
      var b = document.createElement('button');
      b.id = 'tab-btn-home'; b.className = anyTab ? anyTab.className.replace(' active', '') : 'tab';
      b.textContent = '🏠 홈'; b.type = 'button';
      b.addEventListener('click', show);
      var tm = nav.querySelector('.tabs-main') || nav;
      tm.insertBefore(b, tm.firstChild);
    }
  }
  if (typeof window.showTab === 'function' && !window.showTab.__ptHome) {
    var _st = window.showTab;
    window.showTab = function () { var b = document.getElementById('tab-btn-home'); if (b) b.classList.remove('active'); return _st.apply(this, arguments); };
    window.showTab.__ptHome = true;
  }
  window.PTHOME = { show: show, render: render };

  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(function () { try { ensure(); } catch (e) {} }, 200); }
  function start() {
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(function () {
      try {
        ensure();
        var p = document.getElementById('tab-home');
        if (p && p.classList.contains('active')) render();
      } catch (e) {}
    }, 5000);
    ensure();
    pullCosts(null);
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
