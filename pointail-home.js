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
 *  [v6 2026-08-12] 캘린더 날짜 클릭 카드에 ① 매출 정보(계약 contractFinal ·
 *      실행 execTotalAmount, VAT 포함, sd_vatIncl 기준) ② 캠페인 번호 링크 추가 —
 *      클릭 시 번호 클립보드 복사 + 관리자(admin.storelink.io/jp/campaigns-jp) 새 탭.
 *  [v7 2026-08-12] 카드 매출 라인에 계약 마케팅 서비스(contractMktCost) 추가.
 *  [v8 2026-08-13] 카드 매출 라인 정리 — 💰 전체매출(contractFinal) · 서비스매출
 *      (contractMktCost) 2종만 표시. 라벨 변경(계약→전체매출, 마케 서비스→서비스매출),
 *      실행매출(execTotalAmount)은 캘린더 카드에서 제외.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  /* [v6] 캘린더 카드 캠페인 번호 클릭 → 관리자 페이지. 상세 딥링크 URL 패턴 확인 시
   *      아래 상수를 교체(예: .../campaigns-jp/{no})하고 admGo의 복사 동작은 유지해도 무방. */
  var ADMIN_CAMP_URL = 'https://admin.storelink.io/jp/campaigns-jp';
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

  /* ── 📅 캠페인 캘린더 (오픈·오픈예정) ──────────────────────────
   *  달력에 캠페인 "오픈일(모집 시작일)"을 찍어 브랜드·담당자·모집인원을 한눈에.
   *  상태 3단계: 충족(선정≥목표) / 진행중 부족(모집중인데 목표 미달·노랑) /
   *              미달(모집 마감됐는데 목표 미달·빨강). 오픈예정 = 오픈일이 미래.
   *  날짜 클릭 → 그날 캠페인들을 카드로 상세 표시(전체 모집인원 포함).       */
  var CAL = { y: null, m: null, sel: null };
  var OPEN_RECRUIT = ['모집중', '추가 모집중'];              // 아직 모집중(마감 전)
  var CAL_CANCEL = ['캠페인 취소', '등록 취소'];              // 달력에서 제외
  var CAT_STYLE = {
    '체험단':    { dot: '#1d9e75', bg: '#e3f4ed', tx: '#0f6e56', ic: '🧪' },
    '인플루언서': { dot: '#7f77dd', bg: '#eeedfe', tx: '#3c3489', ic: '📣' }
  };
  var CAL_ST = {
    behind: { tx: '#b45309', bg: '#fef3e2', bd: '#f6d79b', lab: '진행중 부족' },
    short:  { tx: '#c0392b', bg: '#fceaea', bd: '#f0b6b6', lab: '미달' }
  };
  var AV = ['#3778c2', '#7f77dd', '#1d9e75', '#d85a30', '#c0398d', '#0f766e'];
  function avColor(s) { var h = 0, i; for (i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AV[h % AV.length]; }
  function ini2(s) { return (String(s).replace(/[^가-힣A-Za-z0-9]/g, '').slice(0, 2)) || '?'; }
  function d10(s) { return String(s || '').slice(0, 10); }
  function catOf(c) { return c.campaignType === '인플루언서' ? '인플루언서' : '체험단'; }
  function calOpenDate(c) { return d10(c.recruitStartAt) || d10(c.createdAt); }
  function todayStr() { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); }
  function calStateOf(c, soon) {
    if (soon) return 'soon';
    var tgt = n(c.recruitCount), sel = n(c.selectedCount);
    if (tgt > 0 && sel >= tgt) return 'met';
    if (OPEN_RECRUIT.indexOf(c.campaignStatus) >= 0) return 'behind';   // 모집중인데 목표 미달
    if (tgt > 0 && sel < tgt) return 'short';                           // 마감됐는데 목표 미달
    return 'met';                                                        // 목표 미설정 등 → 중립
  }
  function calMonthData() {
    var mk = CAL.y + '-' + ('0' + (CAL.m + 1)).slice(-2), today = todayStr(), byDay = {};
    camps().forEach(function (c) {
      if (CAL_CANCEL.indexOf(c.campaignStatus) >= 0) return;
      var od = calOpenDate(c); if (!od || od.slice(0, 7) !== mk) return;
      var soon = od > today;
      var openFull = String(c.recruitStartAt || c.createdAt || '');
      var openTime = openFull.length >= 16 ? openFull.slice(11, 16) : '';   // HH:MM
      (byDay[od] = byDay[od] || []).push({
        date: od, openTime: openTime, openFull: openFull,
        brand: String(c.storeName || c.corpName || '').trim() || '(브랜드 미상)',
        corp: String(c.corpName || '').trim(),
        rep: String(c.salesManager || '미배정').trim() || '미배정',
        cat: catOf(c), sub: String(c.campaignType || ''),
        target: n(c.recruitCount), selected: n(c.selectedCount), applicant: n(c.applicantCount),
        status: String(c.campaignStatus || ''), round: String(c.roundInfo || ''),
        country: String(c.advertiserCountry || ''), agency: String(c.companyType || '') === '대행사',
        soon: soon, state: calStateOf(c, soon),
        title: String(c.campaignTitle || ''), no: c.campaignNoText || String(c.campaignNo || ''),
        contract: sdVat(c, 'contractFinal'), mkt: sdVat(c, 'contractMktCost')
      });
    });
    // 각 날짜의 캠페인을 오픈 시작 시간이 빠른 순으로 정렬(셀·카드 공통)
    Object.keys(byDay).forEach(function (k) {
      byDay[k].sort(function (a, b) { return String(a.openFull).localeCompare(String(b.openFull)); });
    });
    return byDay;
  }
  function calChip(bg, tx, txt) { return '<span style="font-size:11.5px;padding:3px 9px;border-radius:20px;background:' + bg + ';color:' + tx + '">' + txt + '</span>'; }

  function calCard(x) {
    var cs = CAT_STYLE[x.cat], warn = (x.state === 'short' || x.state === 'behind') ? CAL_ST[x.state] : null;
    var stTxt = x.soon ? '오픈예정' : x.status;
    var stBg = x.soon ? '#e6f1fb' : (OPEN_RECRUIT.indexOf(x.status) >= 0 ? '#e3f4ed' : '#eef0f3');
    var stFg = x.soon ? '#185fa5' : (OPEN_RECRUIT.indexOf(x.status) >= 0 ? '#0f6e56' : '#6b7280');
    var numCol = warn ? warn.tx : '#1a1f29';
    var amtHtml = x.soon
      ? '<div style="font-size:18px;font-weight:700;color:#1a1f29">' + f(x.target) + '<span style="font-size:12px;font-weight:500;color:#8a94a6">명</span></div><div style="font-size:10px;color:#8a94a6">모집목표</div>'
      : '<div style="font-size:18px;font-weight:700;color:' + numCol + '">' + f(x.selected) + '<span style="font-size:12px;color:#8a94a6;font-weight:500"> / ' + f(x.target) + '명</span></div><div style="font-size:10px;color:' + (warn ? warn.tx : '#8a94a6') + '">' + (warn ? warn.lab : '선정 / 목표') + '</div>';
    var av = avColor(x.rep);
    return '<div style="background:#fff;border:1px solid ' + (warn ? warn.bd : '#eef0f3') + ';border-radius:12px;padding:12px 13px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">' +
        '<span style="font-size:14px;font-weight:700;color:#1a1f29;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.brand) + '</span>' +
        '<span style="font-size:11px;padding:3px 8px;border-radius:20px;background:' + stBg + ';color:' + stFg + ';white-space:nowrap;flex:0 0 auto">' + esc(stTxt) + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
        '<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:' + cs.bg + ';color:' + cs.tx + '">' + cs.ic + ' ' + x.cat + '</span>' +
        (x.sub ? '<span style="font-size:11px;color:#8a94a6">' + esc(x.sub) + '</span>' : '') +
        (x.country ? '<span style="font-size:11px;color:#8a94a6">· ' + esc(x.country) + '</span>' : '') +
        (warn ? '<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:' + warn.bg + ';color:' + warn.tx + ';margin-left:auto">' + warn.lab + ' ' + f(Math.max(0, x.target - x.selected)) + '명</span>' : '') +
      '</div>' +
      ((x.corp || x.agency) ? '<div style="font-size:11px;color:#98a2b3;margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.corp || '') + (x.agency ? ' <span style="color:#b45309;font-weight:600">(대행사)</span>' : '') + '</div>' : '') +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="width:28px;height:28px;border-radius:50%;background:' + av + ';color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">' + esc(ini2(x.rep)) + '</span>' +
          '<div><div style="font-size:12.5px;font-weight:600;color:#1a1f29">' + esc(x.rep) + '</div><div style="font-size:10px;color:#8a94a6">영업담당자</div></div>' +
        '</div>' +
        '<div style="text-align:right">' + amtHtml + '</div>' +
      '</div>' +
      (x.title ? '<div style="font-size:12.5px;font-weight:600;color:#48505c;margin-bottom:8px;line-height:1.4">' + esc(x.title) + '</div>' : '') +
      '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11.5px;color:#8a94a6">' +
        '<span>📅 오픈 ' + esc(x.date) + (x.openTime ? ' <b style="color:#48505c">' + esc(x.openTime) + '</b>' : '') + '</span>' +
        (x.round ? '<span>🔁 ' + esc(x.round) + ' 회차</span>' : '') +
        '<span>🙋 신청 ' + f(x.applicant) + '명</span>' +
      '</div>' +
      ((x.contract || x.mkt) ? '<div style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:#8a94a6;margin-top:5px">' +
        '<span>💰 전체매출 <b style="color:#48505c">₩' + comp(x.contract) + '</b> · 서비스매출 <b style="color:#3778c2">₩' + comp(x.mkt) + '</b> <span style="font-size:10px">(VAT포함)</span></span>' +
      '</div>' : '') +
      (x.no ? '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #eef0f3">' +
        '<a href="' + ADMIN_CAMP_URL + '" target="_blank" rel="noopener" ' +
          'onclick="window.PTHOME&&PTHOME.admGo(\'' + esc(x.no) + '\')" ' +
          'title="클릭 시 캠페인 번호가 복사되고 관리자 페이지가 새 탭으로 열립니다" ' +
          'style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:#3778c2;text-decoration:none;background:#eef4fc;border:1px solid #d5e4f5;border-radius:8px;padding:3px 10px">' +
          '🔗 캠페인 № ' + esc(x.no) + ' <span style="font-weight:500;color:#8a94a6">관리자 열기 ↗</span></a>' +
      '</div>' : '') +
    '</div>';
  }

  function calendarHTML() {
    if (CAL.y == null) { var tt = new Date(); CAL.y = tt.getFullYear(); CAL.m = tt.getMonth(); }
    var mk = CAL.y + '-' + ('0' + (CAL.m + 1)).slice(-2), today = todayStr();
    var byDay = calMonthData(), keys = Object.keys(byDay).sort();
    if (!CAL.sel || d10(CAL.sel).slice(0, 7) !== mk || !byDay[CAL.sel]) CAL.sel = byDay[today] ? today : (keys[0] || null);

    var openC = 0, soonC = 0, tgt = 0, behindC = 0, shortC = 0;
    keys.forEach(function (k) { byDay[k].forEach(function (x) { if (x.soon) soonC++; else openC++; tgt += x.target; if (x.state === 'behind') behindC++; if (x.state === 'short') shortC++; }); });

    var WD = ['일', '월', '화', '수', '목', '금', '토'];
    var first = new Date(CAL.y, CAL.m, 1), start = first.getDay(), days = new Date(CAL.y, CAL.m + 1, 0).getDate();
    var grid = '<div style="display:grid;grid-template-columns:repeat(7,1fr);background:#f7f8fa">';
    WD.forEach(function (w, i) { grid += '<div style="text-align:center;padding:6px 0;font-size:11px;color:' + (i === 0 ? '#c0392b' : '#8a94a6') + '">' + w + '</div>'; });
    grid += '</div><div style="display:grid;grid-template-columns:repeat(7,1fr)">';
    var c2, dd;
    for (c2 = 0; c2 < start; c2++) grid += '<div style="min-height:80px;border-top:1px solid #eef0f3"></div>';
    for (dd = 1; dd <= days; dd++) {
      var key = mk + '-' + ('0' + dd).slice(-2), arr = byDay[key] || [], sun = (dd + start - 1) % 7 === 0;
      var isSel = key === CAL.sel, isToday = key === today;
      grid += '<div onclick="' + (arr.length ? 'window.PTHOME&&PTHOME.calSel(\'' + key + '\')' : '') + '" style="min-height:80px;border-top:1px solid #eef0f3;border-left:1px solid #eef0f3;padding:4px 5px;' + (arr.length ? 'cursor:pointer;' : '') + (isSel ? 'background:#eef5ff;' : '') + '">' +
        '<div style="font-size:11px;color:' + (sun ? '#c0392b' : '#8a94a6') + ';font-weight:' + (isSel || isToday ? '700' : '400') + '">' + dd + (isToday ? '<span style="font-size:9px;color:#185fa5;font-weight:700"> 오늘</span>' : '') + '</div>';
      arr.slice(0, 2).forEach(function (x) {
        var cs = CAT_STYLE[x.cat];
        var amt = x.soon ? ('목표' + f(x.target)) : (f(x.selected) + '/' + f(x.target));
        var col = x.state === 'short' ? '#c0392b' : (x.state === 'behind' ? '#b45309' : '#98a2b3');
        var mkk = x.state === 'short' ? ' 미달' : (x.state === 'behind' ? ' 부족' : '');
        grid += '<div style="display:flex;align-items:center;gap:3px;line-height:1.2;margin-top:2px">' +
            '<span style="width:6px;height:6px;border-radius:2px;background:' + cs.dot + ';flex:0 0 auto"></span>' +
            '<span style="font-size:10px;font-weight:600;color:#1a1f29;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.brand) + '</span>' +
            (x.agency ? '<span style="font-size:9px;color:#b45309;font-weight:600;flex:0 0 auto">(대행사)</span>' : '') + '</div>' +
          '<div style="font-size:9.5px;margin:0 0 2px 9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + col + '">' + esc(x.rep) + '·' + amt + '명' + mkk + '</div>';
      });
      if (arr.length > 2) grid += '<div style="font-size:9.5px;color:#185fa5;margin-left:9px">+' + (arr.length - 2) + '건 더</div>';
      grid += '</div>';
    }
    grid += '</div>';

    var selArr = (CAL.sel && byDay[CAL.sel]) ? byDay[CAL.sel] : [];
    var selTgt = 0, selSel = 0; selArr.forEach(function (x) { selTgt += x.target; if (!x.soon) selSel += x.selected; });
    var sp = CAL.sel ? CAL.sel.split('-') : null;
    var detHead = sp ? ('🗂 ' + parseInt(sp[1], 10) + '월 ' + parseInt(sp[2], 10) + '일 · ' + selArr.length + '건 · 모집목표 ' + f(selTgt) + '명 (선정 ' + f(selSel) + '명)') : '날짜를 선택하세요';
    var detBody = selArr.length
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:10px">' + selArr.map(calCard).join('') + '</div>'
      : '<div style="color:#98a2b3;font-size:13px;padding:10px 0">이 달에 오픈/오픈예정 캠페인이 없습니다.</div>';

    return '<div style="margin-top:16px;background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px">' +
        '<div style="font-size:14px;font-weight:700;color:#1a1f29">📅 캠페인 캘린더 <span style="font-size:12px;font-weight:400;color:#8a94a6">— 오픈·오픈예정 · 날짜 클릭 시 상세</span></div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<button onclick="window.PTHOME&&PTHOME.calNav(-1)" style="width:28px;height:28px;border:1px solid #e5e8ee;background:#fff;border-radius:8px;cursor:pointer;color:#48505c">‹</button>' +
          '<span style="font-size:13px;font-weight:700;min-width:96px;text-align:center;color:#1a1f29">' + CAL.y + '년 ' + (CAL.m + 1) + '월</span>' +
          '<button onclick="window.PTHOME&&PTHOME.calNav(1)" style="width:28px;height:28px;border:1px solid #e5e8ee;background:#fff;border-radius:8px;cursor:pointer;color:#48505c">›</button>' +
          '<button onclick="window.PTHOME&&PTHOME.calToday()" style="height:28px;padding:0 10px;border:1px solid #e5e8ee;background:#fff;border-radius:8px;cursor:pointer;font-size:12px;color:#48505c">오늘</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:11.5px">' +
        calChip('#e3f4ed', '#0f6e56', '오픈 ' + openC) +
        calChip('#e6f1fb', '#185fa5', '오픈예정 ' + soonC) +
        calChip('#f4f5f7', '#6b7280', '목표 ' + f(tgt) + '명') +
        (behindC ? calChip('#fef3e2', '#b45309', '부족 ' + behindC) : '') +
        (shortC ? calChip('#fceaea', '#c0392b', '미달 ' + shortC) : '') +
        '<span style="margin-left:auto;color:#98a2b3;font-size:10.5px"><span style="display:inline-block;width:8px;height:8px;border-radius:3px;background:#1d9e75;margin-right:3px"></span>체험단<span style="display:inline-block;width:8px;height:8px;border-radius:3px;background:#7f77dd;margin:0 3px 0 8px"></span>인플루언서</span>' +
      '</div>' +
      '<div style="border:1px solid #eef0f3;border-radius:10px;overflow:hidden">' + grid + '</div>' +
      '<div style="font-size:13px;font-weight:700;color:#1a1f29;margin-top:12px">' + detHead + '</div>' +
      detBody +
    '</div>';
  }

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
        calendarHTML() +
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
  function calRerender() { var p = document.getElementById('tab-home'); if (p && p.classList.contains('active')) render(); }
  window.PTHOME = {
    show: show, render: render,
    calSel: function (ds) { CAL.sel = ds; calRerender(); },
    calNav: function (d) { if (CAL.y == null) { var t = new Date(); CAL.y = t.getFullYear(); CAL.m = t.getMonth(); } CAL.m += d; if (CAL.m < 0) { CAL.m = 11; CAL.y--; } else if (CAL.m > 11) { CAL.m = 0; CAL.y++; } CAL.sel = null; calRerender(); },
    calToday: function () { var t = new Date(); CAL.y = t.getFullYear(); CAL.m = t.getMonth(); CAL.sel = null; calRerender(); },
    /* [v6] 캠페인 번호 클릭: 번호를 클립보드에 복사(관리자 검색창에 바로 붙여넣기 용).
     *      새 탭 이동은 <a target="_blank"> 기본 동작. 이벤트 버블은 여기서 차단. */
    admGo: function (no) {
      try { if (window.event) window.event.stopPropagation(); } catch (e) { }
      try { navigator.clipboard && navigator.clipboard.writeText(String(no)); } catch (e) { }
      return true;
    }
  };

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
