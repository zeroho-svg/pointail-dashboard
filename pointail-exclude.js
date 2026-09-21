/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 캠페인DB 통합 표 + 수동 제외  v3 (2026-09-21)
 *
 *  [v3 통합 개편] v2는 「제외 작업대」 표를 원본 캠페인DB 표 위에 따로 얹어,
 *  같은 데이터를 보는 표가 2개(A/B)가 되고 검색·필터도 두 벌이 됐다.
 *  게다가 원본 표가 2,060행 × 39열 = 80,340셀을 한 번에 그려 1회 렌더 806~842ms.
 *  → v3은 window.renderCamps 를 오버라이드해 표를 **하나로 합치고 페이지네이션**한다.
 *    ① 모드 탭: [📋 전체 보기](39열 원본 확인) / [🚫 제외 작업](핵심 11열 + 체크박스)
 *       — 검색·필터·페이지는 두 모드가 공유하므로 보던 자리를 잃지 않는다
 *    ② 페이지네이션 100행 — 셀 80,340 → 약 1,200~4,000 (실측 806ms → 수십 ms)
 *    ③ 열 고르기(39개 중 선택, localStorage 저장)
 *    ④ 제외 작업 모드: 상단 요약 바 + 후보 칩 5종 + 체크박스(Shift 구간) + 하단 액션바
 *    ⑤ 제외 목록 드로어(검색·정렬·복원·CSV) + 되돌리기 토스트
 *  원본 index.html은 수정하지 않는다(주입형). 전역 renderCamps 만 교체.
 *
 *  제외 목록은 Cloudflare Worker(KV)에 공유 저장 → 여러 컴퓨터에서 누적·공유.
 * ──────────────────────────────────────────────────────────── */
(function () {
  var LS = 'pt_excluded_camps';                 // 로컬 캐시 { "<no>": {..., _full} }
  var MIG = 'pt_excl_migrated';                 // 로컬 제외를 공용으로 1회 병합했는지 플래그
  var LS_MODE = 'pt_camp_mode', LS_COLS = 'pt_camp_cols', LS_SIZE = 'pt_camp_size';
  var WORKER = 'https://pointail-api.zeroho.workers.dev';
  var SIZES = [50, 100, 200];

  /* 제외 작업 모드에서 보여줄 핵심 열 */
  var CORE = ['campaignNo', 'campaignStatus', 'campaignTitle', 'storeName', 'corpName',
    'recruitCount', 'selectedCount', 'missionDoneCount', 'salesManager', 'contractFinal', 'createdAt'];

  function loadEx() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
  function saveEx(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} }
  function isEx(no) { return Object.prototype.hasOwnProperty.call(loadEx(), String(no)); }
  function noOf(c) { return String((c && (c.campaignNo != null ? c.campaignNo : c.campaignNoText)) || '').trim(); }
  function numify(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s]/g, '')) || 0; }
  function fmt(v) { return numify(v).toLocaleString('ko-KR'); }
  function eok(v) { var n = numify(v); return n >= 1e8 ? (n / 1e8).toFixed(2) + '억' : Math.round(n / 1e4).toLocaleString('ko-KR') + '만'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function camps() { return (typeof DB !== 'undefined' && DB.camp) ? DB.camp : []; }
  function schema() { return (typeof SCHEMAS !== 'undefined' && SCHEMAS.camp) ? SCHEMAS.camp : []; }
  function snap(c) {
    return {
      no: noOf(c), title: c.campaignTitle || '', campaignType: c.campaignType || '',
      advertiserCountry: c.advertiserCountry || '', contractFinal: c.contractFinal || '0',
      salesManager: c.salesManager || '', marketingType: c.marketingType || '', createdAt: c.createdAt || '',
      storeName: c.storeName || '', corpName: c.corpName || '', campaignStatus: c.campaignStatus || '',
      _full: c
    };
  }
  function d10(c) { return String(c.createdAt || '').slice(0, 10); }
  function ageDays(c) { var s = d10(c); if (!s) return 0; return (Date.now() - new Date(s + 'T00:00:00').getTime()) / 864e5; }

  // ── 공용 저장소(Worker KV) ── (index.html의 전역 fetch 래퍼가 Bearer 토큰 자동 첨부)
  function pullShared(cb) {
    fetch(WORKER + '/exclusions?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (o) { cb(o && typeof o === 'object' ? o : null); })
      .catch(function () { cb(null); });
  }
  function pushShared(obj, cb) {
    fetch(WORKER + '/exclusions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
      .then(function (r) { cb && cb(r.ok); }).catch(function () { cb && cb(false); });
  }

  // ── shouldExcludeRow 패치: 동기화 시 제외 번호 자동 제거(모든 집계 반영) ──
  if (typeof window.shouldExcludeRow === 'function' && !window.shouldExcludeRow.__exPatched) {
    var _sxr = window.shouldExcludeRow;
    window.shouldExcludeRow = function (type, row) {
      if (type === 'camp') { var no = noOf(row); if (no && isEx(no)) return true; }
      return _sxr.apply(this, arguments);
    };
    window.shouldExcludeRow.__exPatched = true;
  }
  function trimDbCamp() {
    if (typeof DB === 'undefined' || !DB.camp) return;
    var ex = loadEx();
    DB.camp = DB.camp.filter(function (c) { var no = noOf(c); return !(no && ex[no]); });
  }

  /* ══════════ 상태 ══════════ */
  var UI = {
    mode: 'all',        // 'all' = 전체 보기 / 'ex' = 제외 작업
    page: 1, size: 100,
    preset: '', showEx: false,
    cols: null,         // {fieldId:true} — null이면 전체
    sel: {}, lastIdx: null, lastEx: null, viewRows: []
  };
  try {
    var m = localStorage.getItem(LS_MODE); if (m === 'all' || m === 'ex') UI.mode = m;
    var s = parseInt(localStorage.getItem(LS_SIZE), 10); if (SIZES.indexOf(s) >= 0) UI.size = s;
    var c = JSON.parse(localStorage.getItem(LS_COLS) || 'null'); if (c && typeof c === 'object') UI.cols = c;
  } catch (e) {}
  function saveUI() {
    try {
      localStorage.setItem(LS_MODE, UI.mode); localStorage.setItem(LS_SIZE, String(UI.size));
      if (UI.cols) localStorage.setItem(LS_COLS, JSON.stringify(UI.cols));
    } catch (e) {}
  }
  function visibleCols() {
    var sc = schema();
    if (UI.mode === 'ex') return sc.filter(function (f) { return CORE.indexOf(f.id) >= 0; });
    if (!UI.cols) return sc;                                   // 기본 = 39개 전부
    var out = sc.filter(function (f) { return UI.cols[f.id]; });
    return out.length ? out : sc;
  }

  /* ══════════ 제외 후보 프리셋 ══════════ */
  var PRESETS = [
    { k: 'zero', label: '🚫 선정 0명', tip: '모집했지만 선정 인원이 0명 (등록 대기 제외)', test: function (c) { return numify(c.selectedCount) === 0 && c.campaignStatus !== '등록 대기'; } },
    { k: 'wait', label: '⏳ 등록 대기 30일+', tip: '등록 대기 상태로 30일 이상 방치', test: function (c) { return c.campaignStatus === '등록 대기' && ageDays(c) >= 30; } },
    { k: 'pause', label: '⏸ 일시 중지', tip: '일시 중지 상태', test: function (c) { return c.campaignStatus === '일시 중지'; } },
    { k: 'nomsn', label: '💤 종료·미션 0', tip: '캠페인이 종료됐는데 미션 완료 인원이 0명', test: function (c) { return c.campaignStatus === '캠페인 종료' && numify(c.missionDoneCount) === 0; } },
    { k: 'amt0', label: '💰 계약매출 0원', tip: '계약 최종 금액이 0원 (집계에 잡히지 않는 건)', test: function (c) { return numify(c.contractFinal) === 0; } }
  ];
  function testPreset(c) { if (!UI.preset) return true; for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].k === UI.preset) return PRESETS[i].test(c); return true; }

  /* ══════════ 스타일 ══════════ */
  function ensureStyle() {
    if (document.getElementById('ptx-style')) return;
    var st = document.createElement('style'); st.id = 'ptx-style';
    st.textContent = [
      '.ptx{--l:#e5e7eb;--m:#8a94a6;--i:#111827;--i2:#48505c;--b:#2563eb;--r:#c0392b;font-size:13px;color:var(--i);margin:0 0 10px}',
      '.ptx *{box-sizing:border-box}',
      /* 모드 탭 */
      '.ptx .modes{display:flex;gap:6px;background:#fff;border:1px solid var(--l);border-radius:11px;padding:4px;flex-wrap:wrap;align-items:center;margin-bottom:8px}',
      '.ptx .modes button.md{border:none;background:none;font:inherit;font-size:13px;font-weight:700;color:var(--i2);padding:7px 15px;border-radius:8px;cursor:pointer}',
      '.ptx .modes button.md.on{background:var(--i);color:#fff}',
      '.ptx .modes .sp{flex:1} .ptx .modes .nt{font-size:11.5px;color:var(--m);padding-right:6px}',
      '.ptx .xb{border:1px solid var(--l);background:#fff;border-radius:9px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:600;color:var(--i2);cursor:pointer;white-space:nowrap}',
      '.ptx .xb:hover{border-color:var(--b);color:var(--b)}',
      '.ptx .xb.pri{background:var(--i);border-color:var(--i);color:#fff} .ptx .xb.pri:hover{background:#000;color:#fff}',
      '.ptx .xb.dngr{background:#fef2f2;border-color:#fecaca;color:var(--r)}',
      '.ptx .xb.s{padding:3px 8px;font-size:11.5px;border-radius:7px}',
      /* 제외 요약 바 */
      '.ptx .bar{display:flex;align-items:center;gap:11px;flex-wrap:wrap;background:#fff;border:1px solid var(--l);border-radius:11px;padding:9px 13px;margin-bottom:8px}',
      '.ptx .bar .tag{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13.5px}',
      '.ptx .bar .dot{width:8px;height:8px;border-radius:50%;background:var(--r)}',
      '.ptx .bar .mm{font-size:12.5px;color:var(--i2)} .ptx .bar .mm b{color:var(--i)}',
      '.ptx .mu{font-size:11.5px;color:var(--m)}',
      /* 후보 칩 */
      '.ptx .chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;background:#fff;border:1px solid var(--l);border-radius:11px;padding:9px 13px;margin-bottom:8px}',
      '.ptx .chips .lb{font-size:11.5px;color:var(--m);font-weight:700;margin-right:2px}',
      '.ptx .chip{border:1px solid var(--l);background:#fff;border-radius:20px;padding:4px 11px;font-size:12px;font-weight:600;color:var(--i2);cursor:pointer}',
      '.ptx .chip:hover{border-color:var(--b);color:var(--b)}',
      '.ptx .chip.on{background:#eaf1fe;border-color:var(--b);color:var(--b)}',
      '.ptx .chip .n{font-size:11px;color:var(--m);margin-left:4px} .ptx .chip.on .n{color:var(--b)}',
      '.ptx .sw{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--i2);margin-left:auto;cursor:pointer;user-select:none}',
      '.ptx .sw input{width:15px;height:15px;accent-color:var(--b)}',
      /* 표 안 요소 */
      '#camp-table-wrap .ptxck{width:15px;height:15px;accent-color:#2563eb;cursor:pointer;display:inline-block!important;width:15px!important}',
      '#camp-table-wrap tr.ptxsel{background:#eef5ff}',
      '#camp-table-wrap tr.ptxexd{background:#fafafa;color:#a6adba}',
      '#camp-table-wrap .ptxrb{opacity:0;transition:opacity .12s}',
      '#camp-table-wrap tr:hover .ptxrb,#camp-table-wrap tr.ptxexd .ptxrb{opacity:1}',
      '#camp-table-wrap .ptxbtn{border:1px solid #fecaca;background:#fef2f2;color:#c0392b;border-radius:7px;padding:2px 8px;font:inherit;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}',
      '#camp-table-wrap .ptxbtn.n{border-color:#e5e7eb;background:#fff;color:#48505c}',
      /* 페이지네이션 */
      '.ptxpg{display:flex;align-items:center;gap:5px;justify-content:center;padding:10px;border-top:1px solid #e5e7eb;background:#fcfdff;flex-wrap:wrap;font-size:12px}',
      '.ptxpg button{border:1px solid #e5e7eb;background:#fff;border-radius:7px;min-width:30px;height:28px;padding:0 8px;font:inherit;font-size:12px;font-weight:600;color:#48505c;cursor:pointer}',
      '.ptxpg button.on{background:#111827;border-color:#111827;color:#fff}',
      '.ptxpg button:disabled{opacity:.35;cursor:default}',
      '.ptxpg .info{font-size:11.5px;color:#8a94a6;margin-left:8px}',
      '.ptxpg .szs{margin-left:10px;display:flex;gap:4px;align-items:center}',
      /* 열 고르기 모달 */
      '#ptx-mask{position:fixed;inset:0;background:rgba(16,24,40,.35);z-index:9998;display:none}#ptx-mask.on{display:block}',
      '#ptx-cols{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:760px;max-width:94vw;max-height:82vh;background:#fff;border-radius:14px;z-index:9999;display:none;flex-direction:column;box-shadow:0 20px 50px rgba(16,24,40,.25);color:#111827;font-size:13px}',
      '#ptx-cols.on{display:flex}',
      '#ptx-cols .hd{padding:13px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px}#ptx-cols .hd h3{margin:0;font-size:15px}',
      '#ptx-cols .bd2{flex:1;overflow:auto;padding:13px 18px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px}',
      '@media(max-width:700px){#ptx-cols .bd2{grid-template-columns:repeat(2,1fr)}}',
      '#ptx-cols .ft{padding:10px 18px;border-top:1px solid #e5e7eb;display:flex;gap:8px;align-items:center;font-size:12px;color:#8a94a6}',
      '#ptx-cols .ci{display:flex;align-items:center;gap:7px;font-size:12.5px;border:1px solid #e5e7eb;border-radius:8px;padding:6px 9px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '#ptx-cols .ci.on{background:#eaf1fe;border-color:#2563eb;color:#2563eb;font-weight:600}',
      '#ptx-cols .ci input{width:14px!important;height:14px;accent-color:#2563eb;flex:0 0 auto;display:inline-block!important}',
      '#ptx-cols button{border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;font-weight:600;color:#48505c;cursor:pointer}',
      /* 하단 액션바 */
      '#ptx-selbar{position:fixed;left:0;right:0;bottom:0;z-index:9997;transform:translateY(130%);transition:transform .18s ease;background:#111827;color:#fff;box-shadow:0 -6px 24px rgba(16,24,40,.24);font-family:inherit}',
      '#ptx-selbar.on{transform:none}',
      '#ptx-selbar .in{max-width:1600px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;gap:13px;flex-wrap:wrap}',
      '#ptx-selbar .cnt{font-weight:800;font-size:15px} #ptx-selbar .meta{font-size:12.5px;color:#c7cdd8}',
      '#ptx-selbar button{border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#fff;border-radius:9px;padding:7px 13px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}',
      '#ptx-selbar button:hover{background:rgba(255,255,255,.18);border-color:#fff}',
      '#ptx-selbar button.go{background:#dc2626;border-color:#dc2626} #ptx-selbar button.go:hover{background:#b91c1c}',
      /* 제외 목록 드로어 */
      '#ptx-drw{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:94vw;background:#fff;z-index:9999;box-shadow:-8px 0 30px rgba(16,24,40,.2);transform:translateX(100%);transition:transform .2s ease;display:flex;flex-direction:column;font-size:13px;color:#111827}',
      '#ptx-drw.on{transform:none}',
      '#ptx-drw .hd{padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px}#ptx-drw .hd h3{margin:0;font-size:15.5px}',
      '#ptx-drw .tl{padding:10px 18px;border-bottom:1px solid #e5e7eb;display:flex;gap:7px;flex-wrap:wrap;align-items:center}',
      '#ptx-drw .tl input,#ptx-drw .tl select{border:1px solid #e5e7eb;border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;height:auto!important}',
      '#ptx-drw .tl input{flex:1 1 150px;min-width:130px;width:auto!important;display:block}',
      '#ptx-drw .tl select{flex:0 0 auto;width:auto!important;min-width:128px;display:inline-block!important}',
      '#ptx-drw .tl button{flex:0 0 auto}',
      '#ptx-drw .body{flex:1;overflow:auto} #ptx-drw .ft{padding:10px 18px;border-top:1px solid #e5e7eb;display:flex;gap:8px;align-items:center;font-size:12px;color:#8a94a6}',
      '#ptx-drw .er{display:flex;align-items:center;gap:10px;padding:8px 18px;border-bottom:1px solid #f1f3f6;font-size:12.5px}',
      '#ptx-drw .er .g{flex:1;min-width:0} #ptx-drw .er .g .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#ptx-drw .er .amt{font-variant-numeric:tabular-nums;color:#48505c;white-space:nowrap}',
      '#ptx-drw .gp{padding:6px 18px;background:#f8fafc;font-size:11.5px;font-weight:700;color:#48505c;border-bottom:1px solid #e5e7eb;position:sticky;top:0}',
      '#ptx-drw button{border:1px solid #e5e7eb;background:#fff;border-radius:7px;padding:3px 9px;font:inherit;font-size:11.5px;font-weight:600;color:#48505c;cursor:pointer}',
      '#ptx-drw button.dngr{background:#fef2f2;border-color:#fecaca;color:#c0392b}',
      /* 토스트 */
      '#ptx-toast{position:fixed;left:50%;bottom:104px;z-index:10000;transform:translate(-50%,24px);background:#111827;color:#fff;border-radius:11px;padding:11px 15px;display:flex;align-items:center;gap:12px;font-size:13px;box-shadow:0 8px 26px rgba(16,24,40,.3);opacity:0;pointer-events:none;transition:opacity .16s,transform .16s}',
      '#ptx-toast.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}',
      '#ptx-toast button{background:none;border:none;color:#7fb3ff;font:inherit;font-weight:800;cursor:pointer}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ══════════ 전역 오버레이(하단 바·드로어·토스트·열 모달) ══════════ */
  function ensureGlobals() {
    if (!document.getElementById('ptx-selbar')) {
      var b = document.createElement('div'); b.id = 'ptx-selbar';
      b.innerHTML = '<div class="in"><span class="cnt" id="ptx-selcnt">0건 선택</span>' +
        '<span class="meta" id="ptx-selmeta"></span><span style="flex:1"></span>' +
        '<button id="ptx-clear">선택 해제</button><button class="go" id="ptx-go">🚫 선택한 건 제외</button></div>';
      document.body.appendChild(b);
      b.querySelector('#ptx-clear').addEventListener('click', function () { UI.sel = {}; renderCampsNew(); });
      b.querySelector('#ptx-go').addEventListener('click', function () { var ks = Object.keys(UI.sel); if (ks.length) addExclusions(ks); });
    }
    if (!document.getElementById('ptx-mask')) {
      var m = document.createElement('div'); m.id = 'ptx-mask'; document.body.appendChild(m);
      m.addEventListener('click', function () { closeDrawer(); closeCols(); });

      var d = document.createElement('aside'); d.id = 'ptx-drw';
      d.innerHTML = '<div class="hd"><h3>🚫 제외된 캠페인</h3><span style="flex:1"></span><button id="ptx-close">✕ 닫기</button></div>' +
        '<div class="tl"><input type="text" id="ptx-dq" placeholder="제외 목록 내 검색">' +
        '<select id="ptx-dsort"><option value="date">최근 제외순</option><option value="amt">계약매출 높은순</option><option value="no">번호순</option></select>' +
        '<button id="ptx-csv">⬇ CSV</button></div>' +
        '<div class="body" id="ptx-dbody"></div>' +
        '<div class="ft"><span id="ptx-dft"></span><span style="flex:1"></span><button class="dngr" id="ptx-rall">전체 복원</button></div>';
      document.body.appendChild(d);
      d.querySelector('#ptx-close').addEventListener('click', closeDrawer);
      d.querySelector('#ptx-dq').addEventListener('input', drawList);
      d.querySelector('#ptx-dsort').addEventListener('change', drawList);
      d.querySelector('#ptx-csv').addEventListener('click', csvEx);
      d.querySelector('#ptx-rall').addEventListener('click', function () {
        var n = Object.keys(loadEx()).length; if (!n) return;
        if (confirm('제외된 ' + n + '건을 모두 복원할까요? (모든 컴퓨터 공유)')) restoreAll();
      });

      var cm = document.createElement('div'); cm.id = 'ptx-cols';
      cm.innerHTML = '<div class="hd"><h3>⚙ 표시할 열 고르기</h3><span style="flex:1"></span><span class="mu" id="ptx-ccnt" style="font-size:11.5px;color:#8a94a6"></span><button id="ptx-cclose">✕ 닫기</button></div>' +
        '<div class="bd2" id="ptx-cbox"></div>' +
        '<div class="ft"><span>선택은 이 컴퓨터에 저장됩니다 · 열이 적을수록 표가 가벼워집니다</span><span style="flex:1"></span>' +
        '<button id="ptx-cpre-core">핵심 11개</button><button id="ptx-cpre-all">전체 보기</button></div>';
      document.body.appendChild(cm);
      cm.querySelector('#ptx-cclose').addEventListener('click', closeCols);
      cm.querySelector('#ptx-cpre-core').addEventListener('click', function () { colPreset('core'); });
      cm.querySelector('#ptx-cpre-all').addEventListener('click', function () { colPreset('all'); });
    }
    if (!document.getElementById('ptx-toast')) {
      var t = document.createElement('div'); t.id = 'ptx-toast';
      t.innerHTML = '<span id="ptx-tmsg"></span><button id="ptx-undo">되돌리기</button>';
      document.body.appendChild(t);
      t.querySelector('#ptx-undo').addEventListener('click', undo);
    }
  }

  /* ══════════ 컨트롤 바(모드 탭 · 제외 요약 · 후보 칩) ══════════ */
  function ensureControls() {
    var host = document.getElementById('tab-camp-t'); if (!host) return null;
    // v2의 옛 패널이 남아 있으면 제거
    var old = document.getElementById('pt-exclude-panel'); if (old) old.parentNode.removeChild(old);
    var box = document.getElementById('ptx-ctl');
    if (!box) {
      box = document.createElement('div'); box.id = 'ptx-ctl'; box.className = 'ptx';
      var card = host.querySelector('.card');
      if (card) host.insertBefore(box, card); else host.appendChild(box);
      box.addEventListener('click', onCtlClick);
    }
    return box;
  }
  function onCtlClick(e) {
    var t = e.target.closest ? e.target.closest('[data-a]') : null; if (!t) return;
    var a = t.getAttribute('data-a');
    if (a === 'mode') { setMode(t.getAttribute('data-v')); }
    else if (a === 'cols') { openCols(); }
    else if (a === 'chip') { UI.preset = (UI.preset === t.getAttribute('data-v') ? '' : t.getAttribute('data-v')); UI.page = 1; renderCampsNew(); }
    else if (a === 'drawer') { openDrawer(); }
    else if (a === 'num') {
      var v = prompt('제외할 캠페인 번호 (쉼표·공백·줄바꿈으로 여러 개)\n예: 102683, 102540');
      if (!v) return; var nums = v.split(/[\s,]+/).filter(Boolean); if (nums.length) addExclusions(nums);
    }
  }
  function setMode(m) {
    UI.mode = m; UI.page = 1; UI.sel = {}; if (m === 'all') UI.preset = '';
    saveUI(); renderCampsNew();
  }
  function controlsHTML() {
    var ex = loadEx(), ks = Object.keys(ex);
    var sum = ks.reduce(function (a, k) { return a + numify(ex[k].contractFinal); }, 0);
    var h = '<div class="modes">' +
      '<button class="md' + (UI.mode === 'all' ? ' on' : '') + '" data-a="mode" data-v="all">📋 전체 보기</button>' +
      '<button class="md' + (UI.mode === 'ex' ? ' on' : '') + '" data-a="mode" data-v="ex">🚫 제외 작업</button>' +
      '<span class="sp"></span>' +
      '<span class="nt">' + (UI.mode === 'ex' ? '판단에 필요한 핵심 ' + CORE.length + '개 열 + 체크박스' : '표시 열 ' + visibleCols().length + '개 / 전체 ' + schema().length + '개') + '</span>' +
      (UI.mode === 'all' ? '<button class="xb" data-a="cols">⚙ 열 고르기</button>' : '') +
      '</div>';
    if (UI.mode === 'ex') {
      h += '<div class="bar">' +
        '<span class="tag"><span class="dot"></span> 캠페인 수동 제외</span>' +
        '<span class="mm">제외 <b>' + fmt(ks.length) + '</b>건 · 제외 계약매출 <b>' + eok(sum) + '</b></span>' +
        '<span class="mu">신청만 하고 미사용 · 모든 집계에서 제외 · 전 컴퓨터 공유</span>' +
        '<span class="sp"></span>' +
        '<button class="xb" data-a="num">⌨ 번호로 추가</button>' +
        '<button class="xb pri" data-a="drawer">📋 제외 목록 열기</button>' +
        '</div>';
      var rows = camps();
      h += '<div class="chips"><span class="lb">제외 후보 빠른 찾기</span>';
      PRESETS.forEach(function (p) {
        h += '<span class="chip' + (UI.preset === p.k ? ' on' : '') + '" data-a="chip" data-v="' + p.k + '" title="' + esc(p.tip) + '">' +
          p.label + ' <span class="n">' + fmt(rows.filter(p.test).length) + '건</span></span>';
      });
      h += '<label class="sw"><input type="checkbox" id="ptx-showex"' + (UI.showEx ? ' checked' : '') + '> 제외된 건도 함께 보기</label></div>';
    }
    return h;
  }

  /* ══════════ 표 렌더 (window.renderCamps 오버라이드) ══════════ */
  function filterRows() {
    var q = (document.getElementById('cc-q') ? document.getElementById('cc-q').value : '').toLowerCase();
    var catF = document.getElementById('cc-cat') ? document.getElementById('cc-cat').value : '';
    var coF = document.getElementById('cc-country') ? document.getElementById('cc-country').value : '';
    var stF = document.getElementById('cc-status') ? document.getElementById('cc-status').value : '';
    var rows = camps().filter(function (r) {
      if (q) {
        var s = (r.corpName || r.storeName || r.company || '') + (r.campaignTitle || r.campaignName || '') + (r.campaignNo || '') + (r.salesManager || '');
        if (s.toLowerCase().indexOf(q) < 0) return false;
      }
      if (catF && String(r.category || '').trim() !== catF) return false;
      if (coF && String(r.advertiserCountry || '').trim() !== coF) return false;
      if (stF && r.campaignStatus !== stF) return false;
      if (UI.mode === 'ex' && !testPreset(r)) return false;
      return true;
    });
    if (typeof CF !== 'undefined' && CF.applyToRows) rows = CF.applyToRows('camp', rows);
    if (UI.mode === 'ex' && UI.showEx) {
      var ex = loadEx();
      Object.keys(ex).forEach(function (no) {
        var r = ex[no], fu = r._full || {};
        rows.push({ campaignNo: no, campaignStatus: r.campaignStatus || fu.campaignStatus || '', campaignTitle: r.title || '',
          storeName: r.storeName || fu.storeName || '', corpName: r.corpName || fu.corpName || '',
          recruitCount: fu.recruitCount || '', selectedCount: fu.selectedCount || '', missionDoneCount: fu.missionDoneCount || '',
          salesManager: r.salesManager || '', contractFinal: r.contractFinal || 0, createdAt: r.createdAt || '', __ex: true });
      });
      rows.sort(function (a, b) { return numify(b.campaignNo) - numify(a.campaignNo); });
    }
    return rows;
  }

  function renderCampsNew() {
    var wrap = document.getElementById('camp-table-wrap'); if (!wrap) return;
    ensureStyle(); ensureGlobals();
    var box = ensureControls(); if (box) box.innerHTML = controlsHTML();
    var se = document.getElementById('ptx-showex');
    if (se) se.addEventListener('change', function () { UI.showEx = this.checked; UI.page = 1; renderCampsNew(); });

    // 상태 드롭다운 자동 생성 (원본 로직 유지)
    var stSel = document.getElementById('cc-status');
    if (stSel && stSel.options.length <= 1) {
      var sts = []; camps().forEach(function (r) { if (r.campaignStatus && sts.indexOf(r.campaignStatus) < 0) sts.push(r.campaignStatus); });
      sts.sort().forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; stSel.appendChild(o); });
    }

    var rows = filterRows();
    var cols = visibleCols();
    var pages = Math.max(1, Math.ceil(rows.length / UI.size));
    if (UI.page > pages) UI.page = pages;
    if (UI.page < 1) UI.page = 1;
    var slice = rows.slice((UI.page - 1) * UI.size, UI.page * UI.size);
    UI.viewRows = slice;

    var cnt = document.getElementById('cc-count');
    if (cnt) cnt.textContent = rows.length.toLocaleString('ko-KR') + '건 / 전체 ' + camps().length.toLocaleString('ko-KR') + '건';

    // 보이는 열에 대해서만 고유값 계산(열 필터 활성 표시용)
    var allValsMap = {};
    cols.forEach(function (f) {
      var seen = {}, arr = [];
      for (var i = 0; i < rows.length; i++) { var v = rows[i][f.id] || ''; if (!seen[v]) { seen[v] = 1; arr.push(v); } }
      allValsMap[f.id] = arr;
    });

    var statusColor = { '모집중': 'b-going', '등록 완료': 'b-mem', '완료': 'b-camp', '취소': 'b-fail', '강제종료': 'b-fail', '선정중': 'b-hold', '진행중': 'b-going' };
    var payColor = { '결제완료': 'b-camp', '결제대기': 'b-hold', '결제취소': 'b-fail' };
    var NUMF = ['recruitCount', 'applicantCount', 'selectedCount', 'missionDoneCount', 'execMissionDone',
      'pointRevenue', 'contractSaleSum', 'contractMktCost', 'contractVat', 'contractFinal', 'contractSalePrice',
      'execMktAmount', 'execDiscount', 'execNetAmount', 'execTotalAmount'];
    var minW = Math.max(600, cols.length * 120);
    var isEX = UI.mode === 'ex';

    var head = '<tr>' +
      (isEX ? '<th style="min-width:34px"><input type="checkbox" class="ptxck" id="ptx-all"></th>' : '') +
      cols.map(function (f) { return (typeof CF !== 'undefined' && CF.makeTh) ? CF.makeTh('camp', f.id, f.label, allValsMap[f.id]) : '<th>' + esc(f.label) + '</th>'; }).join('') +
      '<th style="min-width:' + (isEX ? 70 : 36) + 'px"></th></tr>';

    var body = slice.length ? slice.map(function (r) {
      var no = noOf(r), sel = !!UI.sel[no];
      var tds = cols.map(function (f) {
        var v = r[f.id] != null && r[f.id] !== '' ? r[f.id] : '—';
        if (f.id === 'campaignStatus') return '<td style="padding:5px 8px">' + (r.__ex ? '<span class="badge b-fail">제외됨</span>' : '<span class="badge ' + (statusColor[v] || 'b-none') + '">' + esc(v) + '</span>') + '</td>';
        if (f.id === 'payStatus') return '<td style="padding:5px 8px"><span class="badge ' + (payColor[v] || 'b-none') + '">' + esc(v) + '</span></td>';
        if (f.id === 'recruitStartAt' || f.id === 'createdAt') return '<td style="white-space:nowrap;padding:7px 8px">' + esc(v !== '—' ? String(v).slice(0, 16) : v) + '</td>';
        var isNum = NUMF.indexOf(f.id) >= 0;
        var dv = isNum && typeof fmtMoney === 'function' ? fmtMoney(v) : v;
        return '<td title="' + esc(v) + '" style="white-space:nowrap;padding:7px 8px;max-width:160px;overflow:hidden;text-overflow:ellipsis;' + (isNum ? 'text-align:right;font-variant-numeric:tabular-nums' : '') + '">' + esc(dv) + '</td>';
      }).join('');
      var act = isEX
        ? (r.__ex ? '<button class="ptxbtn n ptxrb" data-x="res" data-no="' + esc(no) + '">복원</button>'
                  : '<button class="ptxbtn ptxrb" data-x="one" data-no="' + esc(no) + '">🚫 제외</button>')
        : '<button class="del-btn" onclick="deleteRow(\'camp\',' + camps().indexOf(r) + ')">✕</button>';
      return '<tr class="' + (r.__ex ? 'ptxexd' : '') + (sel ? ' ptxsel' : '') + '">' +
        (isEX ? '<td style="padding:4px 8px">' + (r.__ex ? '' : '<input type="checkbox" class="ptxck" data-x="pick" data-no="' + esc(no) + '"' + (sel ? ' checked' : '') + '>') + '</td>' : '') +
        tds + '<td style="padding:4px;text-align:center">' + act + '</td></tr>';
    }).join('') : '<tr><td colspan="' + (cols.length + 2) + '" style="padding:24px;text-align:center;color:var(--tx3);font-size:12px">' +
      (camps().length ? '조건에 맞는 캠페인이 없습니다.' : '데이터 없음 — 구글시트 동기화 버튼을 눌러 최신화하세요') + '</td></tr>';

    // 페이지네이션
    var pg = '<div class="ptxpg"><button data-x="pg" data-p="1"' + (UI.page === 1 ? ' disabled' : '') + '>«</button>' +
      '<button data-x="pg" data-p="' + (UI.page - 1) + '"' + (UI.page === 1 ? ' disabled' : '') + '>‹</button>';
    var s = Math.max(1, UI.page - 3), e = Math.min(pages, s + 6); s = Math.max(1, e - 6);
    for (var i = s; i <= e; i++) pg += '<button data-x="pg" data-p="' + i + '"' + (i === UI.page ? ' class="on"' : '') + '>' + i + '</button>';
    pg += '<button data-x="pg" data-p="' + (UI.page + 1) + '"' + (UI.page === pages ? ' disabled' : '') + '>›</button>' +
      '<button data-x="pg" data-p="' + pages + '"' + (UI.page === pages ? ' disabled' : '') + '>»</button>' +
      '<span class="info">' + fmt(rows.length ? (UI.page - 1) * UI.size + 1 : 0) + '–' + fmt(Math.min(UI.page * UI.size, rows.length)) + ' / ' + fmt(rows.length) + '건 · 이 페이지 ' + fmt(slice.length * (cols.length + 1)) + '셀</span>' +
      '<span class="szs"><span class="info" style="margin:0">쪽당</span>' +
      SIZES.map(function (z) { return '<button data-x="sz" data-z="' + z + '"' + (UI.size === z ? ' class="on"' : '') + '>' + z + '</button>'; }).join('') + '</span></div>';

    wrap.innerHTML = '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="min-width:' + minW + 'px;table-layout:auto">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' + pg;

    if (!wrap.__ptxWired) { wrap.addEventListener('click', onTableClick); wrap.__ptxWired = true; }
    syncBar();
  }

  function onTableClick(e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    var x = t.getAttribute('data-x');
    if (x === 'pg') { var p = +t.getAttribute('data-p'); if (!t.disabled) { UI.page = p; renderCampsNew(); window.scrollTo({ top: document.getElementById('tab-camp-t').offsetTop - 10, behavior: 'smooth' }); } e.stopPropagation(); return; }
    if (x === 'sz') { UI.size = +t.getAttribute('data-z'); UI.page = 1; saveUI(); renderCampsNew(); e.stopPropagation(); return; }
    if (x === 'one') { addExclusions([t.getAttribute('data-no')]); e.stopPropagation(); return; }
    if (x === 'res') { restore(t.getAttribute('data-no')); e.stopPropagation(); return; }
    if (x === 'pick') { pick(e, t.getAttribute('data-no')); e.stopPropagation(); return; }
    if (t.id === 'ptx-all') {
      if (t.checked) UI.viewRows.forEach(function (r) { if (!r.__ex) UI.sel[noOf(r)] = true; }); else UI.sel = {};
      renderCampsNew(); e.stopPropagation(); return;
    }
  }
  function pick(e, no) {
    var idx = -1; for (var i = 0; i < UI.viewRows.length; i++) if (noOf(UI.viewRows[i]) === no) { idx = i; break; }
    if (e.shiftKey && UI.lastIdx !== null && idx >= 0) {
      var a = Math.min(UI.lastIdx, idx), b = Math.max(UI.lastIdx, idx);
      for (var k = a; k <= b; k++) { var r = UI.viewRows[k]; if (r && !r.__ex) UI.sel[noOf(r)] = true; }
    } else { if (UI.sel[no]) delete UI.sel[no]; else UI.sel[no] = true; }
    UI.lastIdx = idx; renderCampsNew();
  }
  function syncBar() {
    var bar = document.getElementById('ptx-selbar'); if (!bar) return;
    var ks = Object.keys(UI.sel), n = ks.length;
    var byNo = {}; camps().forEach(function (c) { byNo[noOf(c)] = c; });
    var sum = ks.reduce(function (a, k) { return a + numify(byNo[k] && byNo[k].contractFinal); }, 0);
    document.getElementById('ptx-selcnt').textContent = n + '건 선택';
    document.getElementById('ptx-selmeta').textContent = n ? '계약매출 합계 ' + fmt(sum) + '원 — 제외하면 모든 집계에서 빠집니다' : '';
    var host = document.getElementById('tab-camp-t');
    bar.classList.toggle('on', n > 0 && UI.mode === 'ex' && !!(host && host.offsetParent !== null));
    var all = document.getElementById('ptx-all');
    if (all) { var ss = UI.viewRows.filter(function (r) { return !r.__ex; }); all.checked = ss.length > 0 && ss.every(function (r) { return UI.sel[noOf(r)]; }); }
  }

  /* ══════════ 열 고르기 ══════════ */
  function openCols() { ensureGlobals(); drawCols(); document.getElementById('ptx-cols').classList.add('on'); document.getElementById('ptx-mask').classList.add('on'); }
  function closeCols() { var c = document.getElementById('ptx-cols'); if (!c) return; c.classList.remove('on'); if (!document.getElementById('ptx-drw').classList.contains('on')) document.getElementById('ptx-mask').classList.remove('on'); }
  function drawCols() {
    var sc = schema(), cur = UI.cols;
    var box = document.getElementById('ptx-cbox');
    box.innerHTML = sc.map(function (f) {
      var on = !cur || !!cur[f.id];
      return '<label class="ci' + (on ? ' on' : '') + '" title="' + esc(f.label) + '"><input type="checkbox" data-c="' + esc(f.id) + '"' + (on ? ' checked' : '') + '>' + esc(f.label) + '</label>';
    }).join('');
    if (!box.__w) {
      box.addEventListener('change', function (e) {
        var id = e.target.getAttribute && e.target.getAttribute('data-c'); if (!id) return;
        if (!UI.cols) { UI.cols = {}; schema().forEach(function (f) { UI.cols[f.id] = true; }); }
        UI.cols[id] = !UI.cols[id];
        if (!schema().some(function (f) { return UI.cols[f.id]; })) UI.cols[id] = true;   // 전부 해제 방지
        saveUI(); drawCols(); renderCampsNew();
      });
      box.__w = true;
    }
    var n = sc.filter(function (f) { return !cur || cur[f.id]; }).length;
    document.getElementById('ptx-ccnt').textContent = n + ' / ' + sc.length + '개 선택';
  }
  function colPreset(k) {
    UI.cols = {}; schema().forEach(function (f) { UI.cols[f.id] = (k === 'all') ? true : CORE.indexOf(f.id) >= 0; });
    saveUI(); drawCols(); renderCampsNew();
  }

  /* ══════════ 제외 / 복원 ══════════ */
  function addExclusions(nums) {
    var byNo = {}; camps().forEach(function (c) { byNo[noOf(c)] = c; });
    var toAdd = {}, added = 0, notFound = [], now = Date.now();
    nums.forEach(function (x) {
      var n = String(x).trim(); if (!n) return;
      if (byNo[n]) { toAdd[n] = snap(byNo[n]); }
      else { toAdd[n] = { no: n, title: '(현재 목록에 없음 · 동기화 후 확인)', contractFinal: '0' }; notFound.push(n); }
      toAdd[n]._at = now; added++;
    });
    if (!added) return;
    pullShared(function (shared) {
      var merged = Object.assign({}, shared || loadEx());
      for (var k in toAdd) merged[k] = toAdd[k];
      saveEx(merged); pushShared(merged);
      if (typeof DB !== 'undefined' && DB.camp) DB.camp = DB.camp.filter(function (c) { return !merged[noOf(c)]; });
      UI.lastEx = Object.keys(toAdd);
      Object.keys(toAdd).forEach(function (k) { delete UI.sel[k]; });
      persistAndRender(); drawList();
      toast('🚫 ' + added + '건 제외했습니다 · 전 컴퓨터 공유 저장됨' +
        (notFound.length ? ' (목록에 없던 번호 ' + notFound.length + '건 포함 — 동기화 후 반영)' : ''));
    });
  }
  function restore(no) {
    no = String(no);
    pullShared(function (shared) {
      var ex = shared || loadEx();
      var rec = ex[no] || loadEx()[no];
      delete ex[no]; saveEx(ex); pushShared(ex);
      if (rec && rec._full && typeof DB !== 'undefined') {
        DB.camp = DB.camp || [];
        if (!DB.camp.some(function (c) { return noOf(c) === no; })) DB.camp.push(rec._full);
      }
      persistAndRender(); drawList();
    });
  }
  function restoreAll() {
    pullShared(function (shared) {
      var ex = shared || loadEx();
      Object.keys(ex).forEach(function (no) {
        var rec = ex[no];
        if (rec && rec._full && typeof DB !== 'undefined') {
          DB.camp = DB.camp || [];
          if (!DB.camp.some(function (c) { return noOf(c) === no; })) DB.camp.push(rec._full);
        }
      });
      saveEx({}); pushShared({});
      persistAndRender(); drawList();
    });
  }
  function undo() {
    if (!UI.lastEx || !UI.lastEx.length) return;
    var list = UI.lastEx.slice(); UI.lastEx = null; hideToast();
    pullShared(function (shared) {
      var ex = shared || loadEx();
      list.forEach(function (no) {
        var rec = ex[no];
        if (rec && rec._full && typeof DB !== 'undefined') {
          DB.camp = DB.camp || [];
          if (!DB.camp.some(function (c) { return noOf(c) === no; })) DB.camp.push(rec._full);
        }
        delete ex[no];
      });
      saveEx(ex); pushShared(ex);
      persistAndRender(); drawList();
    });
  }
  function persistAndRender() {
    try { if (typeof saveState === 'function') saveState(); } catch (e) {}
    try { if (typeof renderAll === 'function') renderAll(); } catch (e) {}
    renderCampsNew();
  }

  /* ══════════ 토스트 ══════════ */
  var ttmr;
  function toast(msg) {
    ensureGlobals();
    document.getElementById('ptx-tmsg').textContent = msg;
    document.getElementById('ptx-undo').style.display = (UI.lastEx && UI.lastEx.length) ? '' : 'none';
    document.getElementById('ptx-toast').classList.add('on');
    clearTimeout(ttmr); ttmr = setTimeout(hideToast, 8000);
  }
  function hideToast() { var t = document.getElementById('ptx-toast'); if (t) t.classList.remove('on'); }

  /* ══════════ 제외 목록 드로어 ══════════ */
  function openDrawer() { ensureGlobals(); document.getElementById('ptx-drw').classList.add('on'); document.getElementById('ptx-mask').classList.add('on'); drawList(); }
  function closeDrawer() { var d = document.getElementById('ptx-drw'); if (!d) return; d.classList.remove('on'); if (!document.getElementById('ptx-cols').classList.contains('on')) document.getElementById('ptx-mask').classList.remove('on'); }
  function exArr() {
    var ex = loadEx();
    return Object.keys(ex).map(function (no) {
      var r = ex[no];
      return { no: no, title: r.title || '', store: r.storeName || '', rep: r.salesManager || '', day: String(r.createdAt || '').slice(0, 10), amt: numify(r.contractFinal), at: r._at || 0 };
    });
  }
  function drawList() {
    var body = document.getElementById('ptx-dbody'); if (!body) return;
    var q = ((document.getElementById('ptx-dq') || {}).value || '').trim().toLowerCase();
    var srt = (document.getElementById('ptx-dsort') || {}).value || 'date';
    var arr = exArr().filter(function (r) { return !q || (r.no + ' ' + r.title + ' ' + r.store + ' ' + r.rep).toLowerCase().indexOf(q) > -1; });
    if (srt === 'amt') arr.sort(function (a, b) { return b.amt - a.amt; });
    else if (srt === 'no') arr.sort(function (a, b) { return numify(b.no) - numify(a.no); });
    else arr.sort(function (a, b) { return (b.at - a.at) || (numify(b.no) - numify(a.no)); });
    var t0 = new Date(); t0.setHours(0, 0, 0, 0); t0 = t0.getTime();
    var grp = '', h = '';
    arr.forEach(function (r) {
      var g = r.at >= t0 ? '오늘 제외' : (r.at ? '이전에 제외' : '제외 시각 기록 없음 (v2 이전)');
      if (g !== grp) { grp = g; h += '<div class="gp">' + g + '</div>'; }
      h += '<div class="er"><span style="width:60px;font-weight:700;font-variant-numeric:tabular-nums">' + esc(r.no) + '</span>' +
        '<span class="g"><div class="t">' + esc(r.title) + '</div><div style="font-size:11px;color:#8a94a6">' +
        esc([r.store, r.rep, r.day].filter(Boolean).join(' · ') || '—') + '</div></span>' +
        '<span class="amt">' + fmt(r.amt) + '원</span>' +
        '<button class="ptx-dres" data-no="' + esc(r.no) + '">복원</button></div>';
    });
    body.innerHTML = h || '<div style="padding:24px;text-align:center;color:#8a94a6;font-size:12.5px">표시할 항목이 없습니다.</div>';
    if (!body.__w) {
      body.addEventListener('click', function (e) {
        if (e.target.classList && e.target.classList.contains('ptx-dres')) restore(e.target.getAttribute('data-no'));
      });
      body.__w = true;
    }
    document.getElementById('ptx-dft').innerHTML = '총 <b>' + fmt(arr.length) + '</b>건 · 계약매출 ' + fmt(arr.reduce(function (a, r) { return a + r.amt; }, 0)) + '원';
  }
  function csvEx() {
    var arr = exArr().sort(function (a, b) { return numify(b.no) - numify(a.no); });
    var lines = ['캠페인번호,제목,스토어명,영업담당자,생성일,계약매출'];
    arr.forEach(function (r) {
      lines.push([r.no, r.title, r.store, r.rep, r.day, r.amt].map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = '제외캠페인_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  /* ══════════ renderCamps 오버라이드 + 필터 입력 시 1페이지로 ══════════ */
  function installOverride() {
    if (window.renderCamps && window.renderCamps.__ptxV3) return;
    window.renderCamps = renderCampsNew;
    window.renderCamps.__ptxV3 = true;
  }
  function wireFilters() {
    ['cc-q', 'cc-cat', 'cc-country', 'cc-status'].forEach(function (id) {
      var el = document.getElementById(id); if (!el || el.__ptxW) return;
      el.addEventListener(id === 'cc-q' ? 'input' : 'change', function () { UI.page = 1; UI.sel = {}; });
      el.__ptxW = true;
    });
  }

  // 탭 밖에서는 하단 바·토스트 숨김
  setInterval(function () {
    var host = document.getElementById('tab-camp-t');
    var vis = host && host.offsetParent !== null;
    var bar = document.getElementById('ptx-selbar');
    if (bar && !vis) bar.classList.remove('on');
    if (!vis) hideToast();
    installOverride(); wireFilters();
  }, 800);

  // ── 초기화: 공용 저장소 동기화(최초 1회 로컬 병합 → 이후 공용이 원본) ──
  function init() {
    installOverride(); wireFilters();
    pullShared(function (shared) {
      shared = shared || {};
      var migrated = localStorage.getItem(MIG) === '1';
      if (!migrated) {
        var local = loadEx(), merged = Object.assign({}, shared), changed = false;
        Object.keys(local).forEach(function (k) { if (!merged[k]) { merged[k] = local[k]; changed = true; } });
        saveEx(merged);
        if (changed) pushShared(merged);
        try { localStorage.setItem(MIG, '1'); } catch (e) {}
      } else { saveEx(shared); }
      trimDbCamp();
      persistAndRender();
    });
  }
  var tries = 0;
  var iv = setInterval(function () { tries++; if ((document.getElementById('tab-camp-t') && typeof DB !== 'undefined') || tries > 80) { clearInterval(iv); init(); } }, 400);

  window.PTEXCL = { render: renderCampsNew, openDrawer: openDrawer, add: addExclusions, restore: restore, setMode: setMode, ui: UI };
})();
