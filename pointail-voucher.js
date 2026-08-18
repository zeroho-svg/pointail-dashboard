/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 📦 수출바우처 관리 (pointail-voucher.js) v1 (초안)
 *
 *  영업 그룹 하위 탭. 2단 구조.
 *   1단 — 광고주 리스트: 건별 데이터를 광고주 단위로 집계
 *          (건수·바우처 총액·정산액·잔액·집행률·담당자·최근 종료일·현재 상황)
 *   2단 — 광고주 클릭 → 세부 진행내역: 그 광고주의 개별 건 전체 + 건별 인라인 편집
 *
 *  ── 데이터 소스 (2단계 폴백) ──
 *   ① Apps Script 웹앱 `?action=list` 응답의 `data['수출바우처']`
 *      → 스크립트에 수출바우처 탭이 추가되면 구글시트를 그대로 읽는다(자동 전환).
 *   ② 없으면 Cloudflare KV `/contacts` 의 예약 키 `__voucher__`
 *      → 초안 단계의 저장소. 대시보드에서 편집하면 여기에 기록된다.
 *   ※ `/contacts` 는 소통방식·노션연결(`__notion__`)과 같은 객체를 공유하지만
 *     서로 다른 예약 키를 쓰고, 저장은 항상 read→merge→write 라 충돌하지 않는다.
 *
 *  ── 시트 컬럼(구글시트 「수출바우처」 탭) ──
 *   No · 연도 · 광고주명 · 회사명(업무명) · 수출바우처 금액(+VAT) · 정산금액(+VAT) ·
 *   잔액 · 담당자 · 서비스 종료일 · 세금계산서 발행일 · 현재 상황 · 캠페인 진행 현황 ·
 *   작성자 · 메모
 *
 *  원본 index.html 은 수정하지 않는다(주입형). 탭 버튼 tab-btn-voucher / 패널 tab-voucher.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var GAS = 'https://script.google.com/macros/s/AKfycbyDGfKsQse58Tqu5G0OwxHSSbBll4tD7EOi4TJWfFpDbLQkJjtNKNvn_W2MLnSXqCWHPw/exec';
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var EP = WORKER + 'contacts';
  var VKEY = '__voucher__';
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/1O9vJquD9xSMm2Mii0JCzqZQ5S4Ic0-WSjki808JTIxk/edit?gid=1151609227#gid=1151609227';
  var SHEET_TAB = '수출바우처';

  var COLS = ['No', '연도', '광고주명', '회사명(업무명)', '수출바우처 금액(+VAT)', '정산금액(+VAT)',
              '잔액', '담당자', '서비스 종료일', '세금계산서 발행일', '현재 상황', '캠페인 진행 현황',
              '작성자', '메모'];

  var STATUSES = [
    { key: '서비스 진행중', bg: '#e6f1fb', tx: '#185fa5', bd: '#bfd7f0' },
    { key: '정산 완료',     bg: '#e3f4ed', tx: '#0f6e56', bd: '#bfe3d4' },
    { key: '견적 확정',     bg: '#fef3e2', tx: '#b45309', bd: '#f5d9a8' },
    { key: '계약 취소',     bg: '#fdecec', tx: '#c0392b', bd: '#f3cfcf' },
    { key: '미정',          bg: '#eef0f3', tx: '#6b7280', bd: '#e5e8ee' }
  ];
  var CAMPS = ['진행 중', '캠페인 종료', '견적 확정', '보류'];

  var S = { rows: null, src: '', at: 0, sel: null, year: '전체', q: '', colf: {},
            sort: null, dir: 0, msg: '', saving: false, loading: false, err: '' };

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
  function stDef(v) {
    var s = String(v == null ? '' : v).trim();
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === s) return STATUSES[i];
    return STATUSES[STATUSES.length - 1];
  }
  function stChip(v) {
    var d = stDef(v);
    return '<span style="display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;background:' +
      d.bg + ';color:' + d.tx + '">' + esc(d.key) + '</span>';
  }

  /* ── 데이터 로드 ── */
  function normRow(o, i) {
    var r = {};
    COLS.forEach(function (c) { r[c] = o[c] == null ? '' : o[c]; });
    r._row = o._row || (i + 2);
    r['서비스 종료일'] = d10(r['서비스 종료일']);
    if (!r['연도'] && r['서비스 종료일']) r['연도'] = r['서비스 종료일'].slice(0, 4);
    var v = n(r['수출바우처 금액(+VAT)']), s = n(r['정산금액(+VAT)']);
    r['잔액'] = (r['수출바우처 금액(+VAT)'] === '' && r['정산금액(+VAT)'] === '') ? '' : (v - s);
    return r;
  }
  function readKV() {
    return fetch(EP + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (o) { return (o && typeof o === 'object' && !('campaigns' in o) && !('source' in o)) ? o : {}; })
      .catch(function () { return {}; });
  }
  function load(force) {
    if (S.loading) return Promise.resolve();
    if (!force && S.rows && (Date.now() - S.at) < 300000) return Promise.resolve();
    S.loading = true; S.err = ''; render();
    /* ① Apps Script 시트 우선 */
    return fetch(GAS + '?action=list&t=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var arr = (j && j.ok && j.data && j.data[SHEET_TAB]) ? j.data[SHEET_TAB] : null;
        if (arr && arr.length) { S.rows = arr.map(normRow); S.src = '구글시트'; S.at = Date.now(); return; }
        /* ② KV 폴백 */
        return readKV().then(function (o) {
          var v = o[VKEY];
          S.rows = (v && v.rows && v.rows.length) ? v.rows.map(normRow) : [];
          S.src = 'KV(초안)';
          S.at = Date.now();
        });
      })
      .catch(function () {
        return readKV().then(function (o) {
          var v = o[VKEY];
          S.rows = (v && v.rows && v.rows.length) ? v.rows.map(normRow) : [];
          S.src = 'KV(초안)'; S.at = Date.now();
        });
      })
      .then(function () { S.loading = false; render(); })
      .catch(function (e) { S.loading = false; S.err = String(e && e.message || e); render(); });
  }
  /* KV 저장(초안 단계). 시트 연동 후에는 Apps Script doPost 로 교체 예정. */
  function saveRows() {
    S.saving = true; render();
    return readKV().then(function (o) {
      o[VKEY] = { rows: S.rows, updatedAt: new Date().toISOString() };
      return fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })
        .then(function (r) {
          if (!r.ok) throw new Error('save failed');
          S.saving = false; S.msg = '✅ 저장됨 · 모든 컴퓨터 적용'; render();
          setTimeout(function () { S.msg = ''; render(); }, 2600);
        });
    }).catch(function () { S.saving = false; S.msg = '❌ 저장 실패 — 네트워크 확인'; render(); });
  }

  /* ── 집계 ── */
  var ORD = { '서비스 진행중': 0, '정산 완료': 1, '견적 확정': 2, '계약 취소': 3, '미정': 4 };
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
      var a = map[k] || (map[k] = { name: k, cnt: 0, v: 0, s: 0, mgr: {}, end: [], st: [], writer: {}, items: [] });
      a.cnt++; a.v += n(r['수출바우처 금액(+VAT)']); a.s += n(r['정산금액(+VAT)']);
      if (r['담당자']) a.mgr[r['담당자']] = 1;
      if (r['서비스 종료일']) a.end.push(r['서비스 종료일']);
      a.st.push(stDef(r['현재 상황']).key);
      if (r['작성자']) a.writer[r['작성자']] = 1;
      a.items.push(r);
    });
    var out = Object.keys(map).map(function (k) {
      var a = map[k];
      a.bal = a.v - a.s;
      a.rate = a.v ? Math.round(a.s / a.v * 100) : null;
      a.mgrs = Object.keys(a.mgr).sort().join('·');
      a.writers = Object.keys(a.writer).sort().join('·');
      a.last = a.end.length ? a.end.slice().sort().pop() : '';
      a.status = a.st.slice().sort(function (x, y) { return (ORD[x] || 4) - (ORD[y] || 4); })[0];
      return a;
    });
    /* 필터 */
    var q = S.q.toLowerCase(), cf = S.colf;
    out = out.filter(function (a) {
      if (q && (a.name + ' ' + a.mgrs).toLowerCase().indexOf(q) < 0) return false;
      if (cf.name && a.name.toLowerCase().indexOf(cf.name.toLowerCase()) < 0) return false;
      if (cf.status && a.status !== cf.status) return false;
      if (cf.mgr && a.mgrs.indexOf(cf.mgr) < 0) return false;
      if (cf.bal === '있음' && !(a.bal > 0)) return false;
      if (cf.bal === '없음' && a.bal > 0) return false;
      return true;
    });
    /* 정렬 */
    if (S.sort && S.dir) {
      out.sort(function (x, y) {
        var a = x[S.sort], b = y[S.sort];
        if (typeof a === 'number' || typeof b === 'number') return (S.dir === 1 ? 1 : -1) * ((a || 0) - (b || 0));
        return (S.dir === 1 ? 1 : -1) * String(a || '').localeCompare(String(b || ''), 'ko');
      });
    } else {
      out.sort(function (x, y) { return (ORD[x.status] || 4) - (ORD[y.status] || 4) || (y.v - x.v); });
    }
    return out;
  }

  /* ── 렌더 ── */
  var TH = 'padding:7px 9px;font-size:11px;font-weight:700;color:#667085;text-align:left;background:#f7f8fa;border-bottom:2px solid #eceff3;white-space:nowrap;cursor:pointer';
  var TD = 'padding:7px 9px;font-size:12px;color:#374151;border-bottom:1px solid #f1f3f6;white-space:nowrap;';
  var IN = 'width:100%;box-sizing:border-box;padding:3px 7px;border:1px solid #e2e7ee;border-radius:6px;font-size:10.5px;background:#fff;color:#374151';

  function card(lab, val, sub, col, bd) {
    return '<div style="flex:1;min-width:142px;padding:11px 14px;border-radius:10px;background:#fff;border:' + (bd || '1px solid #eceff3') + '">' +
      '<div style="font-size:11px;font-weight:700;color:' + (col || '#667085') + '">' + lab + '</div>' +
      '<div style="font-size:21px;font-weight:800;color:' + (col || '#111827') + ';margin-top:2px">' + val + '</div>' +
      '<div style="font-size:10.5px;color:' + (col || '#98a2b3') + ';margin-top:1px">' + (sub || '') + '</div></div>';
  }
  function bar(rate, done) {
    var w = Math.max(0, Math.min(46, Math.round(46 * (rate || 0) / 100)));
    return '<span style="display:inline-block;width:46px;height:6px;border-radius:4px;background:#eceff3;position:relative;vertical-align:middle">' +
      '<span style="position:absolute;left:0;top:0;height:6px;width:' + w + 'px;border-radius:4px;background:' + (done ? '#0f6e56' : '#3778c2') + '"></span></span>';
  }

  function summaryHTML(list) {
    var all = rows().filter(inYear);
    var tv = 0, ts = 0, act = 0, actV = 0, balCnt = 0, balSum = 0, noTax = 0;
    var seenAct = {};
    all.forEach(function (r) {
      var v = n(r['수출바우처 금액(+VAT)']), s = n(r['정산금액(+VAT)']);
      tv += v; ts += s;
      if (v - s > 0) { balCnt++; balSum += (v - s); }
      if (!String(r['세금계산서 발행일'] || '').trim()) noTax++;
      if (stDef(r['현재 상황']).key === '서비스 진행중') { actV += v; var k = r['광고주명']; if (!seenAct[k]) { seenAct[k] = 1; act++; } }
    });
    return '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:13px">' +
      card('전체 광고주', list.length + '<span style="font-size:11px;font-weight:600;color:#98a2b3"> 곳</span>', '총 ' + all.length + '건', null, '2px solid #111827') +
      card('서비스 진행중', act + '<span style="font-size:11px;font-weight:600;color:#98a2b3"> 곳</span>', '₩' + comp(actV), '#185fa5', '1px solid #bfd7f0') +
      card('바우처 총액', '₩' + comp(tv), 'VAT 포함') +
      card('정산 완료', '₩' + comp(ts), '집행률 ' + (tv ? (Math.round(ts / tv * 1000) / 10) : 0) + '%', '#0f6e56') +
      card('미정산 잔액', '₩' + comp(balSum), balCnt + '건', '#b45309', '1px solid #f5d9a8') +
      card('세금계산서 미발행', noTax + '<span style="font-size:11px;font-weight:600;color:#98a2b3"> 건</span>', '발행일 공란 기준', '#c0392b', '1px solid #f3cfcf') +
      '</div>';
  }

  function listHTML() {
    var list = agg();
    var ys = years();
    var yTabs = [{ y: '전체', c: rows().length }].concat(ys.map(function (o) { return { y: o.y, c: o.c }; }));
    var tabs = yTabs.map(function (o) {
      var on = S.year === o.y;
      return '<span onclick="window.PTVC.year(\'' + o.y + '\')" style="cursor:pointer;font-size:12px;font-weight:700;padding:5px 13px;border-radius:9px;' +
        (on ? 'background:#111827;color:#fff' : 'background:#fff;border:1.5px solid #d8dee6;color:#667085') + '">' +
        (o.y === '전체' ? '전체' : o.y + '년') + ' ' + o.c + '</span>';
    }).join('');

    var mgrs = {}; rows().forEach(function (r) { if (r['담당자']) mgrs[r['담당자']] = 1; });
    var mgrOpts = ['<option value="">전체</option>'].concat(Object.keys(mgrs).sort().map(function (m) {
      return '<option value="' + esc(m) + '"' + (S.colf.mgr === m ? ' selected' : '') + '>' + esc(m) + '</option>';
    })).join('');
    var stOpts = ['<option value="">전체</option>'].concat(STATUSES.map(function (s) {
      return '<option value="' + esc(s.key) + '"' + (S.colf.status === s.key ? ' selected' : '') + '>' + esc(s.key) + '</option>';
    })).join('');

    var body = list.map(function (a) {
      var on = S.sel === a.name;
      return '<tr onclick="window.PTVC.sel(\'' + attr(a.name) + '\')" style="cursor:pointer;background:' + (on ? '#eef4fc' : '#fff') + '">' +
        '<td style="' + TD + 'font-weight:700;color:#111827">' + esc(a.name) +
          (a.cnt > 1 ? ' <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:20px;background:#eef4fc;color:#3778c2">' + a.cnt + '건</span>' : '') + '</td>' +
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

    var HD = [['name', '광고주명'], ['status', '현재 상황'], ['v', '바우처 금액'], ['s', '정산금액'],
              ['bal', '잔액'], ['rate', '집행률'], ['mgrs', '담당자'], ['last', '최근 종료일'], ['writers', '작성자']];
    var head = HD.map(function (h, i) {
      var ar = S.sort === h[0] ? (S.dir === 1 ? ' ▲' : ' ▼') : ' ⇅';
      return '<th onclick="window.PTVC.sort(\'' + h[0] + '\')" style="' + TH + (i >= 2 && i <= 5 ? ';text-align:' + (i === 5 ? 'center' : 'right') : '') + '">' + h[1] + ar + '</th>';
    }).join('') + '<th style="' + TH + ';text-align:center"></th>';

    var filt = '<th style="' + TH + '"><input id="ptvc-f-name" value="' + esc(S.colf.name || '') + '" placeholder="필터" oninput="window.PTVC.cf(\'name\',this.value)" style="' + IN + '"></th>' +
      '<th style="' + TH + '"><select onchange="window.PTVC.cf(\'status\',this.value)" style="' + IN + '">' + stOpts + '</select></th>' +
      '<th style="' + TH + '"></th><th style="' + TH + '"></th>' +
      '<th style="' + TH + '"><select onchange="window.PTVC.cf(\'bal\',this.value)" style="' + IN + '">' +
        ['', '있음', '없음'].map(function (v) { return '<option value="' + v + '"' + (S.colf.bal === v ? ' selected' : '') + '>' + (v || '전체') + '</option>'; }).join('') + '</select></th>' +
      '<th style="' + TH + '"></th>' +
      '<th style="' + TH + '"><select onchange="window.PTVC.cf(\'mgr\',this.value)" style="' + IN + '">' + mgrOpts + '</select></th>' +
      '<th style="' + TH + '"></th><th style="' + TH + '"></th><th style="' + TH + '"></th>';

    return summaryHTML(list) +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap">' + tabs +
        '<div style="flex:1;min-width:180px"><input id="ptvc-q" value="' + esc(S.q) + '" placeholder="광고주명·담당자 검색" oninput="window.PTVC.q(this.value)" style="' + IN + ';padding:6px 10px;font-size:12px"></div>' +
        '<button onclick="window.PTVC.clear()" style="border:1px solid #d8dee6;background:#fff;border-radius:7px;padding:4px 10px;font-size:11px;color:#48505c;cursor:pointer">✕ 필터 초기화</button>' +
        '<button onclick="window.PTVC.csv()" style="border:1px solid #d8dee6;background:#fff;border-radius:7px;padding:4px 10px;font-size:11px;color:#48505c;cursor:pointer">⬇ CSV</button>' +
      '</div>' +
      '<div style="font-size:11px;color:#98a2b3;margin-bottom:4px">' + list.length + ' / 전체 ' + Object.keys(rows().reduce(function (m, r) { m[r['광고주명'] || '(미지정)'] = 1; return m; }, {})).length + '곳</div>' +
      '<div style="border:1px solid #eceff3;border-radius:10px;overflow:auto"><table style="width:100%;border-collapse:collapse;min-width:1100px">' +
        '<thead><tr>' + head + '</tr><tr>' + filt + '</tr></thead><tbody>' + (body ||
          '<tr><td colspan="10" style="' + TD + 'text-align:center;color:#98a2b3;padding:18px">데이터가 없습니다. ↻ 새로고침 하거나 구글시트 「수출바우처」 탭을 확인해주세요.</td></tr>') +
        '</tbody></table></div>';
  }

  function detailHTML() {
    if (!S.sel) return '';
    var items = rows().filter(inYear).filter(function (r) { return (String(r['광고주명'] || '').trim() || '(광고주 미지정)') === S.sel; });
    if (!items.length) return '';
    var v = 0, s = 0, mgr = {}, end = [];
    items.forEach(function (r) { v += n(r['수출바우처 금액(+VAT)']); s += n(r['정산금액(+VAT)']); if (r['담당자']) mgr[r['담당자']] = 1; if (r['서비스 종료일']) end.push(r['서비스 종료일']); });
    var st = items.map(function (r) { return stDef(r['현재 상황']).key; }).sort(function (a, b) { return (ORD[a] || 4) - (ORD[b] || 4); })[0];
    var d = stDef(st);

    var TD2 = TD;
    var body = items.map(function (r, i) {
      var bal = n(r['수출바우처 금액(+VAT)']) - n(r['정산금액(+VAT)']);
      var tax = String(r['세금계산서 발행일'] || '').trim();
      return '<tr style="' + (i % 2 ? 'background:#fafbfd' : '') + '">' +
        '<td style="' + TD2 + 'font-weight:700;color:#111827;max-width:330px;overflow:hidden;text-overflow:ellipsis">' + (esc(r['회사명(업무명)']) || '<span style="color:#c2c8d0">(업무명 없음)</span>') + '</td>' +
        '<td style="' + TD2 + 'text-align:center">' + esc(r['연도']) + '</td>' +
        '<td style="' + TD2 + 'text-align:right;font-weight:700">' + (r['수출바우처 금액(+VAT)'] === '' ? '<span style="color:#c2c8d0">-</span>' : f(r['수출바우처 금액(+VAT)'])) + '</td>' +
        '<td style="' + TD2 + 'text-align:right;color:#0f6e56;font-weight:700">' + (r['정산금액(+VAT)'] === '' ? '<span style="color:#c2c8d0">-</span>' : f(r['정산금액(+VAT)'])) + '</td>' +
        '<td style="' + TD2 + 'text-align:right;color:' + (bal > 0 ? '#b45309' : '#c2c8d0') + '">' + (bal ? f(bal) : '0') + '</td>' +
        '<td style="' + TD2 + '">' + (esc(r['담당자']) || '-') + '</td>' +
        '<td style="' + TD2 + '">' + (esc(r['서비스 종료일']) || '-') + '</td>' +
        '<td style="' + TD2 + '">' + (tax ? esc(tax) : '<span style="font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:20px;background:#fdecec;color:#c0392b">미발행</span>') + '</td>' +
        '<td style="' + TD2 + '">' + stChip(r['현재 상황']) + '</td>' +
        '<td style="' + TD2 + 'font-size:11px;color:#667085">' + (esc(r['캠페인 진행 현황']) || '-') + '</td>' +
        '<td style="' + TD2 + 'color:#98a2b3;font-size:11px">' + (esc(r['작성자']) || '-') + '</td>' +
        '<td style="' + TD2 + 'text-align:center"><button onclick="window.PTVC.edit(' + r._row + ')" style="font-size:10.5px;color:#5b45a8;font-weight:700;border:1px solid #ded6f5;background:#f4f1fb;border-radius:7px;padding:2px 8px;cursor:pointer">✎ 편집</button></td>' +
      '</tr>';
    }).join('');

    var HD = ['회사명(업무명)', '연도', '바우처 금액', '정산금액', '잔액', '담당자', '서비스 종료일', '세금계산서 발행일', '현재 상황', '캠페인 진행현황', '작성자', ''];
    var head = HD.map(function (h, i) {
      return '<th style="' + TH + ';cursor:default' + (i === 1 || i === 11 ? ';text-align:center' : (i >= 2 && i <= 4 ? ';text-align:right' : '')) + '">' + h + '</th>';
    }).join('');

    return '<div id="ptvc-detail" style="margin:14px 0 0;padding:16px 18px;border-radius:12px;background:#fbfcfe;border:2px solid ' + d.bd + '">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<div style="font-size:17px;font-weight:800;color:#111827">' + esc(S.sel) + '</div>' + stChip(st) +
        '<span style="font-size:11.5px;color:#3778c2;font-weight:700">' + items.length + '건 · 바우처 ₩' + comp(v) + ' · 정산 ₩' + comp(s) + '</span>' +
        '<div style="flex:1"></div>' +
        '<a href="' + SHEET_URL + '" target="_blank" rel="noopener" style="font-size:11px;color:#3778c2;text-decoration:none">📄 시트 열기</a>' +
        '<button onclick="window.PTVC.close()" style="border:0;background:#eef1f5;color:#48505c;border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer">✕ 닫기</button>' +
      '</div>' +
      '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:12px">' +
        card('총 바우처', '₩' + f(v), '') + card('총 정산', '₩' + f(s), '', '#0f6e56') +
        card('미정산 잔액', '₩' + f(v - s), (v ? Math.round(s / v * 100) : 0) + '% 집행', (v - s) > 0 ? '#b45309' : null, (v - s) > 0 ? '1px solid #f5d9a8' : null) +
        card('담당자', '<span style="font-size:15px">' + (esc(Object.keys(mgr).sort().join(' · ')) || '-') + '</span>', '') +
        card('최근 서비스 종료일', '<span style="font-size:15px">' + (end.length ? end.slice().sort().pop() : '-') + '</span>', '') +
      '</div>' +
      '<div style="margin-top:14px;font-size:12px;font-weight:800;margin-bottom:7px">📋 진행 건 상세 <span style="color:#3778c2">' + items.length + '건</span>' +
        ' <span style="font-size:10.5px;font-weight:400;color:#98a2b3">· ✎ 편집 클릭 시 값 수정 → 저장</span></div>' +
      '<div style="border:1px solid #eceff3;border-radius:10px;overflow:auto;background:#fff;max-height:420px">' +
        '<table style="width:100%;border-collapse:collapse;min-width:1180px"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
    '</div>';
  }

  /* ── 건별 편집 모달 ── */
  function openEditor(rowNo) {
    var r = rows().filter(function (x) { return x._row === rowNo; })[0];
    if (!r) return;
    closeEditor();
    var stOpts = STATUSES.map(function (s) { return '<option value="' + esc(s.key) + '"' + (stDef(r['현재 상황']).key === s.key ? ' selected' : '') + '>' + esc(s.key) + '</option>'; }).join('');
    var cpOpts = ['<option value=""></option>'].concat(CAMPS.map(function (c) {
      return '<option value="' + esc(c) + '"' + (String(r['캠페인 진행 현황']) === c ? ' selected' : '') + '>' + esc(c) + '</option>'; })).join('');
    var ov = document.createElement('div');
    ov.id = 'ptvc-ov';
    ov.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:rgba(17,24,39,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px';
    var F = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid #d8dee6;border-radius:8px;font-size:12.5px';
    var L = 'font-size:10.5px;color:#98a2b3;font-weight:700';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:700px;width:100%;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:90vh;overflow:auto">' +
        '<div style="font-size:16px;font-weight:800">📦 수출바우처 건 편집</div>' +
        '<div style="font-size:12.5px;color:#48505c;margin-top:4px">' + esc(r['광고주명']) + ' · <b>' + esc(r['회사명(업무명)'] || '(업무명 없음)') + '</b> <span style="color:#98a2b3">(시트 ' + r._row + '행)</span></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">' +
          '<div style="flex:1;min-width:180px"><div style="' + L + '">수출바우처 금액(+VAT)</div><input id="ptvc-v" type="number" value="' + esc(n(r['수출바우처 금액(+VAT)']) || '') + '" style="' + F + '"></div>' +
          '<div style="flex:1;min-width:180px"><div style="' + L + '">정산금액(+VAT)</div><input id="ptvc-s" type="number" value="' + esc(n(r['정산금액(+VAT)']) || '') + '" style="' + F + '"></div>' +
          '<div style="flex:1;min-width:140px"><div style="' + L + '">담당자</div><input id="ptvc-m" value="' + esc(r['담당자']) + '" style="' + F + '"></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">서비스 종료일</div><input id="ptvc-e" type="date" value="' + esc(d10(r['서비스 종료일'])) + '" style="' + F + '"></div>' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">세금계산서 발행일 (텍스트 가능)</div><input id="ptvc-t" value="' + esc(r['세금계산서 발행일']) + '" placeholder="예: 2026-01-27 · 미발행이면 공란" style="' + F + '"></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">현재 상황</div><select id="ptvc-st" style="' + F + '">' + stOpts + '</select></div>' +
          '<div style="flex:1;min-width:170px"><div style="' + L + '">캠페인 진행 현황</div><select id="ptvc-cp" style="' + F + '">' + cpOpts + '</select></div>' +
          '<div style="flex:1;min-width:140px"><div style="' + L + '">작성자</div><input id="ptvc-w" value="' + esc(r['작성자']) + '" style="' + F + '"></div>' +
        '</div>' +
        '<div style="margin-top:12px"><div style="display:flex;align-items:center;gap:8px"><div style="' + L + '">메모</div>' +
          '<button id="ptvc-stamp" style="border:1px solid #d8dee6;background:#fff;color:#48505c;border-radius:7px;padding:2px 8px;font-size:10.5px;cursor:pointer">＋ 오늘 날짜 [' + today() + ']</button></div>' +
          '<textarea id="ptvc-memo" rows="3" style="' + F + ';margin-top:5px;line-height:1.6;font-family:inherit;resize:vertical">' + esc(r['메모']) + '</textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;align-items:center">' +
          '<button id="ptvc-save" style="border:0;background:#111827;color:#fff;border-radius:9px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer">💾 저장</button>' +
          '<div style="flex:1"></div>' +
          '<button id="ptvc-cancel" style="border:1px solid #e5e8ee;background:#fff;color:#48505c;border-radius:9px;padding:9px 14px;font-size:12.5px;cursor:pointer">취소</button>' +
        '</div>' +
        '<div style="font-size:10.5px;color:#98a2b3;margin-top:9px">※ 초안 단계 — 저장은 공유 저장소(KV)에 기록됩니다. 구글시트 양방향 연동은 Apps Script 확장 후 적용됩니다.</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeEditor(); });
    document.getElementById('ptvc-cancel').onclick = closeEditor;
    document.getElementById('ptvc-stamp').onclick = function () {
      var t = document.getElementById('ptvc-memo');
      t.value = (t.value ? t.value + '\n' : '') + '[' + today() + '] ';
      t.focus();
    };
    document.getElementById('ptvc-save').onclick = function () {
      r['수출바우처 금액(+VAT)'] = document.getElementById('ptvc-v').value === '' ? '' : n(document.getElementById('ptvc-v').value);
      r['정산금액(+VAT)'] = document.getElementById('ptvc-s').value === '' ? '' : n(document.getElementById('ptvc-s').value);
      r['담당자'] = document.getElementById('ptvc-m').value;
      r['서비스 종료일'] = document.getElementById('ptvc-e').value;
      r['세금계산서 발행일'] = document.getElementById('ptvc-t').value;
      r['현재 상황'] = document.getElementById('ptvc-st').value;
      r['캠페인 진행 현황'] = document.getElementById('ptvc-cp').value;
      r['작성자'] = document.getElementById('ptvc-w').value;
      r['메모'] = document.getElementById('ptvc-memo').value;
      if (r['서비스 종료일']) r['연도'] = r['서비스 종료일'].slice(0, 4);
      var vv = n(r['수출바우처 금액(+VAT)']), ss = n(r['정산금액(+VAT)']);
      r['잔액'] = (r['수출바우처 금액(+VAT)'] === '' && r['정산금액(+VAT)'] === '') ? '' : (vv - ss);
      closeEditor(); saveRows();
    };
  }
  function closeEditor() { var o = document.getElementById('ptvc-ov'); if (o && o.parentNode) o.parentNode.removeChild(o); }

  /* ── 전체 렌더 ── */
  function render() {
    var host = document.getElementById('tab-voucher');
    if (!host) return;
    var srcBadge = S.loading ? '<span style="font-size:11px;color:#8a94a6">불러오는 중…</span>' :
      '<span style="font-size:11px;color:#8a94a6">출처 ' + esc(S.src || '-') + ' · 5분 캐시</span>';
    host.innerHTML =
      '<div style="padding:18px 20px;line-height:1.55">' +
        '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:16px 18px">' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:13px">' +
            '<div style="font-size:15px;font-weight:800">📦 수출바우처 관리</div>' +
            '<span style="font-size:11.5px;color:#8a94a6">— 구글시트 「수출바우처」 · 광고주 클릭 시 세부내역</span>' +
            '<div style="flex:1"></div>' + srcBadge +
            '<span id="ptvc-msg" style="font-size:11.5px;font-weight:600;color:' + (S.msg.indexOf('❌') === 0 ? '#c0392b' : '#128a3a') + '">' + esc(S.msg) + '</span>' +
            '<a href="' + SHEET_URL + '" target="_blank" rel="noopener" style="font-size:11px;color:#3778c2;text-decoration:none">📄 시트 열기</a>' +
            '<button onclick="window.PTVC.reload()" style="border:1px solid #e5e8ee;background:#fff;border-radius:8px;padding:4px 12px;font-size:11.5px;color:#48505c;cursor:pointer">↻ 새로고침</button>' +
          '</div>' +
          listHTML() +
          detailHTML() +
        '</div></div>';
  }

  /* ── 공개 API ── */
  window.PTVC = {
    reload: function () { S.at = 0; load(true); },
    year: function (y) { S.year = y; S.sel = null; render(); },
    q: function (v) { S.q = v; render(); var e = document.getElementById('ptvc-q'); if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } },
    cf: function (k, v) { S.colf[k] = v; render(); if (k === 'name') { var e = document.getElementById('ptvc-f-name'); if (e) { e.focus(); e.setSelectionRange(v.length, v.length); } } },
    clear: function () { S.colf = {}; S.q = ''; S.sort = null; S.dir = 0; render(); },
    sort: function (k) { if (S.sort === k) { S.dir = S.dir === 1 ? -1 : (S.dir === -1 ? 0 : 1); if (!S.dir) S.sort = null; } else { S.sort = k; S.dir = 1; } render(); },
    sel: function (nm) { S.sel = (S.sel === nm) ? null : nm; render(); var d = document.getElementById('ptvc-detail'); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
    close: function () { S.sel = null; render(); },
    edit: openEditor,
    /* 초안 시드 주입(관리용) — PTVC.seed([{...}]) */
    seed: function (arr) { S.rows = (arr || []).map(normRow); return saveRows().then(function () { return S.rows.length; }); },
    state: function () { return { src: S.src, rows: (S.rows || []).length, year: S.year, sel: S.sel }; },
    csv: function () {
      var list = agg();
      var head = ['광고주명', '건수', '현재 상황', '바우처 금액', '정산금액', '잔액', '집행률', '담당자', '최근 종료일', '작성자'];
      var lines = [head.join(',')].concat(list.map(function (a) {
        return [a.name, a.cnt, a.status, a.v, a.s, a.bal, (a.rate == null ? '' : a.rate + '%'), a.mgrs, a.last, a.writers]
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
