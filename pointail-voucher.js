/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 📦 수출바우처 관리 (pointail-voucher.js) v2
 *
 *  영업 그룹 하위 탭. 2단 구조 + 구글시트 양방향 연동(대행사관리와 동일 패턴).
 *   1단 — 광고주 리스트(광고주 단위 집계) + 상태구분 파이프라인 카드
 *   2단 — 광고주 클릭 → 세부 진행내역(건별 ✎ 편집·＋ 건 추가 → 시트 즉시 기록)
 *
 *  [v2 2026-08-18]
 *   · 시트 B열 「상태구분」 반영 — 영업 파이프라인: 리스트업 → 진행중 → 계약완료 → 완료 및 종료
 *     상단에 클릭 필터 카드(대행사관리 스타일). 광고주 대표 상태 = 소속 건 중 가장 활성 단계.
 *   · 양방향 저장 — Apps Script doPost(update/append). 광고주명 이중 검증, 잔액(수식)·No는 보호.
 *   · 데이터 소스: ① GAS ?action=list → data['수출바우처'] (시트 직결)
 *                 ② 미배포 시 KV `/contacts`.`__voucher__` 폴백(읽기·쓰기 모두) — GAS 갱신 시 자동 전환.
 *
 *  시트 컬럼(15열): No · 상태구분 · 연도 · 광고주명 · 회사명(업무명) · 수출바우처 금액(+VAT) ·
 *   정산금액(+VAT) · 잔액(수식) · 담당자 · 서비스 종료일 · 세금계산서 발행일 · 현재 상황 ·
 *   캠페인 진행 현황 · 작성자 · 메모
 *
 *  원본 index.html 은 수정하지 않는다(주입형). 탭 버튼 tab-btn-voucher / 패널 tab-voucher.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var GAS = 'https://script.google.com/macros/s/AKfycbyDGfKsQse58Tqu5G0OwxHSSbBll4tD7EOi4TJWfFpDbLQkJjtNKNvn_W2MLnSXqCWHPw/exec';
  var SHEET_KEY = '수출바우처';
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var EP = WORKER + 'contacts';
  var VKEY = '__voucher__';
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/1O9vJquD9xSMm2Mii0JCzqZQ5S4Ic0-WSjki808JTIxk/edit?gid=1151609227#gid=1151609227';

  var COLS = ['No', '상태구분', '연도', '광고주명', '회사명(업무명)', '수출바우처 금액(+VAT)', '정산금액(+VAT)',
              '잔액', '담당자', '서비스 종료일', '세금계산서 발행일', '현재 상황', '캠페인 진행 현황', '작성자', '메모'];
  /* 저장 시 시트에 쓰는 컬럼(잔액=수식·No=자동이라 제외) */
  var SAVE_COLS = ['상태구분', '연도', '광고주명', '회사명(업무명)', '수출바우처 금액(+VAT)', '정산금액(+VAT)',
                   '담당자', '서비스 종료일', '세금계산서 발행일', '현재 상황', '캠페인 진행 현황', '작성자', '메모'];

  /* 상태구분(B열) — 영업 파이프라인. ord = 활성도(낮을수록 활성) */
  var BST = [
    { key: '진행중',       ord: 0, bg: '#e6f1fb', tx: '#185fa5', bd: '#bfd7f0' },
    { key: '계약완료',     ord: 1, bg: '#e3f4ed', tx: '#0f6e56', bd: '#bfe3d4' },
    { key: '리스트업',     ord: 2, bg: '#fef3e2', tx: '#b45309', bd: '#f5d9a8' },
    { key: '완료 및 종료', ord: 3, bg: '#eef0f3', tx: '#6b7280', bd: '#e5e8ee' }
  ];
  function bDef(v) {
    var s = String(v == null ? '' : v).trim();
    for (var i = 0; i < BST.length; i++) if (BST[i].key === s) return BST[i];
    return { key: s || '미분류', ord: 9, bg: '#f5f6f8', tx: '#98a2b3', bd: '#e5e8ee' };
  }
  function bChip(v) {
    var d = bDef(v);
    return '<span style="display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;background:' + d.bg + ';color:' + d.tx + '">' + esc(d.key) + '</span>';
  }

  /* 현재 상황(진행 상태) */
  var STATUSES = [
    { key: '서비스 진행중', bg: '#e6f1fb', tx: '#185fa5' },
    { key: '정산 완료',     bg: '#e3f4ed', tx: '#0f6e56' },
    { key: '견적 확정',     bg: '#fef3e2', tx: '#b45309' },
    { key: '계약 취소',     bg: '#fdecec', tx: '#c0392b' },
    { key: '미정',          bg: '#eef0f3', tx: '#6b7280' }
  ];
  var CAMPS = ['진행 중', '캠페인 종료', '견적 확정', '보류'];
  function stDef(v) {
    var s = String(v == null ? '' : v).trim();
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === s) return STATUSES[i];
    return STATUSES[STATUSES.length - 1];
  }
  function stChip(v) {
    var d = stDef(v);
    return '<span style="display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;background:' + d.bg + ';color:' + d.tx + '">' + esc(d.key) + '</span>';
  }

  var S = { rows: null, src: '', at: 0, sel: null, year: '전체', bfilter: '전체', q: '', colf: {},
            sort: null, dir: 0, msg: '', saving: false, loading: false };

  /* ── 유틸 ── */
  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s₩¥원]/g, '')) || 0; }
  function f(v) { return Math.round(n(v)).toLocaleString('ko-KR'); }
  function comp(v) {
    v = Math.round(n(v)); var s = v < 0 ? '-' : ''; v = Math.abs(v);
    if (v >= 100000000) return s + (v / 100000000).toFixed(2).replace(/\.?0+$/, '') + '억';
    if (v >= 10000) return s + Math.round(v / 10000).toLocaleString('ko-KR') + '만';
    return s + v.toLocaleString('ko-KR');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }
  function attr(s) { return esc(String(s == null ? '' : s).replace(/'/g, '')); }
  function d10(v) {
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/(\d{4})[-.\/년\s]*(\d{1,2})[-.\/월\s]*(\d{1,2})/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    return s;
  }
  function today() { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); }

  /* ── 데이터 ── */
  function normRow(o, i) {
    var r = {};
    COLS.forEach(function (c) { r[c] = o[c] == null ? '' : o[c]; });
    r._row = o._row || (i + 2);
    r['서비스 종료일'] = d10(r['서비스 종료일']);
    if (!r['연도'] && r['서비스 종료일']) r['연도'] = r['서비스 종료일'].slice(0, 4);
    var v = n(r['수출바우처 금액(+VAT)']), s = n(r['정산금액(+VAT)']);
    r._bal = (String(r['수출바우처 금액(+VAT)']).trim() === '' && String(r['정산금액(+VAT)']).trim() === '') ? '' : (v - s);
    return r;
  }
  function readKV() {
    return fetch(EP + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (o) { return (o && typeof o === 'object' && !('campaigns' in o) && !('source' in o)) ? o : {}; })
      .catch(function () { return {}; });
  }
  function load(force) {
    if (S.loading) return;
    if (!force && S.rows && (Date.now() - S.at) < 300000) return;
    S.loading = true; render();
    fetch(GAS + '?action=list&t=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var arr = (j && j.ok && j.data && j.data[SHEET_KEY]) ? j.data[SHEET_KEY] : null;
        if (arr) { S.rows = arr.map(normRow); S.src = '구글시트'; S.at = Date.now(); return; }
        return readKV().then(function (o) {
          var v = o[VKEY];
          S.rows = (v && v.rows) ? v.rows.map(normRow) : [];
          S.src = 'KV(초안)'; S.at = Date.now();
        });
      })
      .catch(function () {
        return readKV().then(function (o) {
          var v = o[VKEY];
          S.rows = (v && v.rows) ? v.rows.map(normRow) : [];
          S.src = 'KV(초안)'; S.at = Date.now();
        });
      })
      .then(function () { S.loading = false; render(); })
      .catch(function () { S.loading = false; render(); });
  }

  /* ── 저장(양방향) ── */
  function flash(msg) { S.msg = msg; render(); setTimeout(function () { S.msg = ''; render(); }, 3000); }
  function saveRow(r, set, done) {
    S.saving = true; render();
    if (S.src === '구글시트') {
      fetch(GAS, { method: 'POST', body: JSON.stringify({ action: 'update', sheet: SHEET_KEY, row: r._row, name: r._nameAtLoad != null ? r._nameAtLoad : r['광고주명'], set: set }) })
        .then(function (x) { return x.json(); })
        .then(function (j) {
          S.saving = false;
          if (j && j.ok) {
            Object.keys(set).forEach(function (k) { r[k] = set[k]; });
            r._bal = n(r['수출바우처 금액(+VAT)']) - n(r['정산금액(+VAT)']);
            flash('✅ 구글시트에 저장되었습니다 (' + today() + ')');
          } else flash('❌ 저장 실패: ' + ((j && j.error) || '알 수 없는 오류'));
          if (done) done(j && j.ok);
        })
        .catch(function (e) { S.saving = false; flash('❌ 저장 실패: ' + e); if (done) done(false); });
    } else {
      /* KV 폴백(초안) */
      Object.keys(set).forEach(function (k) { r[k] = set[k]; });
      r._bal = n(r['수출바우처 금액(+VAT)']) - n(r['정산금액(+VAT)']);
      readKV().then(function (o) {
        o[VKEY] = { rows: S.rows, updatedAt: new Date().toISOString() };
        return fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
      }).then(function (x) {
        S.saving = false;
        flash(x && x.ok ? '✅ 저장됨(초안 KV) — 시트 연동은 Apps Script 갱신 후 자동 전환' : '❌ 저장 실패');
        if (done) done(x && x.ok);
      }).catch(function () { S.saving = false; flash('❌ 저장 실패'); if (done) done(false); });
    }
  }
  function appendRow(set, done) {
    S.saving = true; render();
    if (S.src === '구글시트') {
      fetch(GAS, { method: 'POST', body: JSON.stringify({ action: 'append', sheet: SHEET_KEY, set: set }) })
        .then(function (x) { return x.json(); })
        .then(function (j) {
          S.saving = false;
          if (j && j.ok) { flash('✅ 새 건이 시트에 추가되었습니다'); S.at = 0; load(true); }
          else flash('❌ 추가 실패: ' + ((j && j.error) || '오류'));
          if (done) done(j && j.ok);
        })
        .catch(function (e) { S.saving = false; flash('❌ 추가 실패: ' + e); if (done) done(false); });
    } else {
      var r = normRow(set, S.rows.length);
      r._row = (S.rows.length ? Math.max.apply(null, S.rows.map(function (x) { return x._row; })) : 1) + 1;
      S.rows.push(r);
      readKV().then(function (o) {
        o[VKEY] = { rows: S.rows, updatedAt: new Date().toISOString() };
        return fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
      }).then(function () { S.saving = false; flash('✅ 추가됨(초안 KV)'); if (done) done(true); })
        .catch(function () { S.saving = false; flash('❌ 추가 실패'); if (done) done(false); });
    }
  }

  /* ── 집계 ── */
  var SORD = { '서비스 진행중': 0, '정산 완료': 1, '견적 확정': 2, '계약 취소': 3, '미정': 4 };
  function rows() { return S.rows || []; }
  function inYear(r) { return S.year === '전체' || String(r['연도']) === S.year; }
  function years() {
    var m = {}; rows().forEach(function (r) { if (r['연도']) m[r['연도']] = (m[r['연도']] || 0) + 1; });
    return Object.keys(m).sort().reverse().map(function (y) { return { y: y, c: m[y] }; });
  }
  function agg() {
    var map = {};
    rows().filter(inYear).forEach(function (r) {
      var k = String(r['광고주명'] || '').trim() || '(광고주 미지정)';
      var a = map[k] || (map[k] = { name: k, cnt: 0, v: 0, s: 0, mgr: {}, end: [], bst: [], st: [], writer: {} });
      a.cnt++; a.v += n(r['수출바우처 금액(+VAT)']); a.s += n(r['정산금액(+VAT)']);
      if (r['담당자']) a.mgr[r['담당자']] = 1;
      if (r['서비스 종료일']) a.end.push(r['서비스 종료일']);
      a.bst.push(bDef(r['상태구분']));
      a.st.push(stDef(r['현재 상황']).key);
      if (r['작성자']) a.writer[r['작성자']] = 1;
    });
    var out = Object.keys(map).map(function (k) {
      var a = map[k];
      a.bal = a.v - a.s;
      a.rate = a.v ? Math.round(a.s / a.v * 100) : null;
      a.mgrs = Object.keys(a.mgr).sort().join('·');
      a.writers = Object.keys(a.writer).sort().join('·');
      a.last = a.end.length ? a.end.slice().sort().pop() : '';
      a.b = a.bst.slice().sort(function (x, y) { return x.ord - y.ord; })[0];     // 대표 상태구분(가장 활성)
      a.status = a.st.slice().sort(function (x, y) { return (SORD[x] || 4) - (SORD[y] || 4); })[0];
      return a;
    });
    var q = S.q.toLowerCase(), cf = S.colf;
    out = out.filter(function (a) {
      if (S.bfilter !== '전체' && a.b.key !== S.bfilter) return false;
      if (q && (a.name + ' ' + a.mgrs).toLowerCase().indexOf(q) < 0) return false;
      if (cf.name && a.name.toLowerCase().indexOf(cf.name.toLowerCase()) < 0) return false;
      if (cf.status && a.status !== cf.status) return false;
      if (cf.mgr && a.mgrs.indexOf(cf.mgr) < 0) return false;
      if (cf.bal === '있음' && !(a.bal > 0)) return false;
      if (cf.bal === '없음' && a.bal > 0) return false;
      return true;
    });
    if (S.sort && S.dir) {
      out.sort(function (x, y) {
        var a = S.sort === 'b' ? x.b.ord : x[S.sort], b = S.sort === 'b' ? y.b.ord : y[S.sort];
        if (typeof a === 'number' || typeof b === 'number') return (S.dir === 1 ? 1 : -1) * ((a || 0) - (b || 0));
        return (S.dir === 1 ? 1 : -1) * String(a || '').localeCompare(String(b || ''), 'ko');
      });
    } else {
      out.sort(function (x, y) { return x.b.ord - y.b.ord || (y.v - x.v); });
    }
    return out;
  }

  /* ── 렌더 ── */
  var TH = 'padding:7px 9px;font-size:11px;font-weight:700;color:#667085;text-align:left;background:#f7f8fa;border-bottom:2px solid #eceff3;white-space:nowrap;cursor:pointer';
  var TD = 'padding:7px 9px;font-size:12px;color:#374151;border-bottom:1px solid #f1f3f6;white-space:nowrap;';
  var IN = 'width:100%;box-sizing:border-box;padding:3px 7px;border:1px solid #e2e7ee;border-radius:6px;font-size:10.5px;background:#fff;color:#374151';

  function bar(rate, done) {
    var w = Math.max(0, Math.min(46, Math.round(46 * (rate || 0) / 100)));
    return '<span style="display:inline-block;width:46px;height:6px;border-radius:4px;background:#eceff3;position:relative;vertical-align:middle">' +
      '<span style="position:absolute;left:0;top:0;height:6px;width:' + w + 'px;border-radius:4px;background:' + (done ? '#0f6e56' : '#3778c2') + '"></span></span>';
  }

  /* 파이프라인 카드(상태구분, 클릭 필터) — 광고주 단위 집계 */
  function pipeHTML() {
    var byB = {}, all = {};
    rows().filter(inYear).forEach(function (r) {
      var k = String(r['광고주명'] || '').trim() || '(광고주 미지정)';
      var d = bDef(r['상태구분']);
      if (!all[k] || d.ord < all[k].ord) all[k] = d;
    });
    Object.keys(all).forEach(function (k) { var key = all[k].key; byB[key] = (byB[key] || 0) + 1; });
    var total = Object.keys(all).length;
    var cards = [{ key: '전체', tx: '#111827', bg: '#fff', bd: '#111827', cnt: total }]
      .concat(BST.map(function (b) { return { key: b.key, tx: b.tx, bg: b.bg, bd: b.bd, cnt: byB[b.key] || 0 }; }));
    if (byB['미분류']) cards.push({ key: '미분류', tx: '#98a2b3', bg: '#f5f6f8', bd: '#e5e8ee', cnt: byB['미분류'] });
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px">' + cards.map(function (c) {
      var on = S.bfilter === c.key;
      return '<div onclick="window.PTVC.bf(\'' + attr(c.key) + '\')" style="cursor:pointer;flex:1;min-width:104px;padding:10px 12px;border-radius:10px;background:' +
        (on ? c.bg : '#fff') + ';border:2px solid ' + (on ? c.tx : '#eceff3') + '">' +
        '<div style="font-size:11px;font-weight:700;color:' + c.tx + '">' + esc(c.key) + '</div>' +
        '<div style="font-size:20px;font-weight:800;color:' + c.tx + ';margin-top:2px">' + c.cnt +
        '<span style="font-size:11px;font-weight:600;color:#98a2b3"> 곳</span></div></div>';
    }).join('') + '</div>';
  }

  function moneyHTML() {
    var all = rows().filter(inYear).filter(function (r) { return S.bfilter === '전체' || bDef(r['상태구분']).key === S.bfilter; });
    var tv = 0, ts = 0, balCnt = 0, balSum = 0, noTax = 0;
    all.forEach(function (r) {
      var v = n(r['수출바우처 금액(+VAT)']), s = n(r['정산금액(+VAT)']);
      tv += v; ts += s;
      if (v - s > 0) { balCnt++; balSum += (v - s); }
      if (!String(r['세금계산서 발행일'] || '').trim() && stDef(r['현재 상황']).key === '정산 완료') noTax++;
    });
    function mc(lab, val, sub, col, bd) {
      return '<div style="flex:1;min-width:150px;padding:10px 13px;border-radius:10px;background:#fff;border:' + (bd || '1px solid #eceff3') + '">' +
        '<div style="font-size:10.5px;font-weight:700;color:' + (col || '#667085') + '">' + lab + '</div>' +
        '<div style="font-size:18px;font-weight:800;color:' + (col || '#111827') + ';margin-top:1px">' + val + '</div>' +
        '<div style="font-size:10px;color:' + (col || '#98a2b3') + '">' + (sub || '') + '</div></div>';
    }
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px">' +
      mc('바우처 총액', '₩' + comp(tv), all.length + '건 · VAT 포함') +
      mc('정산 완료', '₩' + comp(ts), '집행률 ' + (tv ? Math.round(ts / tv * 1000) / 10 : 0) + '%', '#0f6e56') +
      mc('미정산 잔액', '₩' + comp(balSum), balCnt + '건', balSum > 0 ? '#b45309' : null, balSum > 0 ? '1px solid #f5d9a8' : null) +
      mc('세금계산서 미발행', noTax + '건', '정산완료인데 발행일 공란', noTax > 0 ? '#c0392b' : null, noTax > 0 ? '1px solid #f3cfcf' : null) +
      '</div>';
  }

  function listHTML() {
    var list = agg();
    var yTabs = [{ y: '전체', c: rows().length }].concat(years());
    var tabs = yTabs.map(function (o) {
      var on = S.year === (o.y || o.y);
      var y = o.y;
      return '<span onclick="window.PTVC.year(\'' + y + '\')" style="cursor:pointer;font-size:12px;font-weight:700;padding:5px 13px;border-radius:9px;' +
        (S.year === y ? 'background:#111827;color:#fff' : 'background:#fff;border:1.5px solid #d8dee6;color:#667085') + '">' +
        (y === '전체' ? '전체' : y + '년') + ' ' + o.c + '</span>';
    }).join('');

    var mgrs = {}; rows().forEach(function (r) { if (r['담당자']) mgrs[r['담당자']] = 1; });
    var mgrOpts = ['<option value="">전체</option>'].concat(Object.keys(mgrs).sort().map(function (m) {
      return '<option value="' + esc(m) + '"' + (S.colf.mgr === m ? ' selected' : '') + '>' + esc(m) + '</option>'; })).join('');
    var stOpts = ['<option value="">전체</option>'].concat(STATUSES.map(function (s) {
      return '<option value="' + esc(s.key) + '"' + (S.colf.status === s.key ? ' selected' : '') + '>' + esc(s.key) + '</option>'; })).join('');

    var body = list.map(function (a) {
      var on = S.sel === a.name;
      return '<tr onclick="window.PTVC.sel(\'' + attr(a.name) + '\')" style="cursor:pointer;background:' + (on ? '#eef4fc' : '#fff') + '">' +
        '<td style="' + TD + 'font-weight:700;color:#111827">' + esc(a.name) +
          (a.cnt > 1 ? ' <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:20px;background:#eef4fc;color:#3778c2">' + a.cnt + '건</span>' : '') + '</td>' +
        '<td style="' + TD + '">' + bChip(a.b.key) + '</td>' +
        '<td style="' + TD + '">' + stChip(a.status) + '</td>' +
        '<td style="' + TD + 'text-align:right;font-weight:700">' + (a.v ? f(a.v) : '<span style="color:#c2c8d0">-</span>') + '</td>' +
        '<td style="' + TD + 'text-align:right;color:#0f6e56;font-weight:700">' + (a.s ? f(a.s) : '<span style="color:#c2c8d0">-</span>') + '</td>' +
        '<td style="' + TD + 'text-align:right;font-weight:700;color:' + (a.bal > 0 ? '#b45309' : '#c2c8d0') + '">' + (a.bal ? f(a.bal) : '0') + '</td>' +
        '<td style="' + TD + 'text-align:center">' + (a.rate == null ? '<span style="color:#c2c8d0">-</span>' :
          (bar(a.rate, a.rate >= 100) + ' <span style="font-size:10.5px;color:' + (a.rate >= 100 ? '#0f6e56' : '#667085') + '">' + a.rate + '%</span>')) + '</td>' +
        '<td style="' + TD + '">' + (esc(a.mgrs) || '-') + '</td>' +
        '<td style="' + TD + '">' + (esc(a.last) || '-') + '</td>' +
        '<td style="' + TD + 'color:#98a2b3;font-size:11px">' + (esc(a.writers) || '-') + '</td>' +
        '<td style="' + TD + 'text-align:center"><span style="font-size:11px;color:#3778c2;font-weight:700">세부 ' + a.cnt + '건 ›</span></td>' +
      '</tr>';
    }).join('');

    var HD = [['name', '광고주명'], ['b', '상태구분'], ['status', '현재 상황'], ['v', '바우처 금액'], ['s', '정산금액'],
              ['bal', '잔액'], ['rate', '집행률'], ['mgrs', '담당자'], ['last', '최근 종료일'], ['writers', '작성자']];
    var head = HD.map(function (h, i) {
      var ar = S.sort === h[0] ? (S.dir === 1 ? ' ▲' : ' ▼') : ' ⇅';
      return '<th onclick="window.PTVC.sort(\'' + h[0] + '\')" style="' + TH + (i >= 3 && i <= 6 ? ';text-align:' + (i === 6 ? 'center' : 'right') : '') + '">' + h[1] + ar + '</th>';
    }).join('') + '<th style="' + TH + ';text-align:center;cursor:default"></th>';

    var bOpts = ['<option value="">전체</option>'].concat(BST.map(function (b) {
      return '<option value="' + esc(b.key) + '"></option>'; })).join('');
    var filt = '<th style="' + TH + '"><input id="ptvc-f-name" value="' + esc(S.colf.name || '') + '" placeholder="필터" oninput="window.PTVC.cf(\'name\',this.value)" style="' + IN + '"></th>' +
      '<th style="' + TH + '"></th>' +
      '<th style="' + TH + '"><select onchange="window.PTVC.cf(\'status\',this.value)" style="' + IN + '">' + stOpts + '</select></th>' +
      '<th style="' + TH + '"></th><th style="' + TH + '"></th>' +
      '<th style="' + TH + '"><select onchange="window.PTVC.cf(\'bal\',this.value)" style="' + IN + '">' +
        ['', '있음', '없음'].map(function (v) { return '<option value="' + v + '"' + (S.colf.bal === v ? ' selected' : '') + '>' + (v || '전체') + '</option>'; }).join('') + '</select></th>' +
      '<th style="' + TH + '"></th>' +
      '<th style="' + TH + '"><select onchange="window.PTVC.cf(\'mgr\',this.value)" style="' + IN + '">' + mgrOpts + '</select></th>' +
      '<th style="' + TH + '"></th><th style="' + TH + '"></th><th style="' + TH + '"></th>';

    return pipeHTML() + moneyHTML() +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap">' + tabs +
        '<div style="flex:1;min-width:180px"><input id="ptvc-q" value="' + esc(S.q) + '" placeholder="광고주명·담당자 검색" oninput="window.PTVC.q(this.value)" style="' + IN + ';padding:6px 10px;font-size:12px"></div>' +
        '<button onclick="window.PTVC.add()" style="border:1px solid #d8dee6;background:#fff;border-radius:7px;padding:4px 10px;font-size:11px;color:#48505c;cursor:pointer">＋ 건 추가</button>' +
        '<button onclick="window.PTVC.clear()" style="border:1px solid #d8dee6;background:#fff;border-radius:7px;padding:4px 10px;font-size:11px;color:#48505c;cursor:pointer">✕ 필터 초기화</button>' +
        '<button onclick="window.PTVC.csv()" style="border:1px solid #d8dee6;background:#fff;border-radius:7px;padding:4px 10px;font-size:11px;color:#48505c;cursor:pointer">⬇ CSV</button>' +
      '</div>' +
      '<div style="font-size:11px;color:#98a2b3;margin-bottom:4px">' + list.length + '곳 표시</div>' +
      '<div style="border:1px solid #eceff3;border-radius:10px;overflow:auto"><table style="width:100%;border-collapse:collapse;min-width:1180px">' +
        '<thead><tr>' + head + '</tr><tr>' + filt + '</tr></thead><tbody>' + (body ||
          '<tr><td colspan="11" style="' + TD + 'text-align:center;color:#98a2b3;padding:18px">데이터가 없습니다. ↻ 새로고침 또는 구글시트 「수출바우처」 탭을 확인해주세요.</td></tr>') +
        '</tbody></table></div>';
  }

  function detailHTML() {
    if (!S.sel) return '';
    var items = rows().filter(inYear).filter(function (r) { return (String(r['광고주명'] || '').trim() || '(광고주 미지정)') === S.sel; });
    if (!items.length) return '';
    var v = 0, s = 0, mgr = {}, end = [];
    items.forEach(function (r) { v += n(r['수출바우처 금액(+VAT)']); s += n(r['정산금액(+VAT)']); if (r['담당자']) mgr[r['담당자']] = 1; if (r['서비스 종료일']) end.push(r['서비스 종료일']); });
    var b = items.map(function (r) { return bDef(r['상태구분']); }).sort(function (x, y) { return x.ord - y.ord; })[0];

    var body = items.map(function (r, i) {
      var bal = n(r['수출바우처 금액(+VAT)']) - n(r['정산금액(+VAT)']);
      var tax = String(r['세금계산서 발행일'] || '').trim();
      return '<tr style="' + (i % 2 ? 'background:#fafbfd' : '') + '">' +
        '<td style="' + TD + 'font-weight:700;color:#111827;max-width:300px;overflow:hidden;text-overflow:ellipsis">' + (esc(r['회사명(업무명)']) || '<span style="color:#c2c8d0">(업무명 없음)</span>') + '</td>' +
        '<td style="' + TD + '">' + bChip(r['상태구분']) + '</td>' +
        '<td style="' + TD + 'text-align:center">' + esc(r['연도']) + '</td>' +
        '<td style="' + TD + 'text-align:right;font-weight:700">' + (String(r['수출바우처 금액(+VAT)']).trim() === '' ? '<span style="color:#c2c8d0">-</span>' : f(r['수출바우처 금액(+VAT)'])) + '</td>' +
        '<td style="' + TD + 'text-align:right;color:#0f6e56;font-weight:700">' + (String(r['정산금액(+VAT)']).trim() === '' ? '<span style="color:#c2c8d0">-</span>' : f(r['정산금액(+VAT)'])) + '</td>' +
        '<td style="' + TD + 'text-align:right;color:' + (bal > 0 ? '#b45309' : '#c2c8d0') + '">' + (bal ? f(bal) : '0') + '</td>' +
        '<td style="' + TD + '">' + (esc(r['담당자']) || '-') + '</td>' +
        '<td style="' + TD + '">' + (esc(r['서비스 종료일']) || '-') + '</td>' +
        '<td style="' + TD + '">' + (tax ? esc(tax) : '<span style="font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:20px;background:#fdecec;color:#c0392b">미발행</span>') + '</td>' +
        '<td style="' + TD + '">' + stChip(r['현재 상황']) + '</td>' +
        '<td style="' + TD + 'font-size:11px;color:#667085">' + (esc(r['캠페인 진행 현황']) || '-') + '</td>' +
        '<td style="' + TD + 'color:#98a2b3;font-size:11px">' + (esc(r['작성자']) || '-') + '</td>' +
        '<td style="' + TD + 'text-align:center"><button onclick="window.PTVC.edit(' + r._row + ')" style="font-size:10.5px;color:#5b45a8;font-weight:700;border:1px solid #ded6f5;background:#f4f1fb;border-radius:7px;padding:2px 8px;cursor:pointer">✎ 편집</button></td>' +
      '</tr>';
    }).join('');

    var HD = ['회사명(업무명)', '상태구분', '연도', '바우처 금액', '정산금액', '잔액', '담당자', '서비스 종료일', '세금계산서 발행일', '현재 상황', '캠페인 진행현황', '작성자', ''];
    var head = HD.map(function (h, i) {
      return '<th style="' + TH + ';cursor:default' + (i === 2 || i === 12 ? ';text-align:center' : (i >= 3 && i <= 5 ? ';text-align:right' : '')) + '">' + h + '</th>';
    }).join('');
    function mc(lab, val, col, bd) {
      return '<div style="flex:1;min-width:130px;padding:10px 13px;border-radius:10px;background:#fff;border:' + (bd || '1px solid #eceff3') + '">' +
        '<div style="font-size:10.5px;font-weight:700;color:#667085">' + lab + '</div>' +
        '<div style="font-size:17px;font-weight:800;color:' + (col || '#111827') + ';margin-top:2px">' + val + '</div></div>';
    }

    return '<div id="ptvc-detail" style="margin:14px 0 0;padding:16px 18px;border-radius:12px;background:#fbfcfe;border:2px solid ' + b.bd + '">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<div style="font-size:17px;font-weight:800;color:#111827">' + esc(S.sel) + '</div>' + bChip(b.key) +
        '<span style="font-size:11.5px;color:#3778c2;font-weight:700">' + items.length + '건 · 바우처 ₩' + comp(v) + ' · 정산 ₩' + comp(s) + '</span>' +
        '<div style="flex:1"></div>' +
        '<a href="' + SHEET_URL + '" target="_blank" rel="noopener" style="font-size:11px;color:#3778c2;text-decoration:none">📄 시트 열기</a>' +
        '<button onclick="window.PTVC.add(\'' + attr(S.sel) + '\')" style="border:1px solid #d8dee6;background:#fff;border-radius:8px;padding:4px 12px;font-size:11px;color:#48505c;cursor:pointer">＋ 건 추가</button>' +
        '<button onclick="window.PTVC.close()" style="border:0;background:#eef1f5;color:#48505c;border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer">✕ 닫기</button>' +
      '</div>' +
      '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:12px">' +
        mc('총 바우처', '₩' + f(v)) + mc('총 정산', '₩' + f(s), '#0f6e56') +
        mc('미정산 잔액', '₩' + f(v - s), (v - s) > 0 ? '#b45309' : null, (v - s) > 0 ? '1px solid #f5d9a8' : null) +
        mc('담당자', '<span style="font-size:14px">' + (esc(Object.keys(mgr).sort().join(' · ')) || '-') + '</span>') +
        mc('최근 서비스 종료일', '<span style="font-size:14px">' + (end.length ? end.slice().sort().pop() : '-') + '</span>') +
      '</div>' +
      '<div style="margin-top:14px;font-size:12px;font-weight:800;margin-bottom:7px">📋 진행 건 상세 <span style="color:#3778c2">' + items.length + '건</span>' +
        ' <span style="font-size:10.5px;font-weight:400;color:#98a2b3">· ✎ 편집·＋ 건 추가 → ' + (S.src === '구글시트' ? '구글시트 즉시 기록' : '초안 KV 기록') + '</span></div>' +
      '<div style="border:1px solid #eceff3;border-radius:10px;overflow:auto;background:#fff;max-height:420px">' +
        '<table style="width:100%;border-collapse:collapse;min-width:1240px"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
    '</div>';
  }

  /* ── 편집/추가 모달 ── */
  function openEditor(rowNo, presetAdv) {
    var isNew = rowNo == null;
    var r;
    if (isNew) {
      r = {}; COLS.forEach(function (c) { r[c] = ''; });
      r['광고주명'] = presetAdv || ''; r['상태구분'] = '리스트업'; r['연도'] = String(new Date().getFullYear());
    } else {
      r = rows().filter(function (x) { return x._row === rowNo; })[0];
      if (!r) return;
    }
    closeEditor();
    var bOpts = BST.map(function (b) { return '<option value="' + esc(b.key) + '"' + (bDef(r['상태구분']).key === b.key ? ' selected' : '') + '>' + esc(b.key) + '</option>'; }).join('');
    var stOpts = STATUSES.filter(function (s) { return s.key !== '미정'; }).map(function (s) {
      return '<option value="' + esc(s.key) + '"' + (stDef(r['현재 상황']).key === s.key ? ' selected' : '') + '>' + esc(s.key) + '</option>'; });
    stOpts = ['<option value=""></option>'].concat(stOpts).join('');
    var cpOpts = ['<option value=""></option>'].concat(CAMPS.map(function (c) {
      return '<option value="' + esc(c) + '"' + (String(r['캠페인 진행 현황']) === c ? ' selected' : '') + '>' + esc(c) + '</option>'; })).join('');

    var F = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid #d8dee6;border-radius:8px;font-size:12.5px';
    var L = 'font-size:10.5px;color:#98a2b3;font-weight:700';
    var ov = document.createElement('div');
    ov.id = 'ptvc-ov';
    ov.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:rgba(17,24,39,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:720px;width:100%;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:92vh;overflow:auto">' +
        '<div style="font-size:16px;font-weight:800">' + (isNew ? '📦 수출바우처 새 건 추가' : '📦 수출바우처 건 편집') + '</div>' +
        (isNew ? '' : '<div style="font-size:12.5px;color:#48505c;margin-top:4px">' + esc(r['광고주명']) + ' · <b>' + esc(r['회사명(업무명)'] || '(업무명 없음)') + '</b> <span style="color:#98a2b3">(시트 ' + r._row + '행)</span></div>') +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">' +
          '<div style="flex:2;min-width:200px"><div style="' + L + '">광고주명 *</div><input id="ptvc-adv" value="' + esc(r['광고주명']) + '" ' + (isNew ? '' : 'readonly style="' + F + ';background:#f7f8fa" ') + (isNew ? 'style="' + F + '"' : '') + '></div>' +
          '<div style="flex:1;min-width:150px"><div style="' + L + '">상태구분 (영업 파이프라인)</div><select id="ptvc-b" style="' + F + '">' + bOpts + '</select></div>' +
        '</div>' +
        '<div style="margin-top:10px"><div style="' + L + '">회사명(업무명)</div><input id="ptvc-comp" value="' + esc(r['회사명(업무명)']) + '" placeholder="예: OOO_수출바우처 건(1차)" style="' + F + '"></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">수출바우처 금액(+VAT)</div><input id="ptvc-v" type="number" value="' + esc(n(r['수출바우처 금액(+VAT)']) || '') + '" style="' + F + '"></div>' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">정산금액(+VAT)</div><input id="ptvc-s" type="number" value="' + esc(n(r['정산금액(+VAT)']) || '') + '" style="' + F + '"></div>' +
          '<div style="flex:1;min-width:130px"><div style="' + L + '">담당자</div><input id="ptvc-m" value="' + esc(r['담당자']) + '" style="' + F + '"></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">' +
          '<div style="flex:1;min-width:160px"><div style="' + L + '">서비스 종료일</div><input id="ptvc-e" type="date" value="' + esc(d10(r['서비스 종료일'])) + '" style="' + F + '"></div>' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">세금계산서 발행일</div><input id="ptvc-t" value="' + esc(r['세금계산서 발행일']) + '" placeholder="예: 2026-01-27 · 미발행=공란" style="' + F + '"></div>' +
          '<div style="flex:1;min-width:130px"><div style="' + L + '">작성자</div><input id="ptvc-w" value="' + esc(r['작성자']) + '" style="' + F + '"></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">현재 상황</div><select id="ptvc-st" style="' + F + '">' + stOpts + '</select></div>' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">캠페인 진행 현황</div><select id="ptvc-cp" style="' + F + '">' + cpOpts + '</select></div>' +
        '</div>' +
        '<div style="margin-top:12px"><div style="display:flex;align-items:center;gap:8px"><div style="' + L + '">메모</div>' +
          '<button id="ptvc-stamp" style="border:1px solid #d8dee6;background:#fff;color:#48505c;border-radius:7px;padding:2px 8px;font-size:10.5px;cursor:pointer">＋ 오늘 날짜 [' + today() + ']</button></div>' +
          '<textarea id="ptvc-memo" rows="3" style="' + F + ';margin-top:5px;line-height:1.6;font-family:inherit;resize:vertical">' + esc(r['메모']) + '</textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;align-items:center">' +
          '<button id="ptvc-save" style="border:0;background:#111827;color:#fff;border-radius:9px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer">💾 저장 (' + (S.src === '구글시트' ? '시트 기록' : '초안 저장') + ')</button>' +
          '<div style="flex:1"></div>' +
          '<button id="ptvc-cancel" style="border:1px solid #e5e8ee;background:#fff;color:#48505c;border-radius:9px;padding:9px 14px;font-size:12.5px;cursor:pointer">취소</button>' +
        '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeEditor(); });
    document.getElementById('ptvc-cancel').onclick = closeEditor;
    document.getElementById('ptvc-stamp').onclick = function () {
      var t = document.getElementById('ptvc-memo');
      t.value = (t.value ? t.value + '\n' : '') + '[' + today() + '] ';
      t.focus();
    };
    document.getElementById('ptvc-save').onclick = function () {
      var g = function (id) { return document.getElementById(id).value; };
      var set = {
        '상태구분': g('ptvc-b'),
        '광고주명': g('ptvc-adv'),
        '회사명(업무명)': g('ptvc-comp'),
        '수출바우처 금액(+VAT)': g('ptvc-v') === '' ? '' : n(g('ptvc-v')),
        '정산금액(+VAT)': g('ptvc-s') === '' ? '' : n(g('ptvc-s')),
        '담당자': g('ptvc-m'),
        '서비스 종료일': g('ptvc-e'),
        '세금계산서 발행일': g('ptvc-t'),
        '현재 상황': g('ptvc-st'),
        '캠페인 진행 현황': g('ptvc-cp'),
        '작성자': g('ptvc-w'),
        '메모': g('ptvc-memo')
      };
      set['연도'] = set['서비스 종료일'] ? set['서비스 종료일'].slice(0, 4) : (r['연도'] || '');
      if (isNew && !String(set['광고주명']).trim()) { alert('광고주명은 필수입니다.'); return; }
      closeEditor();
      if (isNew) appendRow(set);
      else { r._nameAtLoad = r['광고주명']; saveRow(r, set); }
    };
  }
  function closeEditor() { var o = document.getElementById('ptvc-ov'); if (o && o.parentNode) o.parentNode.removeChild(o); }

  /* ── 전체 렌더 ── */
  function render() {
    var host = document.getElementById('tab-voucher');
    if (!host) return;
    var srcBadge = S.loading ? '<span style="font-size:11px;color:#8a94a6">불러오는 중…</span>' :
      '<span style="font-size:11px;color:' + (S.src === '구글시트' ? '#0f6e56' : '#b45309') + ';font-weight:700">' +
      (S.src === '구글시트' ? '🟢 구글시트 연동' : (S.src ? '🟡 초안(KV) — Apps Script 갱신 대기' : '-')) + '</span>';
    host.innerHTML =
      '<div style="padding:18px 20px;line-height:1.55">' +
        '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:16px 18px">' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:13px">' +
            '<div style="font-size:15px;font-weight:800">📦 수출바우처 관리</div>' +
            '<span style="font-size:11.5px;color:#8a94a6">— 광고주 클릭 시 세부내역 · 편집은 시트에 저장</span>' +
            '<div style="flex:1"></div>' + srcBadge +
            '<span style="font-size:11.5px;font-weight:600;color:' + (S.msg.indexOf('❌') === 0 ? '#c0392b' : '#128a3a') + '">' + esc(S.msg) + (S.saving ? ' 저장 중…' : '') + '</span>' +
            '<a href="' + SHEET_URL + '" target="_blank" rel="noopener" style="font-size:11px;color:#3778c2;text-decoration:none">📄 시트 열기</a>' +
            '<button onclick="window.PTVC.reload()" style="border:1px solid #e5e8ee;background:#fff;border-radius:8px;padding:4px 12px;font-size:11.5px;color:#48505c;cursor:pointer">↻ 새로고침</button>' +
          '</div>' +
          listHTML() + detailHTML() +
        '</div></div>';
  }

  /* ── 공개 API ── */
  window.PTVC = {
    reload: function () { S.at = 0; load(true); },
    year: function (y) { S.year = y; S.sel = null; render(); },
    bf: function (b) { S.bfilter = (S.bfilter === b) ? '전체' : b; S.sel = null; render(); },
    q: function (v) { S.q = v; render(); var e = document.getElementById('ptvc-q'); if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } },
    cf: function (k, v) { S.colf[k] = v; render(); if (k === 'name') { var e = document.getElementById('ptvc-f-name'); if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } } },
    clear: function () { S.colf = {}; S.q = ''; S.sort = null; S.dir = 0; S.bfilter = '전체'; render(); },
    sort: function (k) { if (S.sort === k) { S.dir = S.dir === 1 ? -1 : (S.dir === -1 ? 0 : 1); if (!S.dir) S.sort = null; } else { S.sort = k; S.dir = 1; } render(); },
    sel: function (nm) { S.sel = (S.sel === nm) ? null : nm; render(); var d = document.getElementById('ptvc-detail'); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
    close: function () { S.sel = null; render(); },
    edit: function (rowNo) { openEditor(rowNo); },
    add: function (adv) { openEditor(null, adv || ''); },
    seed: function (arr) { S.rows = (arr || []).map(normRow); return readKV().then(function (o) { o[VKEY] = { rows: S.rows, updatedAt: new Date().toISOString() }; return fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) }); }).then(function () { render(); return S.rows.length; }); },
    state: function () { return { src: S.src, rows: (S.rows || []).length, year: S.year, bfilter: S.bfilter, sel: S.sel }; },
    csv: function () {
      var list = agg();
      var head = ['광고주명', '상태구분', '건수', '현재 상황', '바우처 금액', '정산금액', '잔액', '집행률', '담당자', '최근 종료일', '작성자'];
      var lines = [head.join(',')].concat(list.map(function (a) {
        return [a.name, a.b.key, a.cnt, a.status, a.v, a.s, a.bal, (a.rate == null ? '' : a.rate + '%'), a.mgrs, a.last, a.writers]
          .map(function (x) { return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; }).join(',');
      }));
      var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = '수출바우처_광고주별_' + today() + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
    }
  };

  /* ── 탭 생성 (agency.js 와 동일 패턴) ── */
  function show() {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (x) { x.classList.remove('active'); });
    var p = document.getElementById('tab-voucher'); if (p) p.classList.add('active');
    var b = document.getElementById('tab-btn-voucher'); if (b) b.classList.add('active');
    render(); load(false);
  }
  function ensure() {
    var nav = document.getElementById('main-tabs'); if (!nav) return;
    if (!document.getElementById('tab-voucher')) {
      var ref = document.querySelector('.panel');
      if (ref && ref.parentNode) { var p = document.createElement('div'); p.id = 'tab-voucher'; p.className = 'panel'; ref.parentNode.appendChild(p); }
    }
    var b = document.getElementById('tab-btn-voucher');
    if (!b) {
      var anyTab = nav.querySelector('.tab');
      b = document.createElement('button');
      b.id = 'tab-btn-voucher'; b.className = anyTab ? anyTab.className.replace(' active', '') : 'tab';
      b.textContent = '📦 수출바우처'; b.type = 'button';
      b.addEventListener('click', show);
    }
    var row = document.getElementById('ptnavrow-sales');
    if (row) { if (b.parentElement !== row || row.lastElementChild !== b) row.appendChild(b); }
    else if (!b.parentElement) { var tm = nav.querySelector('.tabs-main') || nav; tm.appendChild(b); }
  }
  if (typeof window.showTab === 'function' && !window.showTab.__ptVoucher) {
    var _st = window.showTab;
    window.showTab = function () { var b = document.getElementById('tab-btn-voucher'); if (b) b.classList.remove('active'); return _st.apply(this, arguments); };
    window.showTab.__ptVoucher = true;
  }
  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(function () { try { ensure(); } catch (e) { } }, 250); }
  function start() {
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) { }
    setInterval(function () { try { ensure(); } catch (e) { } }, 1500);
    ensure();
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
