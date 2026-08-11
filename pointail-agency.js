/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 🤝 대행사 관리 (pointail-agency.js) v2
 *
 *  구글시트 「대행사관리_한국 / 대행사관리_일본」 2개 탭을 Apps Script 웹앱
 *  API(doGet: list / doPost: update)로 양방향 연동해 대시보드에서 관리한다.
 *   · 파이프라인 요약(리스트만·컨택중·미팅완료·계약완료·보류) — 카드 클릭 = 필터
 *   · 국가 탭(전체/한국/일본) + 검색
 *   · [v2] 표 열별 필터 행(업체명·상태·할인율·담당자·연락처·이메일·영업담당·최근연락·캠페인·메모)
 *          + 헤더 클릭 정렬(▲▼)
 *   · [v2] 업체 클릭 배너에 진행 캠페인 이력 표(오픈일·번호·브랜드·구분·상태·선정/모집·계약·실행)
 *          + 계약/실행 매출 합계. 캠페인 매칭은 행별 캐시(CM)로 성능 확보.
 *   · 행 클릭 → 상세 편집(상태·할인율(숫자만, 예: 50)·최근 연락 날짜·메모 수기 기록)
 *     저장 → 시트에 즉시 기록(POST). 메모는 자유 서식 + [오늘 날짜] 삽입 버튼.
 *  탭 버튼(tab-btn-agency)·패널(tab-agency)을 만들어 💼 영업 그룹 행에 배치.
 *  원본 index.html은 수정하지 않는다(주입형). 부트로더(MODS)로 로드.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbyDGfKsQse58Tqu5G0OwxHSSbBll4tD7EOi4TJWfFpDbLQkJjtNKNvn_W2MLnSXqCWHPw/exec';
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/1O9vJquD9xSMm2Mii0JCzqZQ5S4Ic0-WSjki808JTIxk/edit';
  var COUNTRIES = ['한국', '일본'];
  var FLAG = { '한국': '🇰🇷', '일본': '🇯🇵' };

  var STATUSES = [
    { key: '리스트만',  tx: '#6b7280', bg: '#f3f4f6', bd: '#e5e7eb' },
    { key: '컨택중',    tx: '#1e40af', bg: '#dbeafe', bd: '#bfdbfe' },
    { key: '미팅완료',  tx: '#6d28d9', bg: '#ede9fe', bd: '#ddd6fe' },
    { key: '계약완료',  tx: '#0f6e56', bg: '#e3f4ed', bd: '#bbe3d3' },
    { key: '보류',      tx: '#b45309', bg: '#fef3e2', bd: '#f6d79b' }
  ];
  function stDef(s) {
    s = String(s || '').trim() || '리스트만';
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === s) return STATUSES[i];
    return { key: s, tx: '#6b7280', bg: '#f3f4f6', bd: '#e5e7eb' };
  }

  var S = { data: null, at: null, loading: false, err: null,
            country: '전체', status: '전체', q: '',
            colf: { name: '', disc: '', mgr: '', phone: '', email: '', rep: '', last: '', camp: '', memo: '' },
            sort: null,
            sel: null, saving: false, msg: '' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s₩¥%]/g, '')) || 0; }
  function comp(v) {
    v = Math.round(v || 0); var s = v < 0 ? '-' : ''; v = Math.abs(v);
    if (v >= 100000000) return s + (v / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
    if (v >= 10000) return s + Math.round(v / 10000).toLocaleString('ko-KR') + '만';
    return s + v.toLocaleString('ko-KR');
  }
  function fmtN(v) { return Math.round(v || 0).toLocaleString('ko-KR'); }
  function today() { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); }
  function d10(s) { return String(s || '').slice(0, 10); }

  function norm(s) { return String(s || '').toLowerCase().replace(/\(주\)|㈜|주식회사|株式会社|\s+/g, '').trim(); }
  function sdVat(c, k) { try { return (typeof sd_vatIncl === 'function') ? sd_vatIncl(c, k) : n(c[k]); } catch (e) { return n(c[k]); } }
  var NORMC = null, NORMC_N = -1, CM = {};
  function normCamps() {
    var camps = (typeof DB !== 'undefined' && DB && DB.camp) ? DB.camp : [];
    if (!NORMC || NORMC_N !== camps.length) {
      NORMC = [];
      for (var i = 0; i < camps.length; i++) { var co = norm(camps[i].corpName); if (co) NORMC.push({ co: co, c: camps[i] }); }
      NORMC_N = camps.length; CM = {};
    }
    return NORMC;
  }
  function campMatch(sheet, r) {
    var camps = normCamps();
    var key = sheet + '#' + r._row + '#' + norm(r['업체명']) + '#' + norm(r['연결 광고주(법인명)']);
    if (CM[key]) return CM[key];
    var keys = [norm(r['업체명']), norm(r['연결 광고주(법인명)'])].filter(function (x) { return x.length >= 2; });
    var list = [], amt = 0, ct = 0;
    if (keys.length) {
      for (var i = 0; i < camps.length; i++) {
        var co = camps[i].co;
        for (var k = 0; k < keys.length; k++) {
          if (co === keys[k] || co.indexOf(keys[k]) >= 0 || keys[k].indexOf(co) >= 0) {
            var c = camps[i].c;
            list.push(c); amt += sdVat(c, 'execTotalAmount'); ct += sdVat(c, 'contractFinal');
            break;
          }
        }
      }
    }
    list.sort(function (a, b) { return (d10(b.recruitStartAt) || d10(b.createdAt)).localeCompare(d10(a.recruitStartAt) || d10(a.createdAt)); });
    var out = { cnt: list.length, amt: amt, contract: ct, list: list };
    CM[key] = out;
    return out;
  }

  function fetchList(force, cb) {
    if (S.loading) return;
    if (!force && S.data && S.at && (Date.now() - S.at < 5 * 60 * 1000)) { if (cb) cb(); return; }
    S.loading = true; S.err = null; render();
    fetch(API + '?action=list&t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { S.data = j.data; S.at = Date.now(); CM = {}; }
        else S.err = (j && j.error) || '불러오기 실패';
      })
      .catch(function (e) { S.err = String(e); })
      .then(function () { S.loading = false; render(); if (cb) cb(); });
  }
  function saveRow(sheet, row, name, set, done) {
    S.saving = true; S.msg = ''; renderDetailOnly();
    fetch(API, { method: 'POST', body: JSON.stringify({ action: 'update', sheet: sheet, row: row, name: name, set: set }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        S.saving = false;
        if (j && j.ok) {
          var list = (S.data && S.data[sheet]) || [];
          for (var i = 0; i < list.length; i++) if (list[i]._row === row) { Object.keys(set).forEach(function (k) { list[i][k] = String(set[k]); }); break; }
          S.msg = '✅ 시트에 저장되었습니다 (' + today() + ')';
          render();
        } else { S.msg = '❌ 저장 실패: ' + ((j && j.error) || '알 수 없는 오류'); renderDetailOnly(); }
        if (done) done(j && j.ok);
      })
      .catch(function (e) { S.saving = false; S.msg = '❌ 저장 실패: ' + e; renderDetailOnly(); if (done) done(false); });
  }

  function allRows() {
    var out = [];
    if (!S.data) return out;
    COUNTRIES.forEach(function (c) {
      (S.data[c] || []).forEach(function (r) { out.push({ sheet: c, r: r }); });
    });
    return out;
  }
  function statusOrder(s) {
    var k = stDef(s).key;
    var ord = { '계약완료': 0, '미팅완료': 1, '컨택중': 2, '리스트만': 3, '보류': 4 };
    return (k in ord) ? ord[k] : 3;
  }

  var COLS = [
    { key: 'name',  label: '업체명',      f: 'text',   get: function (x) { return String(x.r['업체명'] || ''); } },
    { key: 'status',label: '상태',        f: 'status', get: function (x) { return statusOrder(x.r['상태']); } },
    { key: 'disc',  label: '할인율',      f: 'sel',    get: function (x) { return n(x.r['대행사 할인']); }, txt: function (x) { return String(n(x.r['대행사 할인']) || ''); } },
    { key: 'mgr',   label: '업체 담당자', f: 'text',   get: function (x) { return String(x.r['업체 담당자'] || ''); } },
    { key: 'phone', label: '연락처',      f: 'text',   get: function (x) { return String(x.r['업체 연락처'] || ''); } },
    { key: 'email', label: '이메일',      f: 'text',   get: function (x) { return String(x.r['업체 이메일'] || ''); } },
    { key: 'rep',   label: '영업 담당자', f: 'sel',    get: function (x) { return String(x.r['영업 담당자'] || ''); }, txt: function (x) { return String(x.r['영업 담당자'] || '').trim() || '-'; } },
    { key: 'last',  label: '최근 연락',   f: 'text',   get: function (x) { return d10(x.r['최근 연락 날짜']); } },
    { key: 'camp',  label: '캠페인',      f: 'camp',   get: function (x) { var m = campMatch(x.sheet, x.r); return m.cnt * 1e12 + m.amt; } },
    { key: 'memo',  label: '메모',        f: 'text',   get: function (x) { return String(x.r['메모'] || ''); } }
  ];
  function colDef(k) { for (var i = 0; i < COLS.length; i++) if (COLS[i].key === k) return COLS[i]; return null; }

  function filtered() {
    var q = norm(S.q), cf = S.colf;
    var rows = allRows().filter(function (x) {
      if (S.country !== '전체' && x.sheet !== S.country) return false;
      if (S.status !== '전체' && stDef(x.r['상태']).key !== S.status) return false;
      if (q) {
        var hay = norm([x.r['업체명'], x.r['업체 담당자'], x.r['영업 담당자'], x.r['연결 광고주(법인명)'], x.r['메모'], x.r['업체 이메일']].join('|'));
        if (hay.indexOf(q) < 0) return false;
      }
      if (cf.name && norm(x.r['업체명']).indexOf(norm(cf.name)) < 0) return false;
      if (cf.mgr && norm(x.r['업체 담당자']).indexOf(norm(cf.mgr)) < 0) return false;
      if (cf.phone && String(x.r['업체 연락처'] || '').replace(/-/g, '').indexOf(String(cf.phone).replace(/-/g, '')) < 0) return false;
      if (cf.email && norm(x.r['업체 이메일']).indexOf(norm(cf.email)) < 0) return false;
      if (cf.rep && (String(x.r['영업 담당자'] || '').trim() || '-') !== cf.rep) return false;
      if (cf.disc && String(n(x.r['대행사 할인']) || '') !== cf.disc) return false;
      if (cf.last && d10(x.r['최근 연락 날짜']).indexOf(cf.last) < 0) return false;
      if (cf.memo && norm(x.r['메모']).indexOf(norm(cf.memo)) < 0) return false;
      if (cf.camp) {
        var m = campMatch(x.sheet, x.r);
        if (cf.camp === '있음' && !m.cnt) return false;
        if (cf.camp === '없음' && m.cnt) return false;
      }
      return true;
    });
    if (S.sort) {
      var cd = colDef(S.sort.key), dir = S.sort.dir;
      if (cd) rows.sort(function (a, b) {
        var va = cd.get(a), vb = cd.get(b);
        if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb), 'ko') * dir;
        return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
      });
    } else {
      rows.sort(function (a, b) {
        var oa = statusOrder(a.r['상태']), ob = statusOrder(b.r['상태']);
        if (oa !== ob) return oa - ob;
        return String(a.r['업체명']).localeCompare(String(b.r['업체명']), 'ko');
      });
    }
    return rows;
  }
  function selRow() {
    if (!S.sel || !S.data) return null;
    var list = S.data[S.sel.sheet] || [];
    for (var i = 0; i < list.length; i++) if (list[i]._row === S.sel.row) return list[i];
    return null;
  }
  function distinct(fn) {
    var seen = {}, out = [];
    allRows().forEach(function (x) { var v = fn(x); if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort(function (a, b) { return String(a).localeCompare(String(b), 'ko'); });
  }

  function badge(st) {
    var d = stDef(st);
    return '<span style="display:inline-block;font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:10px;background:' + d.bg + ';color:' + d.tx + ';border:1px solid ' + d.bd + '">' + esc(d.key) + '</span>';
  }
  function discBadge(v) {
    var d = n(v);
    if (!d) return '<span style="color:#c2c8d0;font-size:11px">-</span>';
    return '<span style="display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:8px;background:#eeedfe;color:#3c3489">' + d + '%</span>';
  }

  function summaryHTML(rows) {
    var cnt = { '전체': rows.length };
    STATUSES.forEach(function (s) { cnt[s.key] = 0; });
    rows.forEach(function (x) { var k = stDef(x.r['상태']).key; if (!(k in cnt)) cnt[k] = 0; cnt[k]++; });
    var cards = [{ key: '전체', tx: '#111827', bg: '#fff', bd: '#e5e7eb' }].concat(STATUSES);
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px">' + cards.map(function (s) {
      var on = S.status === s.key;
      return '<div onclick="window.PTAG.filterStatus(\'' + s.key + '\')" style="cursor:pointer;flex:1;min-width:96px;padding:10px 12px;border-radius:10px;background:' + (on ? s.bg : '#fff') + ';border:2px solid ' + (on ? s.tx : '#eceff3') + '">' +
        '<div style="font-size:11px;font-weight:700;color:' + s.tx + '">' + esc(s.key) + '</div>' +
        '<div style="font-size:20px;font-weight:800;color:' + s.tx + ';margin-top:2px">' + (cnt[s.key] || 0) + '<span style="font-size:11px;font-weight:600;color:#98a2b3"> 곳</span></div></div>';
    }).join('') + '</div>';
  }

  function histHTML(sheet, r) {
    var m = campMatch(sheet, r);
    if (!m.cnt) return '<div style="margin-top:14px;padding-top:12px;border-top:1px dashed #e5e7eb;font-size:12px;color:#98a2b3">📋 진행한 캠페인 이력이 없습니다 (법인명 매칭 기준 · ⚡동기화 데이터)</div>';
    var TH = 'padding:6px 9px;font-size:10.5px;font-weight:700;color:#667085;text-align:left;white-space:nowrap;background:#f7f8fa;border-bottom:2px solid #eceff3;position:sticky;top:0';
    var TD = 'padding:5px 9px;font-size:11.5px;color:#374151;white-space:nowrap;border-bottom:1px solid #f1f3f6;';
    var rows = m.list.map(function (c, i) {
      var open = d10(c.recruitStartAt) || d10(c.createdAt);
      var st = String(c.campaignStatus || '');
      var done = /완료|종료/.test(st), cancel = /취소/.test(st);
      var stCol = cancel ? '#c0392b' : (done ? '#0f6e56' : '#b45309');
      return '<tr style="' + (i % 2 ? 'background:#fafbfd' : '') + '">' +
        '<td style="' + TD + '">' + esc(open) + '</td>' +
        '<td style="' + TD + 'font-weight:700;color:#3778c2">' + esc(String(c.campaignNoText || c.campaignNo || '')) + '</td>' +
        '<td style="' + TD + 'font-weight:700;color:#111827;max-width:180px;overflow:hidden;text-overflow:ellipsis">' + esc(c.storeName || c.corpName || '') + '</td>' +
        '<td style="' + TD + '">' + esc(c.campaignType || '') + '</td>' +
        '<td style="' + TD + 'font-weight:600;color:' + stCol + '">' + esc(st || '-') + '</td>' +
        '<td style="' + TD + 'text-align:center">' + (n(c.selectedCount) || 0) + '/' + (n(c.recruitCount) || 0) + '</td>' +
        '<td style="' + TD + 'text-align:right">' + fmtN(sdVat(c, 'contractFinal')) + '</td>' +
        '<td style="' + TD + 'text-align:right;font-weight:700">' + fmtN(sdVat(c, 'execTotalAmount')) + '</td>' +
      '</tr>';
    }).join('');
    return '<div style="margin-top:14px;padding-top:12px;border-top:1px dashed #e5e7eb">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">' +
        '<div style="font-size:12px;font-weight:800;color:#111827">📋 진행 캠페인 이력 <span style="color:#3778c2">' + m.cnt + '건</span></div>' +
        '<span style="font-size:11px;color:#667085">계약 매출 합계 <b style="color:#111827">₩' + comp(m.contract) + '</b></span>' +
        '<span style="font-size:11px;color:#667085">실행 매출 합계 <b style="color:#0f6e56">₩' + comp(m.amt) + '</b></span>' +
        '<span style="font-size:10.5px;color:#98a2b3">법인명 매칭 기준 · 금액 VAT 포함 · 최신순</span>' +
      '</div>' +
      '<div style="border:1px solid #eceff3;border-radius:10px;overflow:auto;max-height:260px;background:#fff">' +
        '<table style="width:100%;border-collapse:collapse;min-width:760px"><thead><tr>' +
          ['오픈일', '캠페인 번호', '브랜드', '구분', '상태', '선정/모집', '계약 매출', '실행 매출'].map(function (h, i) { return '<th style="' + TH + (i >= 6 ? 'text-align:right' : (h === '선정/모집' ? 'text-align:center' : '')) + '">' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '</div></div>';
  }

  function detailHTML() {
    var r = selRow();
    if (!r) return '';
    var d = stDef(r['상태']);
    var m = campMatch(S.sel.sheet, r);
    var opts = STATUSES.map(function (s) { return '<option value="' + s.key + '"' + (d.key === s.key ? ' selected' : '') + '>' + s.key + '</option>'; }).join('');
    var info = function (lab, val) { return '<div style="min-width:150px"><div style="font-size:10.5px;color:#98a2b3;font-weight:600">' + lab + '</div><div style="font-size:12.5px;color:#374151;margin-top:2px">' + (esc(val) || '<span style=\'color:#c2c8d0\'>-</span>') + '</div></div>'; };
    return '<div id="ptag-detail" style="margin:0 0 12px;padding:14px 16px;border-radius:12px;background:#fbfcfe;border:2px solid ' + d.bd + '">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<div style="font-size:15px;font-weight:800;color:#111827">' + FLAG[S.sel.sheet] + ' ' + esc(r['업체명']) + '</div>' + badge(r['상태']) +
        (m.cnt ? '<span style="font-size:11px;color:#3778c2;font-weight:700">캠페인 ' + m.cnt + '건 · 실행 ₩' + comp(m.amt) + '</span>' : '<span style="font-size:11px;color:#c2c8d0">매칭 캠페인 없음</span>') +
        '<div style="flex:1"></div>' +
        '<a href="' + SHEET_URL + '" target="_blank" style="font-size:11px;color:#3778c2;text-decoration:none">📄 시트 열기 (행 ' + S.sel.row + ')</a>' +
        '<button onclick="window.PTAG.close()" style="border:0;background:#eef1f5;color:#48505c;border-radius:8px;padding:4px 10px;font-size:11px;cursor:pointer">✕ 닫기</button>' +
      '</div>' +
      '<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:10px">' +
        info('업체 담당자', r['업체 담당자']) + info('연락처', r['업체 연락처']) + info('이메일', r['업체 이메일']) +
        info('영업 담당자', r['영업 담당자']) + info('최초 소통', r['최초 소통 날짜']) + info('소통방식', r['소통방식']) +
        info('연결 광고주(법인명)', r['연결 광고주(법인명)']) +
        (r['업체사이트'] ? '<div style="min-width:150px"><div style="font-size:10.5px;color:#98a2b3;font-weight:600">사이트</div><div style="font-size:12.5px;margin-top:2px"><a href="' + esc(r['업체사이트']) + '" target="_blank" style="color:#3778c2">' + esc(r['업체사이트']) + '</a></div></div>' : '') +
      '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-top:14px;padding-top:12px;border-top:1px dashed #e5e7eb">' +
        '<div><div style="font-size:10.5px;color:#98a2b3;font-weight:700">상태</div>' +
          '<select id="ptag-in-status" style="margin-top:4px;padding:7px 10px;border:1.5px solid #d8dee6;border-radius:8px;font-size:12.5px;background:#fff">' + opts + '</select></div>' +
        '<div><div style="font-size:10.5px;color:#98a2b3;font-weight:700">대행사 할인율 (%, 숫자만 · 예: 50)</div>' +
          '<input id="ptag-in-disc" type="number" min="0" max="100" value="' + esc(n(r['대행사 할인']) || '') + '" placeholder="예: 50" style="margin-top:4px;width:130px;padding:7px 10px;border:1.5px solid #d8dee6;border-radius:8px;font-size:12.5px"></div>' +
        '<div><div style="font-size:10.5px;color:#98a2b3;font-weight:700">최근 연락 날짜</div>' +
          '<input id="ptag-in-last" type="date" value="' + esc(d10(r['최근 연락 날짜'])) + '" style="margin-top:4px;padding:6px 10px;border:1.5px solid #d8dee6;border-radius:8px;font-size:12.5px"></div>' +
        '<button onclick="window.PTAG.save()" ' + (S.saving ? 'disabled' : '') + ' style="border:0;background:#111827;color:#fff;border-radius:9px;padding:9px 18px;font-size:12.5px;font-weight:700;cursor:pointer;opacity:' + (S.saving ? '.5' : '1') + '">' + (S.saving ? '저장 중…' : '💾 저장 (시트 기록)') + '</button>' +
        '<span id="ptag-msg" style="font-size:11.5px;font-weight:600;color:' + (S.msg.indexOf('❌') === 0 ? '#c0392b' : '#128a3a') + '">' + esc(S.msg) + '</span>' +
      '</div>' +
      '<div style="margin-top:12px">' +
        '<div style="display:flex;align-items:center;gap:8px"><div style="font-size:10.5px;color:#98a2b3;font-weight:700">메모 (수기 기록 · 예: 100건/200건/300건 진행 시 할인율, 항목별 다른 할인율 등)</div>' +
          '<button onclick="window.PTAG.stamp()" style="border:1px solid #d8dee6;background:#fff;color:#48505c;border-radius:7px;padding:2px 8px;font-size:10.5px;cursor:pointer">＋ 오늘 날짜 [' + today() + ']</button></div>' +
        '<textarea id="ptag-in-memo" rows="4" style="margin-top:6px;width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #d8dee6;border-radius:9px;font-size:12.5px;line-height:1.6;font-family:inherit;resize:vertical" placeholder="예)&#10;[2026-08-11] 100건 이상 진행 시 55% 적용 협의&#10;[2026-08-11] 인플루언서 항목은 40%만 적용">' + esc(r['메모']) + '</textarea>' +
      '</div>' +
      histHTML(S.sel.sheet, r) +
    '</div>';
  }

  function filterCell(col) {
    var IN = 'width:100%;box-sizing:border-box;padding:4px 7px;border:1px solid #e2e7ee;border-radius:7px;font-size:11px;background:#fff;color:#374151';
    var cf = S.colf;
    if (col.key === 'status') {
      var so = ['전체'].concat(STATUSES.map(function (s) { return s.key; }));
      return '<select onchange="window.PTAG.filterStatus(this.value,true)" style="' + IN + '">' +
        so.map(function (v) { return '<option value="' + v + '"' + ((v === S.status) || (v === '전체' && S.status === '전체') ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select>';
    }
    if (col.f === 'sel') {
      var vals = distinct(function (x) { return col.txt(x); });
      return '<select onchange="window.PTAG.cf(\'' + col.key + '\',this.value)" style="' + IN + '">' +
        ['<option value="">전체</option>'].concat(vals.map(function (v) { return '<option value="' + esc(v) + '"' + (cf[col.key] === v ? ' selected' : '') + '>' + esc(col.key === 'disc' ? v + '%' : v) + '</option>'; })).join('') + '</select>';
    }
    if (col.f === 'camp') {
      return '<select onchange="window.PTAG.cf(\'camp\',this.value)" style="' + IN + '">' +
        ['', '있음', '없음'].map(function (v) { return '<option value="' + v + '"' + (cf.camp === v ? ' selected' : '') + '>' + (v || '전체') + '</option>'; }).join('') + '</select>';
    }
    return '<input id="ptag-cf-' + col.key + '" value="' + esc(cf[col.key]) + '" placeholder="필터" oninput="window.PTAG.cft(\'' + col.key + '\',this.value)" style="' + IN + '">';
  }

  function tableHTML(rows) {
    var TH = 'padding:8px 10px;font-size:11px;font-weight:700;color:#667085;text-align:left;white-space:nowrap;background:#f7f8fa;border-bottom:1px solid #eceff3;position:sticky;top:0;z-index:2;cursor:pointer;user-select:none';
    var FH = 'padding:5px 6px;background:#fbfcfe;border-bottom:2px solid #eceff3;position:sticky;top:33px;z-index:2';
    var TD = 'padding:7px 10px;font-size:12px;color:#374151;white-space:nowrap;border-bottom:1px solid #f1f3f6;';
    var head = COLS.map(function (c) {
      var on = S.sort && S.sort.key === c.key;
      var ar = on ? (S.sort.dir === 1 ? ' ▲' : ' ▼') : ' <span style="color:#c9cfd8">⇅</span>';
      return '<th onclick="window.PTAG.sortBy(\'' + c.key + '\')" style="' + TH + (on ? ';color:#111827' : '') + '">' + c.label + ar + '</th>';
    }).join('');
    var frow = COLS.map(function (c) { return '<th style="' + FH + '">' + filterCell(c) + '</th>'; }).join('');
    var body = rows.map(function (x) {
      var r = x.r, m = campMatch(x.sheet, r);
      var on = S.sel && S.sel.sheet === x.sheet && S.sel.row === r._row;
      var memo = String(r['메모'] || '').replace(/\n+/g, ' · ');
      if (memo.length > 34) memo = memo.slice(0, 34) + '…';
      return '<tr onclick="window.PTAG.sel(\'' + x.sheet + '\',' + r._row + ')" style="cursor:pointer;background:' + (on ? '#eef4fc' : '#fff') + '">' +
        '<td style="' + TD + 'font-weight:700;color:#111827">' + FLAG[x.sheet] + ' ' + esc(r['업체명']) + '</td>' +
        '<td style="' + TD + '">' + badge(r['상태']) + '</td>' +
        '<td style="' + TD + '">' + discBadge(r['대행사 할인']) + '</td>' +
        '<td style="' + TD + '">' + (esc(r['업체 담당자']) || '-') + '</td>' +
        '<td style="' + TD + '">' + (esc(r['업체 연락처']) || '-') + '</td>' +
        '<td style="' + TD + 'max-width:180px;overflow:hidden;text-overflow:ellipsis">' + (esc(r['업체 이메일']) || '-') + '</td>' +
        '<td style="' + TD + '">' + (esc(r['영업 담당자']) || '-') + '</td>' +
        '<td style="' + TD + '">' + (esc(d10(r['최근 연락 날짜'])) || '-') + '</td>' +
        '<td style="' + TD + '">' + (m.cnt ? '<b style="color:#3778c2">' + m.cnt + '건</b> <span style="color:#98a2b3;font-size:11px">₩' + comp(m.amt) + '</span>' : '<span style="color:#c2c8d0">-</span>') + '</td>' +
        '<td style="' + TD + 'color:#98a2b3;font-size:11px">' + (esc(memo) || '-') + '</td>' +
      '</tr>';
    }).join('');
    return '<div style="border:1px solid #eceff3;border-radius:12px;overflow:auto;max-height:560px;background:#fff">' +
      '<table style="width:100%;border-collapse:collapse;min-width:1080px"><thead><tr>' + head + '</tr><tr>' + frow + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="10" style="padding:26px;text-align:center;color:#98a2b3;font-size:12.5px">' + (S.loading ? '⏳ 불러오는 중…' : '조건에 맞는 대행사가 없습니다') + '</td></tr>') +
      '</tbody></table></div>';
  }

  function render() {
    var p = document.getElementById('tab-agency');
    if (!p || !p.classList.contains('active')) return;
    var rows0 = allRows().filter(function (x) { return S.country === '전체' || x.sheet === S.country; });
    var rows = filtered();
    var atTxt = S.at ? new Date(S.at).toTimeString().slice(0, 5) : '-';
    var cbtn = function (c, lab) {
      var on = S.country === c;
      return '<button onclick="window.PTAG.country(\'' + c + '\')" style="border:1px solid ' + (on ? '#111827' : '#d8dee6') + ';background:' + (on ? '#111827' : '#fff') + ';color:' + (on ? '#fff' : '#48505c') + ';border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer">' + lab + '</button>';
    };
    var hasCf = Object.keys(S.colf).some(function (k) { return S.colf[k]; }) || S.sort;
    p.innerHTML =
      '<div style="padding:2px 0 30px">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px">' +
          '<div style="font-size:17px;font-weight:800;color:#111827">🤝 대행사 관리</div>' +
          '<div style="display:flex;gap:6px">' + cbtn('전체', '전체') + cbtn('한국', '🇰🇷 한국') + cbtn('일본', '🇯🇵 일본') + '</div>' +
          '<input id="ptag-q" value="' + esc(S.q) + '" placeholder="🔍 업체명·담당자·광고주·메모 검색" oninput="window.PTAG.q(this.value)" style="flex:1;min-width:200px;max-width:340px;padding:7px 12px;border:1.5px solid #d8dee6;border-radius:9px;font-size:12.5px">' +
          (hasCf ? '<button onclick="window.PTAG.clearFilters()" style="border:1px solid #f0b6b6;background:#fceaea;color:#c0392b;border-radius:8px;padding:6px 11px;font-size:11px;font-weight:700;cursor:pointer">✕ 필터 초기화</button>' : '') +
          '<div style="flex:1"></div>' +
          '<span style="font-size:11px;color:#98a2b3">' + rows.length + '/' + rows0.length + '곳 · 시트 ' + atTxt + '</span>' +
          '<button onclick="window.PTAG.reload()" style="border:1px solid #d8dee6;background:#fff;color:#48505c;border-radius:8px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer">' + (S.loading ? '⏳' : '↻') + ' 새로고침</button>' +
          '<a href="' + SHEET_URL + '" target="_blank" style="font-size:11.5px;color:#3778c2;text-decoration:none;font-weight:700">📄 구글시트</a>' +
        '</div>' +
        (S.err ? '<div style="margin:0 0 12px;padding:10px 14px;border-radius:9px;background:#fceaea;color:#c0392b;font-size:12px;font-weight:600">⚠ ' + esc(S.err) + '</div>' : '') +
        summaryHTML(rows0) +
        detailHTML() +
        tableHTML(rows) +
        '<div style="font-size:11px;color:#98a2b3;margin-top:8px">할인율은 %만 관리(체험단 서비스 금액이 항목별로 달라 단가 계산은 하지 않음) · 건수별/항목별 할인 조건은 메모에 수기 기록 · 저장 시 구글시트에 즉시 반영 · 캠페인 매칭은 법인명 기준(⚡동기화 데이터)</div>' +
      '</div>';
  }
  function renderDetailOnly() {
    var el = document.getElementById('ptag-detail');
    if (!el) { render(); return; }
    var btn = el.querySelector('button[onclick="window.PTAG.save()"]');
    if (btn) { btn.disabled = S.saving; btn.style.opacity = S.saving ? '.5' : '1'; btn.textContent = S.saving ? '저장 중…' : '💾 저장 (시트 기록)'; }
    var msg = document.getElementById('ptag-msg');
    if (msg) { msg.textContent = S.msg; msg.style.color = S.msg.indexOf('❌') === 0 ? '#c0392b' : '#128a3a'; }
  }

  var qT = null, cfT = null;
  function refocus(id, pos) {
    var el = document.getElementById(id);
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} }
  }
  window.PTAG = {
    country: function (c) { S.country = c; S.sel = null; S.msg = ''; render(); },
    filterStatus: function (s, fromSel) { S.status = ((!fromSel && (S.status === s)) || s === '전체') ? '전체' : s; render(); },
    q: function (v) { S.q = v; clearTimeout(qT); qT = setTimeout(function () { var el = document.getElementById('ptag-q'); var pos = el && el.selectionStart; render(); refocus('ptag-q', pos); }, 250); },
    cf: function (k, v) { S.colf[k] = v; render(); },
    cft: function (k, v) {
      S.colf[k] = v; clearTimeout(cfT);
      cfT = setTimeout(function () { var el = document.getElementById('ptag-cf-' + k); var pos = el && el.selectionStart; render(); refocus('ptag-cf-' + k, pos); }, 300);
    },
    sortBy: function (k) {
      if (S.sort && S.sort.key === k) { S.sort = S.sort.dir === 1 ? { key: k, dir: -1 } : null; }
      else S.sort = { key: k, dir: 1 };
      render();
    },
    clearFilters: function () { S.colf = { name: '', disc: '', mgr: '', phone: '', email: '', rep: '', last: '', camp: '', memo: '' }; S.sort = null; S.status = '전체'; S.q = ''; render(); },
    sel: function (sheet, row) { S.sel = { sheet: sheet, row: row }; S.msg = ''; render(); var d = document.getElementById('ptag-detail'); if (d) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
    close: function () { S.sel = null; S.msg = ''; render(); },
    reload: function () { fetchList(true); },
    stamp: function () {
      var ta = document.getElementById('ptag-in-memo'); if (!ta) return;
      var v = ta.value; ta.value = (v ? v.replace(/\s+$/, '') + '\n' : '') + '[' + today() + '] ';
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    },
    save: function () {
      var r = selRow(); if (!r || S.saving) return;
      var st = document.getElementById('ptag-in-status');
      var di = document.getElementById('ptag-in-disc');
      var la = document.getElementById('ptag-in-last');
      var me = document.getElementById('ptag-in-memo');
      var set = {};
      if (st) set['상태'] = st.value;
      if (di) set['대행사 할인'] = String(n(di.value) || '');
      if (la && la.value) set['최근 연락 날짜'] = la.value;
      if (me) set['메모'] = me.value;
      saveRow(S.sel.sheet, S.sel.row, r['업체명'], set);
    }
  };

  function show() {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (x) { x.classList.remove('active'); });
    var p = document.getElementById('tab-agency'); if (p) p.classList.add('active');
    var b = document.getElementById('tab-btn-agency'); if (b) b.classList.add('active');
    render();
    fetchList(false);
  }

  function ensure() {
    var nav = document.getElementById('main-tabs'); if (!nav) return;
    if (!document.getElementById('tab-agency')) {
      var ref = document.querySelector('.panel');
      if (ref && ref.parentNode) { var p = document.createElement('div'); p.id = 'tab-agency'; p.className = 'panel'; ref.parentNode.appendChild(p); }
    }
    var b = document.getElementById('tab-btn-agency');
    if (!b) {
      var anyTab = nav.querySelector('.tab');
      b = document.createElement('button');
      b.id = 'tab-btn-agency'; b.className = anyTab ? anyTab.className.replace(' active', '') : 'tab';
      b.textContent = '🤝 대행사 관리'; b.type = 'button';
      b.addEventListener('click', show);
    }
    var row = document.getElementById('ptnavrow-sales');
    if (row) { if (b.parentElement !== row || row.lastElementChild !== b) row.appendChild(b); }
    else if (!b.parentElement) { var tm = nav.querySelector('.tabs-main') || nav; tm.appendChild(b); }
  }

  if (typeof window.showTab === 'function' && !window.showTab.__ptAgency) {
    var _st = window.showTab;
    window.showTab = function () { var b = document.getElementById('tab-btn-agency'); if (b) b.classList.remove('active'); return _st.apply(this, arguments); };
    window.showTab.__ptAgency = true;
  }

  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(function () { try { ensure(); } catch (e) {} }, 250); }
  function start() {
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(function () { try { ensure(); } catch (e) {} }, 1500);
    ensure();
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
