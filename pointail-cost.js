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

  var DATA = { items: [] };   // {id,kind,date,item,desc,amount,author,authorEmail,updatedAt}
  var remoteOK = false;
  var view = 'ov';            // 오버뷰 하위 상태
  var listKind = 'marketing'; // 입력탭 하위 상태
  var listYear = '';

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
          DATA = { items: j.items }; remoteOK = true;
        } else if (j && Object.keys(j).length === 0) {
          DATA = { items: [] }; remoteOK = true;     // 빈 KV
        } else {
          remoteOK = false;
          try { DATA = JSON.parse(localStorage.getItem(LS) || '{"items":[]}'); } catch (e) { DATA = { items: [] }; }
        }
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

  // ── ② 비용내역정리(입력) ──
  function renderInput() {
    var host = document.getElementById('tab-costin'); if (!host) return;
    var years = ['(전체)'].concat(yearsAll());
    if (!listYear) listYear = '(전체)';

    var list = (DATA.items || []).filter(function (it) { return it.kind === listKind; });
    if (listYear !== '(전체)') list = list.filter(function (it) { return String(it.date || '').slice(0, 4) === listYear; });
    list.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });

    var sum = 0; list.forEach(function (it) { sum += n(it.amount); });

    // 항목별 소계
    var byItem = {};
    list.forEach(function (it) { byItem[it.item || '(미분류)'] = (byItem[it.item || '(미분류)'] || 0) + n(it.amount); });
    var itemChips = Object.keys(byItem).sort(function (a, b) { return byItem[b] - byItem[a]; }).map(function (k) {
      return '<span style="font-size:11px;padding:3px 9px;border-radius:20px;background:var(--bg2);border:1px solid var(--bd);white-space:nowrap">' + esc(k) + ' <b>' + comp(byItem[k]) + '</b></span>';
    }).join('');

    var opts = ITEMS[listKind].map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('');
    var yopts = years.map(function (y) { return '<option' + (y === listYear ? ' selected' : '') + '>' + esc(y) + '</option>'; }).join('');

    var trs = list.map(function (it) {
      return '<tr data-id="' + esc(it.id) + '" style="border-top:1px solid var(--bd)">' +
        '<td style="padding:6px 9px;white-space:nowrap">' + esc(it.date || '') + '</td>' +
        '<td style="padding:6px 9px;white-space:nowrap">' + esc(it.item || '') + '</td>' +
        '<td style="padding:6px 9px">' + esc(it.desc || '') + '</td>' +
        '<td style="padding:6px 9px;text-align:right;font-weight:600">' + f(it.amount) + '</td>' +
        '<td style="padding:6px 9px;font-size:11px;color:var(--tx2);white-space:nowrap">' + esc(it.author || '') + (it.updatedAt ? '<br><span style="font-size:10px">' + esc(it.updatedAt) + '</span>' : '') + '</td>' +
        '<td style="padding:6px 9px;text-align:center;white-space:nowrap">' +
          '<button class="ptc-del" data-id="' + esc(it.id) + '" style="font-size:11px;padding:2px 8px;border:1px solid #f0c8c8;color:#c0392b;background:#fff6f6;border-radius:5px;cursor:pointer">삭제</button>' +
        '</td></tr>';
    }).join('');

    host.innerHTML =
      '<div style="padding:16px 18px">' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
          '<h2 style="margin:0;font-size:17px">🧾 비용내역정리</h2>' +
          '<button class="ptc-kind" data-k="marketing" style="font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--bd2);background:' + (listKind === 'marketing' ? '#111' : 'var(--bg)') + ';color:' + (listKind === 'marketing' ? '#fff' : 'var(--tx)') + '">마케팅비</button>' +
          '<button class="ptc-kind" data-k="expense" style="font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--bd2);background:' + (listKind === 'expense' ? '#111' : 'var(--bg)') + ';color:' + (listKind === 'expense' ? '#fff' : 'var(--tx)') + '">경비 &amp; 판매촉진비</button>' +
          '<select id="ptc-fy" style="font-size:12px;padding:4px 9px;border:1px solid var(--bd2);border-radius:var(--r);background:var(--bg)">' + yopts + '</select>' +
          '<span style="font-size:12px;color:var(--tx2)">' + list.length + '건 · 합계 <b style="color:var(--tx)">' + f(sum) + '</b>원</span>' +
          (remoteOK
            ? '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#e7f7ec;color:#128a3a">☁ 공유저장 켜짐</span>'
            : '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#fef3e2;color:#b45309">⚠ 공유저장 미연결 (Worker /costs 배포 필요)</span>') +
          '<button id="ptc-seed" style="font-size:11px;padding:4px 10px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);cursor:pointer">구글시트 과거내역 가져오기</button>' +
        '</div>' +
        (itemChips ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">' + itemChips + '</div>' : '') +
        '<div style="background:var(--bg2);border:1px solid var(--bd);border-radius:var(--rl);padding:12px;margin-bottom:14px">' +
          '<div style="font-size:11px;font-weight:600;color:var(--tx2);margin-bottom:8px">＋ ' + esc(KIND[listKind]) + ' 추가</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
            '<input id="ptc-date" type="date" style="font-size:12px;padding:5px 8px;border:1px solid var(--bd2);border-radius:var(--r)">' +
            '<select id="ptc-item" style="font-size:12px;padding:5px 8px;border:1px solid var(--bd2);border-radius:var(--r);background:var(--bg)">' + opts + '</select>' +
            '<input id="ptc-desc" placeholder="내용" style="font-size:12px;padding:5px 8px;border:1px solid var(--bd2);border-radius:var(--r);min-width:240px;flex:1">' +
            '<input id="ptc-amt" type="number" placeholder="금액(+VAT)" style="font-size:12px;padding:5px 8px;border:1px solid var(--bd2);border-radius:var(--r);width:140px">' +
            '<button id="ptc-add" style="font-size:12px;padding:6px 16px;border:0;border-radius:var(--r);background:#111;color:#fff;cursor:pointer">추가</button>' +
          '</div>' +
        '</div>' +
        '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);overflow:auto;max-height:60vh">' +
          '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
            '<thead><tr style="background:var(--bg2);font-size:11px;color:var(--tx2);position:sticky;top:0">' +
              '<th style="padding:8px 9px;text-align:left">거래일자</th>' +
              '<th style="padding:8px 9px;text-align:left">항목</th>' +
              '<th style="padding:8px 9px;text-align:left">내용</th>' +
              '<th style="padding:8px 9px;text-align:right">비용(+VAT)</th>' +
              '<th style="padding:8px 9px;text-align:left">최종 수정자</th>' +
              '<th style="padding:8px 9px;text-align:center">관리</th>' +
            '</tr></thead><tbody>' + (trs || '<tr><td colspan="6" style="padding:22px;text-align:center;color:var(--tx2)">내역이 없습니다. 위에서 추가해 주세요.</td></tr>') + '</tbody></table>' +
        '</div>' +
      '</div>';

    wireInput();
  }

  function wireInput() {
    var host = document.getElementById('tab-costin'); if (!host) return;
    host.querySelectorAll('.ptc-kind').forEach(function (b) {
      b.onclick = function () { listKind = b.getAttribute('data-k'); renderInput(); };
    });
    var fy = document.getElementById('ptc-fy');
    if (fy) fy.onchange = function () { listYear = fy.value; renderInput(); };

    var add = document.getElementById('ptc-add');
    if (add) add.onclick = function () {
      var d = (document.getElementById('ptc-date') || {}).value || '';
      var it = (document.getElementById('ptc-item') || {}).value || '';
      var ds = (document.getElementById('ptc-desc') || {}).value || '';
      var am = n((document.getElementById('ptc-amt') || {}).value);
      if (!d) { toast('거래일자를 선택해 주세요', true); return; }
      if (!am) { toast('금액을 입력해 주세요', true); return; }
      var u = me();
      DATA.items.push({ id: uid(), kind: listKind, date: d, item: it, desc: ds, amount: am, author: u.name, authorEmail: u.email, updatedAt: nowStr() });
      push(function (ok) { toast(ok ? '저장 완료 (모든 사용자에게 반영)' : '이 PC에만 저장됨', !ok); });
      renderInput();
    };

    host.querySelectorAll('.ptc-del').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-id');
        var t = (DATA.items || []).filter(function (x) { return x.id === id; })[0];
        if (!t) return;
        if (!confirm('삭제할까요?\n\n' + (t.date || '') + ' · ' + (t.item || '') + '\n' + (t.desc || '') + ' · ' + f(t.amount) + '원')) return;
        DATA.items = DATA.items.filter(function (x) { return x.id !== id; });
        push(function (ok) { toast(ok ? '삭제 완료' : '이 PC에만 반영됨', !ok); });
        renderInput();
      };
    });

    var seed = document.getElementById('ptc-seed');
    if (seed) seed.onclick = function () {
      if (!confirm('구글시트의 과거 비용 내역을 불러옵니다.\n이미 같은 건이 있으면 건너뜁니다. 진행할까요?')) return;
      seed.disabled = true; seed.textContent = '가져오는 중…';
      fetch(SEED_URL + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); })
        .then(function (j) {
          var have = {};
          // 시트에 의도적으로 중복 기재된 건(작성자만 다름)도 살리기 위해 작성자까지 키에 포함
          (DATA.items || []).forEach(function (x) { have[[x.kind, x.date, x.item, x.amount, x.desc, x.author].join('|')] = 1; });
          var added = 0;
          ['marketing', 'expense'].forEach(function (kd) {
            (j[kd] || []).forEach(function (x) {
              var key = [kd, x.date, x.item, x.amount, x.desc, x.author || '(구글시트)'].join('|');
              if (have[key]) return;
              have[key] = 1; added++;
              DATA.items.push({ id: uid(), kind: kd, date: x.date, item: x.item, desc: x.desc, amount: n(x.amount), author: x.author || '(구글시트)', authorEmail: '', updatedAt: nowStr() });
            });
          });
          push(function (ok) { toast('과거내역 ' + added + '건 추가' + (ok ? ' (공유저장)' : ' (이 PC에만)'), !ok); });
          renderInput();
        })
        .catch(function () { toast('가져오기 실패 — cost-seed.json 배포 확인 필요', true); seed.disabled = false; seed.textContent = '구글시트 과거내역 가져오기'; });
    };
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
