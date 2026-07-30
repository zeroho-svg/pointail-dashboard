/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 비용/손익 모듈 (pointail-cost.js)
 *
 *  상위 탭 2개 추가
 *   ① 💰 비용 정리      : 월별 손익 오버뷰 (구글시트 "2025 overview" 대응)
 *        총매출 → 매입 → 순매출 → 마케팅비 → 경비&판매촉진비 → 영업이익
 *   ② 🧾 비용내역정리   : 마케팅비 / 경비&판매촉진비 를 건별 입력·수정·삭제
 *
 *  [손익 정의] 구글시트 `영업이익(매출 - 비용 전체합계) / 인건비 제외` 와 동일
 *     총매출  = (실행) 전체 매출         = Σ sd_vatIncl(r,'execTotalAmount')
 *     순매출  = (실행) 마케팅 서비스 매출 = Σ sd_vatIncl(r,'execNetAmount')
 *     매입    = 총매출 − 순매출           (시트엔 라벨 없음. 체험단 상품대금 성격)
 *     비용합계 = 마케팅비 + 경비&판매촉진비 (본 탭에서 입력)
 *     영업이익 = 순매출 − 비용합계        (인건비 제외)
 *
 *  [저장] Cloudflare KV : GET/PUT  {WORKER}/costs  (키 pointail_costs)
 *     · 여러 사람이 입력해도 공유 저장 → 다른 컴퓨터에서도 동일하게 보임
 *     · 저장 시 최종 수정자(이름/이메일)와 수정 시각을 건별로 기록
 *     · /costs 미배포 시엔 로컬(localStorage)에만 저장하고 배너로 안내
 *
 *  ※ index.html 의 DB 는 const 전역이라 window.DB 로 접근 불가 → bare DB 사용.
 *  원본 index.html 은 수정하지 않는다(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var EP = WORKER + 'costs';
  var LS = 'pt_costs_local';
  var SEED_URL = 'cost-seed.json';

  var KIND = { marketing: '마케팅비', expense: '경비 & 판매촉진비' };
  var ITEMS = {
    marketing: ['(한국) 메타 광고', '(일본) 메타 광고', '(일본) 라인', '(일본) X 광고', '(일본)구글 광고',
      '(한국) 네이버 검색 광고', '(한국) 블로그 체험단/ 바이럴', '(한국) 카페&커뮤니티',
      '(한국) 언론 PR', '(일본) 언론 PR', '옥외광고', '메시지 발송',
      '(한국) (실행)인플루언서 매출', '(일본) (실행)인플루언서 매출', '(일본) 인플루언서'],
    expense: ['판매촉진비', '플랫폼', '경비']
  };
  var C_SALE = '#3498db', C_NET = '#27ae60', C_COST = '#e67e22', C_PROF = '#8e44ad';

  // 기본 채널(항목) 마스터 — 마케팅비: 광고 채널 / 경비&판촉: 운영·판촉
  var DEFAULT_CH = {
    marketing: ['메타(한국 리드)', '메타(일본 리드)', '메타(회원모집)', '라인 광고', '틱톡 광고', 'X(트위터) 광고', '구글 광고', '네이버 광고', '인플루언서 위탁비'],
    expense: ['메세지 발송(알림톡·라인)', '판매촉진비', '플랫폼(구독료)', '기타 운영비']
  };
  var C_SALE2 = C_SALE;

  var DATA = { items: [], channels: null };   // items:{id,kind,src,ch,item,week,date,amount,cur,raw,author,authorEmail,updatedAt}
  var remoteOK = false;
  var view = 'ov';            // 오버뷰 하위 상태
  var listKind = 'marketing'; // 입력탭 하위 상태
  var listYear = '';
  // 비용내역정리(주간 도구) 상태
  var inKind = 'marketing';   // 카테고리: marketing(마케팅비) / expense(경비&판촉)
  var inView = 'week';        // week(주간 입력) / month(월별 집계)
  var inMonth = null;         // 'YYYY-MM'
  var selWeek = null;         // 주 key(월요일 ISO)
  var inYear = '';

  // ── 주차 생성: 2023-01 ~ 2031-12, 월~일, 주 소속월은 목요일 기준(HTML 도구와 동일) ──
  function pad2(n) { return ('0' + n).slice(-2); }
  function isoD(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function addD(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  var WEEKS = (function () {
    var w = [], monday = new Date(2022, 11, 26), cnt = {};   // 2022-12-26(월) → 첫 목요일이 2022-12-29, 2023-01 주는 그 다음부터
    while (true) {
      var thu = addD(monday, 3), mk = thu.getFullYear() + '-' + pad2(thu.getMonth() + 1);
      if (mk > '2031-12') break;
      if (mk >= '2023-01') {
        cnt[mk] = (cnt[mk] || 0) + 1;
        var sun = addD(monday, 6);
        w.push({ key: isoD(monday), monthKey: mk, weekNo: cnt[mk], thu: isoD(thu),
          label: (monday.getMonth() + 1) + '/' + monday.getDate() + '~' + (sun.getMonth() + 1) + '/' + sun.getDate() });
      }
      monday = addD(monday, 7);
    }
    return w;
  })();
  var WEEK_MONTHS = (function () { var s = {}, a = []; WEEKS.forEach(function (w) { if (!s[w.monthKey]) { s[w.monthKey] = 1; a.push(w.monthKey); } }); return a; })();
  function weekByKey(k) { return WEEKS.filter(function (w) { return w.key === k; })[0]; }
  function channels(kind) {
    if (!DATA.channels) DATA.channels = { marketing: DEFAULT_CH.marketing.slice(), expense: DEFAULT_CH.expense.slice() };
    if (!DATA.channels[kind]) DATA.channels[kind] = DEFAULT_CH[kind].slice();
    return DATA.channels[kind];
  }
  // 주간 항목 조회/upsert (kind·채널·주 단위, DATA.items에 저장 → 손익 오버뷰 자동 반영)
  function weekItem(kind, ch, wk) {
    return (DATA.items || []).filter(function (it) { return it.src === 'weekly' && it.kind === kind && it.ch === ch && it.week === wk; })[0];
  }

  // ── 공통 유틸 ──
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
  function sdDate(r) { try { return (typeof sd_date === 'function') ? (sd_date(r) || '') : String(r.createdAt || '').slice(0, 10); } catch (e) { return ''; } }
  function sdVat(r, k) { try { return (typeof sd_vatIncl === 'function') ? sd_vatIncl(r, k) : n(r[k]); } catch (e) { return n(r[k]); } }
  function ym(d) { return String(d || '').slice(0, 7); }              // 2026-06
  function ymLabel(y, m) { return String(y).slice(2) + '년 ' + m + '월'; }
  function nowStr() {
    var d = new Date(), p = function (x) { return ('0' + x).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function me() {
    try {
      var u = JSON.parse(localStorage.getItem('pt_auth_user') || '{}');
      return { name: u.name || u.email || '알수없음', email: u.email || '' };
    } catch (e) { return { name: '알수없음', email: '' }; }
  }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function toast(msg, bad) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;background:' + (bad ? '#c0392b' : '#111') + ';color:#fff;padding:9px 18px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2200);
  }

  // ── 저장/불러오기 ──
  function pull(cb) {
    fetch(EP + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        // 캐치올(캠페인 응답)이 오면 /costs 미배포로 간주
        if (j && Object.prototype.hasOwnProperty.call(j, 'items') && Array.isArray(j.items)) {
          DATA = { items: j.items, channels: j.channels || null }; remoteOK = true;
        } else if (j && Object.keys(j).length === 0) {
          DATA = { items: [], channels: null }; remoteOK = true;     // 빈 KV
        } else {
          remoteOK = false;
          try { DATA = JSON.parse(localStorage.getItem(LS) || '{"items":[]}'); } catch (e) { DATA = { items: [] }; }
        }
        channels('marketing'); channels('expense');   // 채널 마스터 기본 시드
        cb && cb();
      })
      .catch(function () {
        remoteOK = false;
        try { DATA = JSON.parse(localStorage.getItem(LS) || '{"items":[]}'); } catch (e) { DATA = { items: [] }; }
        cb && cb();
      });
  }
  function push(cb) {
    try { localStorage.setItem(LS, JSON.stringify(DATA)); } catch (e) {}
    if (!remoteOK) { cb && cb(false); return; }
    fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(DATA) })
      .then(function (r) { return r.ok; })
      .then(function (ok) { cb && cb(ok); })
      .catch(function () { cb && cb(false); });
  }

  // ── 집계 ──
  function monthsOf(year) { var a = []; for (var i = 1; i <= 12; i++) a.push(year + '-' + ('0' + i).slice(-2)); return a; }
  function yearsAll() {
    var s = {};
    camps().forEach(function (r) { var d = sdDate(r); if (d) s[d.slice(0, 4)] = 1; });
    (DATA.items || []).forEach(function (it) { if (it.date) s[String(it.date).slice(0, 4)] = 1; });
    var a = Object.keys(s).sort().reverse();
    return a.length ? a : [String(new Date().getFullYear())];
  }
  function calc(year) {
    var M = {}, i;
    monthsOf(year).forEach(function (k) { M[k] = { gross: 0, net: 0, mk: 0, ex: 0 }; });
    camps().forEach(function (r) {
      var d = sdDate(r); if (!d || d.slice(0, 4) !== year) return;
      var k = ym(d); if (!M[k]) return;
      M[k].gross += sdVat(r, 'execTotalAmount');
      M[k].net += sdVat(r, 'execNetAmount');
    });
    (DATA.items || []).forEach(function (it) {
      var d = String(it.date || ''); if (d.slice(0, 4) !== year) return;
      var k = ym(d); if (!M[k]) return;
      if (it.kind === 'expense') M[k].ex += n(it.amount); else M[k].mk += n(it.amount);
    });
    var rows = monthsOf(year).map(function (k) {
      var m = M[k];
      var buy = m.gross - m.net, cost = m.mk + m.ex, prof = m.net - cost;
      return { key: k, mo: parseInt(k.slice(5), 10), gross: m.gross, buy: buy, net: m.net, mk: m.mk, ex: m.ex, cost: cost, prof: prof };
    });
    var T = { gross: 0, buy: 0, net: 0, mk: 0, ex: 0, cost: 0, prof: 0 };
    rows.forEach(function (r) { for (var k in T) T[k] += r[k]; });
    return { rows: rows, T: T };
  }

  // ── 탭 삽입 ──
  function ensureTabs() {
    var nav = document.getElementById('main-tabs');
    if (!nav) return false;
    if (document.getElementById('tab-btn-cost')) return true;
    var ref = document.querySelector('#main-tabs .tab');
    function mk(id, label) {
      var b = document.createElement('button');
      b.className = ref ? ref.className : 'tab';
      b.id = 'tab-btn-' + id;
      b.textContent = label;
      b.addEventListener('click', function () { show(id); });
      return b;
    }
    var anchor = null;
    [].slice.call(nav.querySelectorAll('.tab')).forEach(function (t) { if (/광고주 관리/.test(t.textContent || '')) anchor = t; });
    var b1 = mk('cost', '💰 손익 오버뷰'), b2 = mk('costin', '🧾 비용내역정리');
    try {
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(b1, anchor.nextSibling);
        b1.parentNode.insertBefore(b2, b1.nextSibling);
      } else { nav.appendChild(b1); nav.appendChild(b2); }
    } catch (e) { nav.appendChild(b1); nav.appendChild(b2); }

    var host = document.querySelector('.panel') ? document.querySelector('.panel').parentNode : document.body;
    ['cost', 'costin'].forEach(function (id) {
      if (document.getElementById('tab-' + id)) return;
      var p = document.createElement('div');
      p.className = 'panel'; p.id = 'tab-' + id;
      p.innerHTML = '<div style="padding:24px;color:#888">불러오는 중…</div>';
      host.appendChild(p);
    });
    return true;
  }
  function show(id) {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (t) { t.classList.remove('active'); });
    var p = document.getElementById('tab-' + id), b = document.getElementById('tab-btn-' + id);
    if (p) p.classList.add('active');
    if (b) b.classList.add('active');
    if (id === 'cost') renderOverview(); else renderInput();
  }

  // ── ① 손익 오버뷰 (v3 · 2026-07-21 개편: 전월비 델타·분기 소계·비용 구성 TOP5·순매출+이익 듀얼 차트) ──
  function renderOverview() {
    var host = document.getElementById('tab-cost'); if (!host) return;
    var years = yearsAll();
    var sel = document.getElementById('ptc-year');
    var year = (sel && sel.value && years.indexOf(sel.value) >= 0) ? sel.value : years[0];
    var R = calc(year), rows = R.rows, T = R.T;
    var margin = T.net > 0 ? Math.round(T.prof / T.net * 100) : 0;

    // 최근월(데이터 있는 마지막 달)·전월 델타
    var li = -1; rows.forEach(function (r, i) { if (r.gross || r.cost) li = i; });
    var cur = li >= 0 ? rows[li] : null, prv = li > 0 ? rows[li - 1] : null;
    function dpct(a, b) { if (!prv || !b) return null; var d = Math.round((a - b) / Math.abs(b) * 100); return isFinite(d) ? d : null; }
    function chip(d, goodUp) {
      if (d === null) return '';
      var up = d >= 0, good = goodUp ? up : !up, col = good ? '#128a3a' : '#c0392b';
      return ' <span style="font-size:11px;font-weight:600;color:' + col + '">' + (up ? '▲' : '▼') + Math.abs(d) + '%</span>';
    }
    var maxSc = 1; rows.forEach(function (r) { maxSc = Math.max(maxSc, r.net, Math.abs(r.prof)); });
    var yopts = years.map(function (y) { return '<option value="' + esc(y) + '"' + (y === year ? ' selected' : '') + '>' + esc(y) + '년</option>'; }).join('');

    function kpi(l, v, c, sub) {
      return '<div style="flex:1;min-width:175px;background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);padding:14px 16px">' +
        '<div style="font-size:12px;color:var(--tx2);line-height:1.4">' + l + '</div>' +
        '<div style="font-size:22px;font-weight:700;color:' + c + ';margin-top:4px;letter-spacing:-0.02em">' + f(v) + '<span style="font-size:13px;font-weight:500;color:var(--tx2)"> 원</span></div>' +
        (sub ? '<div style="font-size:11.5px;color:var(--tx2);margin-top:4px;line-height:1.5">' + sub + '</div>' : '') + '</div>';
    }
    var curLabel = cur ? (cur.mo + '월') : '';
    var kpis =
      kpi('총매출 <span style="font-size:10px">(실행 전체)</span>', T.gross, C_SALE,
        cur ? '최근월 ' + curLabel + ' ' + comp(cur.gross) + chip(dpct(cur.gross, prv && prv.gross), true) : '') +
      kpi('순매출 <span style="font-size:10px">(실행 서비스)</span>', T.net, C_NET,
        cur ? '최근월 ' + curLabel + ' ' + comp(cur.net) + chip(dpct(cur.net, prv && prv.net), true) : '') +
      kpi('비용 합계', T.cost, C_COST,
        '마케팅 ' + comp(T.mk) + ' · 경비&판촉 ' + comp(T.ex) + (cur ? chip(dpct(cur.cost, prv && prv.cost), false) : '')) +
      kpi('영업이익 <span style="font-size:10px">(인건비 제외)</span>', T.prof, T.prof < 0 ? '#c0392b' : C_PROF,
        '이익률 ' + margin + '%' + (cur ? ' · 최근월 ' + comp(cur.prof) + chip(dpct(cur.prof, prv && prv.prof), true) : ''));

    var bars = rows.map(function (r) {
      var hN = Math.round(r.net / maxSc * 96), hP = Math.round(Math.abs(r.prof) / maxSc * 96);
      var neg = r.prof < 0;
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">' +
        '<div style="font-size:10px;line-height:1;color:' + (neg ? '#c0392b' : 'var(--tx2)') + ';white-space:nowrap">' + (r.prof ? comp(r.prof) : '') + '</div>' +
        '<div style="display:flex;align-items:flex-end;gap:2px;height:100px">' +
          '<div title="순매출 ' + f(r.net) + '원" style="width:9px;height:' + Math.max(r.net ? 2 : 0, hN) + 'px;background:#a9c7ec;border-radius:2px 2px 0 0"></div>' +
          '<div title="영업이익 ' + f(r.prof) + '원" style="width:9px;height:' + Math.max(r.prof ? 2 : 0, hP) + 'px;background:' + (neg ? '#e24b4a' : C_PROF) + ';opacity:.9;border-radius:2px 2px 0 0"></div>' +
        '</div>' +
        '<div style="font-size:10.5px;color:var(--tx2);border-top:1px solid var(--bd);width:100%;text-align:center;padding-top:4px">' + r.mo + '월</div></div>';
    }).join('');

    function td(v, extra) { return '<td style="padding:8px 12px;text-align:right;' + (extra || '') + '">' + v + '</td>'; }
    var trs = '', Q = { gross: 0, buy: 0, net: 0, mk: 0, ex: 0, cost: 0, prof: 0 }, qn = 1, qk;
    rows.forEach(function (r, i) {
      var zero = !r.gross && !r.cost;
      trs += '<tr style="border-top:1px solid var(--bd)' + (zero ? ';opacity:.4' : '') + '">' +
        '<td style="padding:8px 12px;font-weight:600;white-space:nowrap">' + ymLabel(year, r.mo) + '</td>' +
        td(f(r.gross)) + td(f(r.buy), 'color:var(--tx2)') +
        td('<b style="color:' + C_NET + '">' + f(r.net) + '</b>') +
        td(f(r.mk), 'color:' + C_COST) + td(f(r.ex), 'color:' + C_COST) + td(f(r.cost), 'font-weight:600') +
        td('<b style="color:' + (r.prof < 0 ? '#c0392b' : C_PROF) + '">' + f(r.prof) + '</b>') +
        td(r.net > 0 ? Math.round(r.prof / r.net * 100) + '%' : '-', 'color:var(--tx2)') + '</tr>';
      for (qk in Q) Q[qk] += r[qk];
      if (i % 3 === 2) {
        trs += '<tr style="border-top:1px solid var(--bd);background:var(--bg2);font-weight:600;font-size:11.5px">' +
          '<td style="padding:7px 12px;color:var(--tx2)">' + qn + '분기 소계</td>' +
          td(f(Q.gross)) + td(f(Q.buy), 'color:var(--tx2)') + td(f(Q.net)) + td(f(Q.mk)) + td(f(Q.ex)) + td(f(Q.cost)) +
          td('<b style="color:' + (Q.prof < 0 ? '#c0392b' : C_PROF) + '">' + f(Q.prof) + '</b>') +
          td(Q.net > 0 ? Math.round(Q.prof / Q.net * 100) + '%' : '-', 'color:var(--tx2)') + '</tr>';
        qn++; for (qk in Q) Q[qk] = 0;
      }
    });

    // 비용 구성 TOP5 (선택 연도)
    var cmp = { marketing: {}, expense: {} };
    (DATA.items || []).forEach(function (it) {
      if (String(it.date || '').slice(0, 4) !== year) return;
      var g = it.kind === 'expense' ? 'expense' : 'marketing';
      var key = it.item || '(미분류)';
      cmp[g][key] = (cmp[g][key] || 0) + n(it.amount);
    });
    function topList(obj, total, color) {
      var ks = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, 5);
      if (!ks.length) return '<div style="font-size:12px;color:var(--tx2);padding:8px 0">올해 내역 없음</div>';
      return ks.map(function (kk) {
        var pct = total > 0 ? Math.round(obj[kk] / total * 100) : 0;
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12.5px;line-height:1.5">' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(kk) + '</span>' +
          '<span style="color:var(--tx2);font-size:11px">' + pct + '%</span>' +
          '<span style="min-width:90px;text-align:right;font-weight:600">' + f(obj[kk]) + '</span></div>' +
          '<div style="height:4px;border-radius:2px;background:var(--bg2);overflow:hidden;margin-bottom:3px"><div style="height:100%;width:' + pct + '%;background:' + color + '"></div></div>';
      }).join('');
    }

    host.innerHTML =
      '<div style="padding:18px 20px;line-height:1.55">' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
          '<h2 style="margin:0;font-size:18px;letter-spacing:-0.01em">💰 손익 오버뷰</h2>' +
          '<select id="ptc-year" style="font-size:13px;font-weight:700;padding:5px 10px;border:1px solid var(--bd2);border-radius:var(--r);background:var(--bg);cursor:pointer">' + yopts + '</select>' +
          '<span style="font-size:12px;color:var(--tx2)">영업이익 = 순매출 − (마케팅비 + 경비&amp;판매촉진비) · 인건비 제외</span>' +
          (remoteOK ? '' : '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#fef3e2;color:#b45309">⚠ 공유저장 미연결 — 이 PC에만 저장됨</span>') +
        '</div>' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">' + kpis + '</div>' +
        '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);padding:16px;margin-bottom:18px">' +
          '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px">' +
            '<span style="font-size:12.5px;font-weight:600;color:var(--tx2)">' + esc(year) + '년 월별 순매출 · 영업이익</span>' +
            '<span style="font-size:11px;color:var(--tx2)"><span style="display:inline-block;width:9px;height:9px;background:#a9c7ec;border-radius:2px;margin-right:4px"></span>순매출</span>' +
            '<span style="font-size:11px;color:var(--tx2)"><span style="display:inline-block;width:9px;height:9px;background:' + C_PROF + ';border-radius:2px;margin-right:4px"></span>영업이익</span>' +
            '<span style="font-size:11px;color:var(--tx2)"><span style="display:inline-block;width:9px;height:9px;background:#e24b4a;border-radius:2px;margin-right:4px"></span>적자</span>' +
          '</div>' +
          '<div style="display:flex;align-items:flex-end;gap:6px">' + bars + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">' +
          '<div style="flex:1;min-width:280px;background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);padding:14px 16px">' +
            '<div style="font-size:12.5px;font-weight:600;color:var(--tx2);margin-bottom:8px">마케팅비 구성 TOP5 · 연간 ' + comp(T.mk) + '</div>' + topList(cmp.marketing, T.mk, C_COST) + '</div>' +
          '<div style="flex:1;min-width:280px;background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);padding:14px 16px">' +
            '<div style="font-size:12.5px;font-weight:600;color:var(--tx2);margin-bottom:8px">경비 &amp; 판매촉진비 구성 TOP5 · 연간 ' + comp(T.ex) + '</div>' + topList(cmp.expense, T.ex, '#b45309') + '</div>' +
        '</div>' +
        '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);overflow:auto">' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums">' +
            '<thead><tr style="background:var(--bg2);font-size:11.5px;color:var(--tx2)">' +
              '<th style="padding:9px 12px;text-align:left">월</th>' +
              '<th style="padding:9px 12px;text-align:right">총매출</th>' +
              '<th style="padding:9px 12px;text-align:right">매입</th>' +
              '<th style="padding:9px 12px;text-align:right">순매출</th>' +
              '<th style="padding:9px 12px;text-align:right">마케팅비</th>' +
              '<th style="padding:9px 12px;text-align:right">경비&amp;판촉</th>' +
              '<th style="padding:9px 12px;text-align:right">비용 합계</th>' +
              '<th style="padding:9px 12px;text-align:right">영업이익</th>' +
              '<th style="padding:9px 12px;text-align:right">이익률</th>' +
            '</tr></thead><tbody>' + trs +
            '<tr style="border-top:2px solid var(--bd);background:var(--bg2);font-weight:700">' +
              '<td style="padding:9px 12px">' + esc(year.slice(2)) + '년 합계</td>' +
              td(f(T.gross)) + td(f(T.buy)) +
              td('<span style="color:' + C_NET + '">' + f(T.net) + '</span>') +
              td('<span style="color:' + C_COST + '">' + f(T.mk) + '</span>') +
              td('<span style="color:' + C_COST + '">' + f(T.ex) + '</span>') +
              td(f(T.cost)) +
              td('<span style="color:' + (T.prof < 0 ? '#c0392b' : C_PROF) + '">' + f(T.prof) + '</span>') +
              td(margin + '%') +
            '</tr></tbody></table>' +
        '</div>' +
      '</div>';

    var ys = document.getElementById('ptc-year');
    if (ys) ys.addEventListener('change', renderOverview);
  }

  // ── ② 광고비 / 운영비 주간 및 월별 관리 (주간 채널별 입력 → 월 합산, 손익 오버뷰 연동) ──
  function renderInput() {
    var host = document.getElementById('tab-costin'); if (!host) return;
    if (!inMonth) {
      var nowMk = new Date().getFullYear() + '-' + pad2(new Date().getMonth() + 1);
      inMonth = (WEEK_MONTHS.indexOf(nowMk) >= 0) ? nowMk : WEEK_MONTHS[0];
    }
    if (!selWeek || !weekByKey(selWeek) || weekByKey(selWeek).monthKey !== inMonth) {
      var fw = WEEKS.filter(function (w) { return w.monthKey === inMonth; })[0];
      selWeek = fw ? fw.key : null;
    }
    var legacyN = (DATA.items || []).filter(function (it) { return it.src !== 'weekly'; }).length;

    // 헤더
    var head =
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
        '<h2 style="margin:0;font-size:17px">🧾 광고비 / 운영비 주간 및 월별 관리</h2>' +
        seg('ptc-kind', [['marketing', '마케팅비(광고비)'], ['expense', '경비 &amp; 판매촉진비(운영)']], inKind) +
        '<span style="width:1px;height:18px;background:var(--bd)"></span>' +
        seg('ptc-view', [['week', '주간 입력'], ['month', '월별 집계']], inView) +
        (remoteOK
          ? '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#e7f7ec;color:#128a3a">☁ 공유저장 켜짐</span>'
          : '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#fef3e2;color:#b45309">⚠ 공유저장 미연결</span>') +
        '<span style="margin-left:auto;font-size:11px;color:var(--tx2)">입력은 <b>원화(₩)</b> · 엔화(¥)는 ×10 환산 · 손익 오버뷰 자동 반영' +
          (legacyN ? ' · 과거 건별 ' + legacyN + '건 반영중' : '') + '</span>' +
      '</div>';

    host.innerHTML = '<div style="padding:16px 18px">' + head +
      (inView === 'week' ? weekView() : monthView()) + '</div>';
    wireInput();
  }

  // 세그먼트 버튼
  function seg(cls, opts, cur) {
    return '<div style="display:inline-flex;gap:4px;background:var(--bg2);border:1px solid var(--bd);border-radius:9px;padding:3px">' +
      opts.map(function (o) {
        var on = o[0] === cur;
        return '<button class="' + cls + '" data-v="' + o[0] + '" style="font-size:12px;font-weight:600;padding:5px 12px;border:0;border-radius:6px;cursor:pointer;background:' + (on ? '#111' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--tx2)') + '">' + o[1] + '</button>';
      }).join('') + '</div>';
  }

  // 채널 항목 관리 UI (추가)
  function chManageBar() {
    var chs = channels(inKind);
    var chips = chs.map(function (nm, i) {
      return '<span style="font-size:11px;padding:3px 8px;border-radius:20px;background:var(--bg);border:1px solid var(--bd);white-space:nowrap">' + esc(nm) +
        ' <button class="ptc-chdel" data-i="' + i + '" title="항목 삭제" style="border:0;background:none;color:#c0392b;cursor:pointer;font-size:11px;padding:0 0 0 3px">×</button></span>';
    }).join('');
    return '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
      '<span style="font-size:11px;color:var(--tx2);font-weight:600">항목</span>' + chips +
      '<input id="ptc-newch" placeholder="새 항목명" style="font-size:11px;padding:4px 8px;border:1px solid var(--bd2);border-radius:6px;width:150px">' +
      '<button id="ptc-addch" style="font-size:11px;padding:4px 10px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer">＋ 항목 추가</button>' +
      '</div>';
  }

  // ── 주간 입력 뷰 ──
  function weekView() {
    var chs = channels(inKind);
    var mw = WEEKS.filter(function (w) { return w.monthKey === inMonth; });
    // 월 셀렉트(현재월 ±범위 전부 노출)
    var mopts = WEEK_MONTHS.map(function (mk) { return '<option value="' + mk + '"' + (mk === inMonth ? ' selected' : '') + '>' + monthLbl(mk) + '</option>'; }).join('');
    // 주 목록
    var weekBtns = mw.map(function (w) {
      var wt = chs.reduce(function (s, ch) { var it = weekItem(inKind, ch, w.key); return s + (it ? n(it.amount) : 0); }, 0);
      var on = w.key === selWeek;
      return '<button class="ptc-wk" data-wk="' + w.key + '" style="display:flex;justify-content:space-between;gap:8px;width:100%;padding:9px 11px;margin-bottom:5px;border-radius:8px;cursor:pointer;border:1px solid ' + (on ? '#111' : 'var(--bd)') + ';background:' + (on ? '#111' : 'var(--bg)') + ';color:' + (on ? '#fff' : 'var(--tx)') + ';font-size:12px;text-align:left">' +
        '<span><b>' + w.weekNo + '주차</b> ' + w.label + '</span><span style="opacity:.85">' + (wt ? f(wt) : '—') + '</span></button>';
    }).join('');
    // 월 합계
    var monTot = 0; mw.forEach(function (w) { chs.forEach(function (ch) { var it = weekItem(inKind, ch, w.key); if (it) monTot += n(it.amount); }); });

    var w = weekByKey(selWeek);
    var rowsH = '', wTot = 0;
    if (w) {
      rowsH = chs.map(function (ch) {
        var it = weekItem(inKind, ch, w.key);
        var raw = it ? (it.raw != null ? it.raw : it.amount) : '';
        var cur = it ? (it.cur || 'KRW') : 'KRW';
        var krw = it ? n(it.amount) : 0; wTot += krw;
        return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--bd)">' +
          '<div style="width:180px;font-size:13px;font-weight:600">' + esc(ch) + '</div>' +
          '<input class="ptc-amt" data-ch="' + esc(ch) + '" type="number" min="0" placeholder="0" value="' + (raw === 0 ? '' : raw) + '" style="width:150px;text-align:right;font-size:13px;padding:7px 9px;border:1px solid var(--bd2);border-radius:8px">' +
          '<div style="display:inline-flex;border:1px solid var(--bd);border-radius:8px;overflow:hidden">' +
            '<button class="ptc-cur" data-ch="' + esc(ch) + '" data-cur="KRW" style="font-size:12px;font-weight:700;padding:6px 11px;border:0;cursor:pointer;background:' + (cur === 'KRW' ? '#111' : '#fff') + ';color:' + (cur === 'KRW' ? '#fff' : '#7a8296') + '">₩</button>' +
            '<button class="ptc-cur" data-ch="' + esc(ch) + '" data-cur="JPY" style="font-size:12px;font-weight:700;padding:6px 11px;border:0;cursor:pointer;background:' + (cur === 'JPY' ? '#111' : '#fff') + ';color:' + (cur === 'JPY' ? '#fff' : '#7a8296') + '">¥</button>' +
          '</div>' +
          (cur === 'JPY' ? '<span style="font-size:11px;color:var(--tx2)">×10 =</span>' : '') +
          '<div style="margin-left:auto;font-size:13px;font-weight:600;color:' + (krw ? 'var(--tx)' : '#b7becb') + '">' + f(krw) + '원</div>' +
        '</div>';
      }).join('');
    }

    return chManageBar() +
      '<div style="display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:16px;align-items:start">' +
        // 좌: 월/주 선택
        '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);padding:14px">' +
          '<select id="ptc-month" style="width:100%;font-size:14px;font-weight:700;padding:9px 11px;border:1px solid var(--bd2);border-radius:8px;margin-bottom:10px;background:var(--bg)">' + mopts + '</select>' +
          weekBtns +
          '<div style="margin-top:8px;padding-top:10px;border-top:1px solid var(--bd);display:flex;justify-content:space-between;font-size:13px"><span style="color:var(--tx2)">' + monthLbl(inMonth) + ' 합계</span><b>' + f(monTot) + '원</b></div>' +
        '</div>' +
        // 우: 채널 입력
        '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);padding:16px">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">' +
            '<div style="font-size:14px;font-weight:800">' + (w ? monthLbl(w.monthKey) + ' ' + w.weekNo + '주차 (' + w.label + ')' : '주를 선택하세요') + '</div>' +
            '<div style="font-size:13px;color:var(--tx2)">주 합계 <b style="color:var(--tx)">' + f(wTot) + '원</b></div>' +
          '</div>' +
          (rowsH || '<div style="color:var(--tx2);font-size:13px;padding:10px 0">항목이 없습니다. 위에서 추가하세요.</div>') +
          '<div style="font-size:11px;color:var(--tx2);margin-top:10px">금액 입력 시 자동 저장되어 월별 집계·손익 오버뷰에 즉시 반영됩니다.</div>' +
        '</div>' +
      '</div>';
  }

  // ── 월별 집계 뷰 ──
  function monthView() {
    var chs = channels(inKind);
    var yrs = (function () { var s = {}; WEEK_MONTHS.forEach(function (m) { s[m.slice(0, 4)] = 1; }); (DATA.items || []).forEach(function (it) { if (it.src === 'weekly' && it.week) { var w = weekByKey(it.week); if (w) s[w.monthKey.slice(0, 4)] = 1; } }); return Object.keys(s).sort(); })();
    if (!inYear || yrs.indexOf(inYear) < 0) inYear = yrs.indexOf(String(new Date().getFullYear())) >= 0 ? String(new Date().getFullYear()) : yrs[0];
    var yopts = yrs.map(function (y) { return '<option' + (y === inYear ? ' selected' : '') + '>' + y + '</option>'; }).join('');

    // 월별 채널 합계
    var months = []; for (var m = 1; m <= 12; m++) months.push(inYear + '-' + pad2(m));
    var grid = {}, colTot = {}, maxMon = 1;
    months.forEach(function (mk) { grid[mk] = {}; chs.forEach(function (ch) { grid[mk][ch] = 0; }); });
    (DATA.items || []).forEach(function (it) {
      if (it.src !== 'weekly' || it.kind !== inKind) return;
      var w = weekByKey(it.week); if (!w || w.monthKey.slice(0, 4) !== inYear) return;
      if (grid[w.monthKey] && chs.indexOf(it.item) >= 0) grid[w.monthKey][it.item] += n(it.amount);
    });
    months.forEach(function (mk) { var t = 0; chs.forEach(function (ch) { t += grid[mk][ch]; colTot[ch] = (colTot[ch] || 0) + grid[mk][ch]; }); grid[mk].__t = t; if (t > maxMon) maxMon = t; });
    var yearTot = 0; months.forEach(function (mk) { yearTot += grid[mk].__t; });

    // 바 차트
    var bars = months.map(function (mk) {
      var t = grid[mk].__t, h = Math.round(t / maxMon * 120);
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0">' +
        '<div style="font-size:9px;color:var(--tx2);white-space:nowrap">' + (t ? comp(t) : '') + '</div>' +
        '<div style="display:flex;align-items:flex-end;height:122px"><div title="' + f(t) + '원" style="width:20px;height:' + Math.max(t ? 3 : 0, h) + 'px;background:' + (inKind === 'marketing' ? C_COST : '#8e44ad') + ';opacity:.85;border-radius:3px 3px 0 0"></div></div>' +
        '<div style="font-size:10px;color:var(--tx2);border-top:1px solid var(--bd);width:100%;text-align:center;padding-top:3px">' + parseInt(mk.slice(5), 10) + '월</div></div>';
    }).join('');

    // 표
    var thead = '<tr style="background:var(--bg2);font-size:11px;color:var(--tx2)"><th style="padding:8px 9px;text-align:left">월</th>' +
      chs.map(function (ch) { return '<th style="padding:8px 9px;text-align:right;white-space:nowrap">' + esc(ch) + '</th>'; }).join('') +
      '<th style="padding:8px 9px;text-align:right">합계</th></tr>';
    var body = months.map(function (mk) {
      var zero = grid[mk].__t === 0;
      return '<tr style="border-top:1px solid var(--bd)' + (zero ? ';opacity:.4' : '') + '"><td style="padding:7px 9px;font-weight:600;white-space:nowrap">' + monthLbl(mk) + '</td>' +
        chs.map(function (ch) { return '<td style="padding:7px 9px;text-align:right">' + (grid[mk][ch] ? f(grid[mk][ch]) : '-') + '</td>'; }).join('') +
        '<td style="padding:7px 9px;text-align:right;font-weight:700">' + (grid[mk].__t ? f(grid[mk].__t) : '-') + '</td></tr>';
    }).join('');
    var foot = '<tr style="border-top:2px solid var(--bd);background:var(--bg2);font-weight:700"><td style="padding:8px 9px">' + inYear.slice(2) + '년 합계</td>' +
      chs.map(function (ch) { return '<td style="padding:8px 9px;text-align:right">' + f(colTot[ch] || 0) + '</td>'; }).join('') +
      '<td style="padding:8px 9px;text-align:right">' + f(yearTot) + '</td></tr>';

    return '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px"><span style="font-size:12px;font-weight:600;color:var(--tx2)">연도</span>' +
        '<select id="ptc-year2" style="font-size:13px;font-weight:700;padding:5px 11px;border:1px solid var(--bd2);border-radius:8px;background:var(--bg)">' + yopts + '</select>' +
        '<span style="font-size:12px;color:var(--tx2)">' + monthLbl(inYear + '-01').slice(0, -3) + ' ' + KIND[inKind] + ' 합계 <b style="color:var(--tx)">' + f(yearTot) + '원</b></span></div>' +
      '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);padding:14px;margin-bottom:14px">' +
        '<div style="font-size:11px;color:var(--tx2);margin-bottom:8px;font-weight:500">' + inYear + '년 월별 ' + KIND[inKind] + ' 추이</div>' +
        '<div style="display:flex;align-items:flex-end;gap:6px">' + bars + '</div></div>' +
      '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead>' + thead + '</thead><tbody>' + body + foot + '</tbody></table></div>';
  }

  function monthLbl(mk) { var p = String(mk).split('-'); return p[0].slice(2) + '년 ' + parseInt(p[1], 10) + '월'; }

  var pendingCur = {};   // 금액 입력 전 통화 선택 임시 보관 (key: week|ch)
  function saveNow(msg) { push(function (ok) { if (msg) toast(msg + (ok ? '' : ' (이 PC에만)'), !ok); }); }

  function setAmount(ch, raw) {
    var w = weekByKey(selWeek); if (!w) return;
    var it = weekItem(inKind, ch, selWeek);
    var key = selWeek + '|' + ch;
    var cur = it ? (it.cur || 'KRW') : (pendingCur[key] || 'KRW');
    var krw = cur === 'JPY' ? raw * 10 : raw;
    var u = me();
    if (raw > 0) {
      if (it) { it.amount = krw; it.raw = raw; it.cur = cur; it.author = u.name; it.authorEmail = u.email; it.updatedAt = nowStr(); }
      else DATA.items.push({ id: uid(), kind: inKind, src: 'weekly', ch: ch, item: ch, week: selWeek, date: w.thu, amount: krw, cur: cur, raw: raw, author: u.name, authorEmail: u.email, updatedAt: nowStr() });
    } else if (it) { DATA.items = DATA.items.filter(function (x) { return x.id !== it.id; }); }
    saveNow(); renderInput();
  }
  function setCur(ch, cur) {
    var key = selWeek + '|' + ch;
    pendingCur[key] = cur;
    var it = weekItem(inKind, ch, selWeek);
    if (it) { it.cur = cur; var raw = it.raw != null ? it.raw : it.amount; it.raw = raw; it.amount = cur === 'JPY' ? n(raw) * 10 : n(raw); it.updatedAt = nowStr(); saveNow(); }
    renderInput();
  }

  function wireInput() {
    var host = document.getElementById('tab-costin'); if (!host) return;
    host.querySelectorAll('.ptc-kind').forEach(function (b) { b.onclick = function () { inKind = b.getAttribute('data-v'); selWeek = null; renderInput(); }; });
    host.querySelectorAll('.ptc-view').forEach(function (b) { b.onclick = function () { inView = b.getAttribute('data-v'); renderInput(); }; });
    var ms = document.getElementById('ptc-month'); if (ms) ms.onchange = function () { inMonth = ms.value; selWeek = null; renderInput(); };
    var ys = document.getElementById('ptc-year2'); if (ys) ys.onchange = function () { inYear = ys.value; renderInput(); };
    host.querySelectorAll('.ptc-wk').forEach(function (b) { b.onclick = function () { selWeek = b.getAttribute('data-wk'); renderInput(); }; });
    host.querySelectorAll('.ptc-amt').forEach(function (inp) { inp.onchange = function () { setAmount(inp.getAttribute('data-ch'), parseFloat(inp.value) || 0); }; });
    host.querySelectorAll('.ptc-cur').forEach(function (b) { b.onclick = function () { setCur(b.getAttribute('data-ch'), b.getAttribute('data-cur')); }; });

    var addch = document.getElementById('ptc-addch');
    if (addch) addch.onclick = function () {
      var el = document.getElementById('ptc-newch'); var v = ((el && el.value) || '').trim();
      if (!v) { toast('항목명을 입력하세요', true); return; }
      var arr = channels(inKind);
      if (arr.indexOf(v) >= 0) { toast('이미 있는 항목입니다', true); return; }
      arr.push(v); saveNow('항목 추가 완료'); renderInput();
    };
    host.querySelectorAll('.ptc-chdel').forEach(function (b) {
      b.onclick = function () {
        var i = parseInt(b.getAttribute('data-i'), 10); var arr = channels(inKind); var nm = arr[i]; if (!nm) return;
        if (!confirm('항목 "' + nm + '" 을(를) 삭제할까요?\n이 항목에 입력된 주간 금액도 함께 삭제됩니다.')) return;
        arr.splice(i, 1);
        DATA.items = (DATA.items || []).filter(function (it) { return !(it.src === 'weekly' && it.kind === inKind && it.item === nm); });
        saveNow('항목 삭제 완료'); renderInput();
      };
    });
  }

  // ── 부팅 ──
  function boot() {
    if (!ensureTabs()) return;
    if (!boot.__pulled) {
      boot.__pulled = true;
      pull(function () {
        var a = document.getElementById('tab-cost'), b = document.getElementById('tab-costin');
        if (a && a.classList.contains('active')) renderOverview();
        if (b && b.classList.contains('active')) renderInput();
      });
    }
  }
  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(function () { try { boot(); } catch (e) {} }, 200); }
  function start() {
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(function () { try { boot(); } catch (e) {} }, 1500);
    boot();
    // 원본 showTab 이 다른 탭을 켤 때 우리 탭 비활성화 처리
    if (typeof window.showTab === 'function' && !window.showTab.__ptc) {
      var o = window.showTab;
      var w = function () {
        ['cost', 'costin'].forEach(function (id) {
          var p = document.getElementById('tab-' + id), b = document.getElementById('tab-btn-' + id);
          if (p) p.classList.remove('active'); if (b) b.classList.remove('active');
        });
        return o.apply(this, arguments);
      };
      w.__ptc = true; window.showTab = w;
    }
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
