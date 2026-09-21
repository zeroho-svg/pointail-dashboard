/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 캠페인 수동 제외 모듈  v2 (2026-09-21)
 *  "신청은 됐지만 사용하지 않은" 캠페인을 제외 → 모든 집계(매출/영업성과 등)에서 빠짐.
 *  제외 목록은 Cloudflare Worker(KV)에 공유 저장 → 여러 컴퓨터에서 누적·공유.
 *
 *  [v2 UX 개편] 기존에는 ①위쪽 제외 패널에서 검색 → ②아래 2,060행 표를 따로 스크롤
 *  → ③번호를 눈으로 옮겨 적는 3단계였다. 이를 하나의 작업대로 합쳤다.
 *    ① 상단 고정(sticky) 제외 요약 바 — 스크롤 중에도 현황이 보이고 되돌아갈 필요 없음
 *    ② 제외 후보 빠른 찾기 칩(선정 0명 / 등록 대기 30일+ / 일시 중지 / 종료·미션 0 / 계약매출 0원)
 *    ③ 패널 자체 표에서 행 hover → 🚫 제외, 체크박스 다중 선택(Shift 구간 선택)
 *    ④ 하단 고정 액션바 — 선택 건수와 "제외되는 계약매출 합계"를 먼저 보여준 뒤 실행
 *    ⑤ 제외 목록은 우측 드로어(검색·정렬·복원·CSV, 오늘/이전 그룹)
 *    ⑥ 제외 직후 되돌리기 토스트(8초)
 *  원본 캠페인DB 표는 건드리지 않는다(주입형 원칙). 패널 표는 필터된 것만 100행씩 렌더.
 * ──────────────────────────────────────────────────────────── */
(function () {
  var LS = 'pt_excluded_camps';                 // 로컬 캐시 { "<no>": {..., _full} }
  var MIG = 'pt_excl_migrated';                 // 로컬 제외를 공용으로 1회 병합했는지 플래그
  var WORKER = 'https://pointail-api.zeroho.workers.dev';
  var PAGE = 100;

  function loadEx() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
  function saveEx(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} }
  function isEx(no) { return Object.prototype.hasOwnProperty.call(loadEx(), String(no)); }
  function noOf(c) { return String((c && (c.campaignNo != null ? c.campaignNo : c.campaignNoText)) || '').trim(); }
  function numify(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s]/g, '')) || 0; }
  function fmt(v) { return numify(v).toLocaleString('ko-KR'); }
  function eok(v) { var n = numify(v); return n >= 1e8 ? (n / 1e8).toFixed(2) + '억' : Math.round(n / 1e4).toLocaleString('ko-KR') + '만'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function camps() { return (typeof DB !== 'undefined' && DB.camp) ? DB.camp : []; }
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
  function ymOf(c) { return String(c.createdAt || '').slice(0, 7); }
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
  var UI = { q: '', st: '', rep: '', ym: '', preset: '', showEx: false, limit: PAGE, sel: {}, lastIdx: null, lastEx: null, viewRows: [] };

  /* ══════════ 제외 후보 프리셋 ══════════ */
  var PRESETS = [
    { k: 'zero', label: '🚫 선정 0명', tip: '모집했지만 선정 인원이 0명 (취소·대기 제외)', test: function (c) { return numify(c.selectedCount) === 0 && c.campaignStatus !== '등록 대기'; } },
    { k: 'wait', label: '⏳ 등록 대기 30일+', tip: '등록 대기 상태로 30일 이상 방치', test: function (c) { return c.campaignStatus === '등록 대기' && ageDays(c) >= 30; } },
    { k: 'pause', label: '⏸ 일시 중지', tip: '일시 중지 상태', test: function (c) { return c.campaignStatus === '일시 중지'; } },
    { k: 'nomsn', label: '💤 종료·미션 0', tip: '캠페인이 종료됐는데 미션 완료 인원이 0명', test: function (c) { return c.campaignStatus === '캠페인 종료' && numify(c.missionDoneCount) === 0; } },
    { k: 'amt0', label: '💰 계약매출 0원', tip: '계약 매출이 0원 (집계에 잡히지 않는 건)', test: function (c) { return numify(c.contractFinal) === 0; } }
  ];
  function testPreset(c) { if (!UI.preset) return true; for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].k === UI.preset) return PRESETS[i].test(c); return true; }

  /* ══════════ 스타일 ══════════ */
  function ensureStyle() {
    if (document.getElementById('ptx-style')) return;
    var st = document.createElement('style'); st.id = 'ptx-style';
    st.textContent = [
      '.ptx{--l:#e5e7eb;--m:#8a94a6;--i:#111827;--i2:#48505c;--b:#2563eb;--r:#c0392b;font-size:13px;color:var(--i)}',
      '.ptx *{box-sizing:border-box}',
      '.ptx .bar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:11px;flex-wrap:wrap;background:#fff;border:1px solid var(--l);border-radius:11px;padding:10px 13px;box-shadow:0 2px 10px rgba(16,24,40,.07);margin-bottom:10px}',
      '.ptx .bar .tag{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13.5px}',
      '.ptx .bar .dot{width:8px;height:8px;border-radius:50%;background:var(--r)}',
      '.ptx .bar .m{font-size:12.5px;color:var(--i2)} .ptx .bar .m b{color:var(--i)}',
      '.ptx .sp{flex:1}',
      '.ptx .xb{border:1px solid var(--l);background:#fff;border-radius:9px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:600;color:var(--i2);cursor:pointer;white-space:nowrap}',
      '.ptx .xb:hover{border-color:var(--b);color:var(--b)}',
      '.ptx .xb.pri{background:var(--i);border-color:var(--i);color:#fff} .ptx .xb.pri:hover{background:#000;color:#fff}',
      '.ptx .xb.dngr{background:#fef2f2;border-color:#fecaca;color:var(--r)}',
      '.ptx .xb.s{padding:3px 8px;font-size:11.5px;border-radius:7px}',
      '.ptx .filt{background:#fff;border:1px solid var(--l);border-radius:11px;padding:11px 13px;margin-bottom:10px}',
      '.ptx .frow{display:flex;gap:7px;flex-wrap:wrap;align-items:center}',
      '.ptx .frow input[type=text],.ptx .frow select{border:1px solid var(--l);border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;color:var(--i);background:#fff}',
      /* index.html 전역 CSS가 select/input을 display:block;width:100% 로 강제하므로 덮어쓴다 */
      '.ptx .frow input[type=text]{flex:1 1 240px;min-width:200px;width:auto!important;display:block}',
      '.ptx .frow select{flex:0 0 auto;width:auto!important;min-width:128px;max-width:210px;display:inline-block!important;height:auto!important}',
      '.ptx .frow .xb{flex:0 0 auto}',
      '.ptx .chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:9px;padding-top:9px;border-top:1px dashed var(--l)}',
      '.ptx .chips .lb{font-size:11.5px;color:var(--m);font-weight:700;margin-right:2px}',
      '.ptx .chip{border:1px solid var(--l);background:#fff;border-radius:20px;padding:4px 11px;font-size:12px;font-weight:600;color:var(--i2);cursor:pointer}',
      '.ptx .chip:hover{border-color:var(--b);color:var(--b)}',
      '.ptx .chip.on{background:#eaf1fe;border-color:var(--b);color:var(--b)}',
      '.ptx .chip .n{font-size:11px;color:var(--m);margin-left:4px} .ptx .chip.on .n{color:var(--b)}',
      '.ptx .sw{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--i2);margin-left:auto;cursor:pointer;user-select:none}',
      '.ptx .sw input{width:15px;height:15px;accent-color:var(--b)}',
      '.ptx .tw{background:#fff;border:1px solid var(--l);border-radius:11px;overflow:hidden}',
      '.ptx .hint{padding:8px 12px;font-size:11.5px;color:var(--m);border-bottom:1px solid var(--l);background:#fcfdff}',
      '.ptx .sc{overflow:auto;max-height:520px}',
      '.ptx table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.ptx thead th{position:sticky;top:0;z-index:5;background:#f8fafc;border-bottom:1px solid var(--l);padding:8px 9px;text-align:left;font-size:11.5px;color:var(--i2);font-weight:700;white-space:nowrap}',
      '.ptx tbody td{border-bottom:1px solid #f1f3f6;padding:7px 9px;vertical-align:middle;white-space:nowrap}',
      '.ptx tbody tr:hover{background:#f8fbff}',
      '.ptx tbody tr.exd{background:#fafafa;color:#a6adba} .ptx tbody tr.exd .tt{text-decoration:line-through}',
      '.ptx tbody tr.sel{background:#eef5ff}',
      '.ptx td.c{text-align:center} .ptx td.r{text-align:right;font-variant-numeric:tabular-nums}',
      '.ptx .no{font-weight:700;font-variant-numeric:tabular-nums}',
      '.ptx .tt{max-width:290px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}',
      '.ptx .mu{font-size:11px;color:var(--m)}',
      '.ptx input.ck{width:15px;height:15px;accent-color:var(--b);cursor:pointer}',
      '.ptx .bd{display:inline-block;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:700;white-space:nowrap}',
      '.ptx .bd.w{background:#fff7ed;color:#b45309} .ptx .bd.g{background:#eaf1fe;color:var(--b)} .ptx .bd.d{background:#eef1f5;color:var(--i2)} .ptx .bd.x{background:#fef2f2;color:var(--r)}',
      '.ptx .rb{opacity:0;transition:opacity .12s} .ptx tbody tr:hover .rb,.ptx tbody tr.exd .rb{opacity:1}',
      '.ptx .more{padding:10px;text-align:center;border-top:1px solid var(--l);background:#fcfdff}',
      /* 하단 고정 액션바 */
      '#ptx-selbar{position:fixed;left:0;right:0;bottom:0;z-index:9998;transform:translateY(130%);transition:transform .18s ease;background:#111827;color:#fff;box-shadow:0 -6px 24px rgba(16,24,40,.24);font-family:inherit}',
      '#ptx-selbar.on{transform:none}',
      '#ptx-selbar .in{max-width:1560px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;gap:13px;flex-wrap:wrap}',
      '#ptx-selbar .cnt{font-weight:800;font-size:15px} #ptx-selbar .meta{font-size:12.5px;color:#c7cdd8}',
      '#ptx-selbar button{border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);color:#fff;border-radius:9px;padding:7px 13px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}',
      '#ptx-selbar button:hover{background:rgba(255,255,255,.18);border-color:#fff}',
      '#ptx-selbar button.go{background:#dc2626;border-color:#dc2626} #ptx-selbar button.go:hover{background:#b91c1c}',
      /* 드로어 */
      '#ptx-mask{position:fixed;inset:0;background:rgba(16,24,40,.35);z-index:9998;display:none} #ptx-mask.on{display:block}',
      '#ptx-drw{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:94vw;background:#fff;z-index:9999;box-shadow:-8px 0 30px rgba(16,24,40,.2);transform:translateX(100%);transition:transform .2s ease;display:flex;flex-direction:column;font-size:13px;color:#111827}',
      '#ptx-drw.on{transform:none}',
      '#ptx-drw .hd{padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px} #ptx-drw .hd h3{margin:0;font-size:15.5px}',
      '#ptx-drw .tl{padding:10px 18px;border-bottom:1px solid #e5e7eb;display:flex;gap:7px;flex-wrap:wrap;align-items:center}',
      '#ptx-drw .tl input,#ptx-drw .tl select{border:1px solid #e5e7eb;border-radius:8px;padding:6px 9px;font:inherit;font-size:12.5px;height:auto!important}',
      /* 전역 CSS(display:block;width:100%) 덮어쓰기 — 드로어 도구 줄이 세로로 쌓이는 것 방지 */
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

  /* ══════════ 패널 ══════════ */
  function panelShell() {
    return '' +
      '<div class="bar">' +
        '<span class="tag"><span class="dot"></span> 🚫 캠페인 수동 제외</span>' +
        '<span class="m">제외 <b id="ptx-n">0</b>건 · 제외 계약매출 <b id="ptx-sum">0</b></span>' +
        '<span class="m mu">신청만 하고 미사용 · 모든 집계에서 제외 · 전 컴퓨터 공유</span>' +
        '<span class="sp"></span>' +
        '<button class="xb" id="ptx-num">⌨ 번호로 추가</button>' +
        '<button class="xb pri" id="ptx-open">📋 제외 목록 열기</button>' +
      '</div>' +
      '<div class="filt">' +
        '<div class="frow">' +
          '<input type="text" id="ptx-q" placeholder="🔎 번호 · 캠페인명 · 스토어명 · 법인명 · 담당자 검색">' +
          '<select id="ptx-st"></select><select id="ptx-rep"></select><select id="ptx-ym"></select>' +
          '<button class="xb" id="ptx-reset">필터 초기화</button>' +
        '</div>' +
        '<div class="chips" id="ptx-chips"></div>' +
      '</div>' +
      '<div class="tw"><div class="hint" id="ptx-hint"></div><div class="sc"><table>' +
        '<thead><tr>' +
          '<th style="width:34px"><input type="checkbox" class="ck" id="ptx-all"></th>' +
          '<th style="width:76px">번호</th><th style="width:88px">상태</th><th>캠페인 제목</th>' +
          '<th style="width:104px">스토어명</th><th style="width:116px">법인명</th>' +
          '<th style="width:70px" class="c">선정/모집</th><th style="width:52px" class="c">미션</th>' +
          '<th style="width:74px">담당자</th><th style="width:88px" class="r">계약매출</th>' +
          '<th style="width:82px">생성일</th><th style="width:70px"></th>' +
        '</tr></thead><tbody id="ptx-tb"></tbody></table></div><div id="ptx-more"></div></div>' +
      '<div class="mu" style="margin-top:7px">💡 행에 마우스를 올리면 오른쪽에 <b>🚫 제외</b> 버튼이 나타납니다. 여러 건은 체크박스로 고른 뒤 화면 아래 바에서 한 번에 처리합니다(Shift+클릭 = 구간 선택). 아래 원본 캠페인DB 표는 그대로 있습니다.</div>';
  }

  function ensureGlobals() {
    if (!document.getElementById('ptx-selbar')) {
      var b = document.createElement('div'); b.id = 'ptx-selbar';
      b.innerHTML = '<div class="in"><span class="cnt" id="ptx-selcnt">0건 선택</span>' +
        '<span class="meta" id="ptx-selmeta"></span><span style="flex:1"></span>' +
        '<button id="ptx-clear">선택 해제</button><button class="go" id="ptx-go">🚫 선택한 건 제외</button></div>';
      document.body.appendChild(b);
      b.querySelector('#ptx-clear').addEventListener('click', function () { UI.sel = {}; renderTable(); });
      b.querySelector('#ptx-go').addEventListener('click', doExcludeSelected);
    }
    if (!document.getElementById('ptx-mask')) {
      var m = document.createElement('div'); m.id = 'ptx-mask'; document.body.appendChild(m);
      m.addEventListener('click', closeDrawer);
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
    }
    if (!document.getElementById('ptx-toast')) {
      var t = document.createElement('div'); t.id = 'ptx-toast';
      t.innerHTML = '<span id="ptx-tmsg"></span><button id="ptx-undo">되돌리기</button>';
      document.body.appendChild(t);
      t.querySelector('#ptx-undo').addEventListener('click', undo);
    }
  }

  function ensurePanel() {
    var host = document.getElementById('tab-camp-t');
    if (!host) return;
    ensureStyle(); ensureGlobals();
    var panel = document.getElementById('pt-exclude-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'pt-exclude-panel'; panel.className = 'ptx';
      panel.style.cssText = 'margin:10px 0 16px';
      panel.innerHTML = panelShell();
      if (host.children.length > 1) host.insertBefore(panel, host.children[1]); else host.appendChild(panel);
      wire(panel);
      fillSelects();
    }
    renderChips(); renderTable(); updateSummary();
  }

  function wire(p) {
    p.querySelector('#ptx-q').addEventListener('input', function () { UI.q = this.value; UI.limit = PAGE; renderTable(); });
    ['st', 'rep', 'ym'].forEach(function (k) {
      p.querySelector('#ptx-' + k).addEventListener('change', function () { UI[k] = this.value; UI.limit = PAGE; renderTable(); });
    });
    p.querySelector('#ptx-reset').addEventListener('click', function () {
      UI.q = ''; UI.st = ''; UI.rep = ''; UI.ym = ''; UI.preset = ''; UI.limit = PAGE;
      p.querySelector('#ptx-q').value = ''; ['st', 'rep', 'ym'].forEach(function (k) { p.querySelector('#ptx-' + k).value = ''; });
      renderChips(); renderTable();
    });
    p.querySelector('#ptx-all').addEventListener('click', function () {
      if (this.checked) UI.viewRows.forEach(function (r) { if (!r.__ex) UI.sel[r.no] = true; }); else UI.sel = {};
      renderTable();
    });
    p.querySelector('#ptx-open').addEventListener('click', openDrawer);
    p.querySelector('#ptx-num').addEventListener('click', function () {
      var v = prompt('제외할 캠페인 번호 (쉼표·공백·줄바꿈으로 여러 개)\n예: 102683, 102540');
      if (!v) return;
      var nums = v.split(/[\s,]+/).filter(Boolean);
      if (nums.length) addExclusions(nums);
    });
    // 표 이벤트 위임
    p.querySelector('#ptx-tb').addEventListener('click', function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains('ptx-pick')) { pick(e, t.getAttribute('data-no'), +t.getAttribute('data-i')); return; }
      if (t.classList && t.classList.contains('ptx-one')) { addExclusions([t.getAttribute('data-no')]); return; }
      if (t.classList && t.classList.contains('ptx-res')) { restore(t.getAttribute('data-no')); return; }
    });
  }

  function fillSelects() {
    var p = document.getElementById('pt-exclude-panel'); if (!p) return;
    var rows = camps();
    var sts = {}, reps = {}, yms = {};
    rows.forEach(function (c) {
      if (c.campaignStatus) sts[c.campaignStatus] = (sts[c.campaignStatus] || 0) + 1;
      if (c.salesManager) reps[c.salesManager] = (reps[c.salesManager] || 0) + 1;
      var y = ymOf(c); if (/^\d{4}-\d{2}$/.test(y)) yms[y] = (yms[y] || 0) + 1;
    });
    function opts(o, all, sortByCount) {
      var ks = Object.keys(o);
      if (sortByCount) ks.sort(function (a, b) { return o[b] - o[a]; }); else ks.sort().reverse();
      return '<option value="">' + all + '</option>' + ks.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + ' (' + o[k] + ')</option>'; }).join('');
    }
    p.querySelector('#ptx-st').innerHTML = opts(sts, '전체 상태', true);
    p.querySelector('#ptx-rep').innerHTML = opts(reps, '전체 담당자', true);
    p.querySelector('#ptx-ym').innerHTML = opts(yms, '전체 기간', false);
    p.querySelector('#ptx-st').value = UI.st; p.querySelector('#ptx-rep').value = UI.rep; p.querySelector('#ptx-ym').value = UI.ym;
  }

  function renderChips() {
    var box = document.getElementById('ptx-chips'); if (!box) return;
    var rows = camps();
    var h = '<span class="lb">제외 후보 빠른 찾기</span>';
    PRESETS.forEach(function (ps) {
      var n = rows.filter(ps.test).length;
      h += '<span class="chip' + (UI.preset === ps.k ? ' on' : '') + '" data-p="' + ps.k + '" title="' + esc(ps.tip) + '">' + ps.label + ' <span class="n">' + n + '건</span></span>';
    });
    h += '<label class="sw"><input type="checkbox" id="ptx-showex"' + (UI.showEx ? ' checked' : '') + '> 제외된 건도 함께 보기</label>';
    box.innerHTML = h;
    [].slice.call(box.querySelectorAll('.chip')).forEach(function (c) {
      c.addEventListener('click', function () {
        var k = c.getAttribute('data-p'); UI.preset = (UI.preset === k ? '' : k); UI.limit = PAGE; renderChips(); renderTable();
      });
    });
    box.querySelector('#ptx-showex').addEventListener('change', function () { UI.showEx = this.checked; UI.limit = PAGE; renderTable(); });
  }

  /* 표에 그릴 행 목록: 현재 DB.camp(제외된 건은 이미 빠져 있음) + (옵션) 제외 기록 */
  function viewRows() {
    var q = (UI.q || '').trim().toLowerCase();
    var out = camps().filter(function (c) {
      if (UI.st && c.campaignStatus !== UI.st) return false;
      if (UI.rep && c.salesManager !== UI.rep) return false;
      if (UI.ym && ymOf(c) !== UI.ym) return false;
      if (!testPreset(c)) return false;
      if (q) {
        var hay = (noOf(c) + ' ' + (c.campaignTitle || '') + ' ' + (c.storeName || '') + ' ' +
          (c.corpName || '') + ' ' + (c.salesManager || '') + ' ' + (c.opManager || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).map(function (c) {
      return { no: noOf(c), st: c.campaignStatus || '', title: c.campaignTitle || '', store: c.storeName || '', corp: c.corpName || '',
        sel: numify(c.selectedCount), mo: numify(c.recruitCount), msn: numify(c.missionDoneCount),
        rep: c.salesManager || '', amt: numify(c.contractFinal), day: d10(c), __ex: false };
    });
    if (UI.showEx) {
      var ex = loadEx();
      Object.keys(ex).forEach(function (no) {
        var r = ex[no], fu = r._full || {};
        var row = { no: no, st: r.campaignStatus || fu.campaignStatus || '', title: r.title || '', store: r.storeName || fu.storeName || '',
          corp: r.corpName || fu.corpName || '', sel: numify(fu.selectedCount), mo: numify(fu.recruitCount), msn: numify(fu.missionDoneCount),
          rep: r.salesManager || '', amt: numify(r.contractFinal), day: String(r.createdAt || '').slice(0, 10), __ex: true };
        if (UI.rep && row.rep !== UI.rep) return;
        if (UI.ym && row.day.slice(0, 7) !== UI.ym) return;
        if (q) { var hay = (row.no + ' ' + row.title + ' ' + row.store + ' ' + row.corp + ' ' + row.rep).toLowerCase(); if (hay.indexOf(q) < 0) return; }
        out.push(row);
      });
    }
    out.sort(function (a, b) { return numify(b.no) - numify(a.no); });
    return out;
  }

  function bcls(s) { return s === '등록 대기' ? 'w' : (s === '모집중' || s === '추가 모집중') ? 'g' : 'd'; }
  function slab(s) { return String(s || '').replace('캠페인 ', ''); }

  function renderTable() {
    var tb = document.getElementById('ptx-tb'); if (!tb) return;
    var rows = viewRows(); UI.viewRows = rows;
    var shown = rows.slice(0, UI.limit);
    var psLabel = ''; PRESETS.forEach(function (p) { if (p.k === UI.preset) psLabel = p.label; });
    document.getElementById('ptx-hint').innerHTML =
      '조회 <b>' + fmt(rows.length) + '</b>건 / 전체 ' + fmt(camps().length) + '건' +
      (psLabel ? ' · <span style="color:#2563eb;font-weight:700">' + esc(psLabel) + ' 필터 적용 중</span>' : '') +
      ' · 제외된 건은 ' + (UI.showEx ? '회색 취소선으로 함께 표시' : '표에서 숨김') +
      (rows.length > shown.length ? ' · 아래 ' + fmt(shown.length) + '건 표시' : '');

    tb.innerHTML = shown.map(function (r, i) {
      var s = !!UI.sel[r.no];
      return '<tr class="' + (r.__ex ? 'exd' : '') + (s ? ' sel' : '') + '">' +
        '<td>' + (r.__ex ? '' : '<input type="checkbox" class="ck ptx-pick" data-no="' + r.no + '" data-i="' + i + '"' + (s ? ' checked' : '') + '>') + '</td>' +
        '<td class="no">' + esc(r.no) + '</td>' +
        '<td>' + (r.__ex ? '<span class="bd x">제외됨</span>' : '<span class="bd ' + bcls(r.st) + '">' + esc(slab(r.st)) + '</span>') + '</td>' +
        '<td><span class="tt">' + esc(r.title) + '</span></td>' +
        '<td><span class="tt" style="max-width:100px">' + esc(r.store) + '</span></td>' +
        '<td><span class="tt" style="max-width:112px">' + esc(r.corp) + '</span></td>' +
        '<td class="c">' + (r.mo ? r.sel + '/' + r.mo : '—') + '</td>' +
        '<td class="c">' + (r.__ex && !r.mo ? '—' : r.msn) + '</td>' +
        '<td>' + esc(r.rep) + '</td>' +
        '<td class="r">' + fmt(r.amt) + '</td>' +
        '<td class="mu">' + esc(r.day) + '</td>' +
        '<td class="c">' + (r.__ex
          ? '<button class="xb s rb ptx-res" data-no="' + r.no + '">복원</button>'
          : '<button class="xb s dngr rb ptx-one" data-no="' + r.no + '">🚫 제외</button>') + '</td></tr>';
    }).join('') || '<tr><td colspan="12" style="padding:24px;text-align:center;color:#8a94a6">조건에 맞는 캠페인이 없습니다.</td></tr>';

    var more = document.getElementById('ptx-more');
    if (rows.length > shown.length) {
      more.className = 'more';
      more.innerHTML = '<button class="xb" id="ptx-more-b">▼ 더 보기 (' + fmt(rows.length - shown.length) + '건 남음)</button>';
      more.querySelector('#ptx-more-b').addEventListener('click', function () { UI.limit += PAGE; renderTable(); });
    } else { more.className = ''; more.innerHTML = ''; }
    syncBar();
  }

  function pick(e, no, i) {
    if (e.shiftKey && UI.lastIdx !== null) {
      var a = Math.min(UI.lastIdx, i), b = Math.max(UI.lastIdx, i);
      for (var k = a; k <= b; k++) { var r = UI.viewRows[k]; if (r && !r.__ex) UI.sel[r.no] = true; }
    } else { if (UI.sel[no]) delete UI.sel[no]; else UI.sel[no] = true; }
    UI.lastIdx = i; renderTable();
  }

  function syncBar() {
    var ks = Object.keys(UI.sel), n = ks.length;
    var byNo = {}; camps().forEach(function (c) { byNo[noOf(c)] = c; });
    var sum = ks.reduce(function (a, k) { return a + numify(byNo[k] && byNo[k].contractFinal); }, 0);
    var cnt = document.getElementById('ptx-selcnt'); if (!cnt) return;
    cnt.textContent = n + '건 선택';
    document.getElementById('ptx-selmeta').textContent = n ? '계약매출 합계 ' + fmt(sum) + '원 — 제외하면 모든 집계에서 빠집니다' : '';
    document.getElementById('ptx-selbar').classList.toggle('on', n > 0);
    var all = document.getElementById('ptx-all');
    if (all) { var sels = UI.viewRows.filter(function (r) { return !r.__ex; }); all.checked = sels.length > 0 && sels.every(function (r) { return UI.sel[r.no]; }); }
  }

  function updateSummary() {
    var ex = loadEx(), ks = Object.keys(ex);
    var sum = ks.reduce(function (a, k) { return a + numify(ex[k].contractFinal); }, 0);
    var n = document.getElementById('ptx-n'); if (!n) return;
    n.textContent = fmt(ks.length);
    document.getElementById('ptx-sum').textContent = eok(sum);
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
  function doExcludeSelected() {
    var ks = Object.keys(UI.sel); if (!ks.length) return;
    addExclusions(ks);
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
    ensurePanel();
  }

  /* ══════════ 토스트 ══════════ */
  var ttmr;
  function toast(msg) {
    ensureGlobals();
    document.getElementById('ptx-tmsg').textContent = msg;
    var undoBtn = document.getElementById('ptx-undo');
    undoBtn.style.display = (UI.lastEx && UI.lastEx.length) ? '' : 'none';
    document.getElementById('ptx-toast').classList.add('on');
    clearTimeout(ttmr); ttmr = setTimeout(hideToast, 8000);
  }
  function hideToast() { var t = document.getElementById('ptx-toast'); if (t) t.classList.remove('on'); }

  /* ══════════ 드로어 ══════════ */
  function openDrawer() { ensureGlobals(); document.getElementById('ptx-drw').classList.add('on'); document.getElementById('ptx-mask').classList.add('on'); drawList(); }
  function closeDrawer() { var d = document.getElementById('ptx-drw'); if (!d) return; d.classList.remove('on'); document.getElementById('ptx-mask').classList.remove('on'); }
  function exArr() {
    var ex = loadEx();
    return Object.keys(ex).map(function (no) { var r = ex[no]; return { no: no, title: r.title || '', store: r.storeName || '', rep: r.salesManager || '', day: String(r.createdAt || '').slice(0, 10), amt: numify(r.contractFinal), at: r._at || 0 }; });
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
    [].slice.call(body.querySelectorAll('.ptx-dres')).forEach(function (b) {
      b.addEventListener('click', function () { restore(b.getAttribute('data-no')); });
    });
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

  /* ══════════ 탭 밖에서는 하단 바 숨김 ══════════ */
  setInterval(function () {
    var host = document.getElementById('tab-camp-t');
    var vis = host && host.offsetParent !== null;
    var bar = document.getElementById('ptx-selbar');
    if (bar && !vis) bar.classList.remove('on');
    if (!vis) hideToast();
  }, 700);

  // ── renderAll 래핑: 렌더 후 패널 유지/갱신 ──
  if (typeof window.renderAll === 'function' && !window.renderAll.__exWrapped) {
    var _ra = window.renderAll;
    window.renderAll = function () { var r = _ra.apply(this, arguments); try { ensurePanel(); } catch (e) {} return r; };
    window.renderAll.__exWrapped = true;
  }

  // ── 초기화: 공용 저장소 동기화(최초 1회 로컬 병합 → 이후 공용이 원본) ──
  function init() {
    pullShared(function (shared) {
      shared = shared || {};
      var migrated = localStorage.getItem(MIG) === '1';
      if (!migrated) {
        var local = loadEx(), merged = Object.assign({}, shared), changed = false;
        Object.keys(local).forEach(function (k) { if (!merged[k]) { merged[k] = local[k]; changed = true; } });
        saveEx(merged);
        if (changed) pushShared(merged);
        try { localStorage.setItem(MIG, '1'); } catch (e) {}
      } else {
        saveEx(shared);
      }
      trimDbCamp();
      persistAndRender();
    });
  }
  var tries = 0;
  var iv = setInterval(function () { tries++; if ((document.getElementById('tab-camp-t') && typeof DB !== 'undefined') || tries > 80) { clearInterval(iv); init(); } }, 400);

  window.PTEXCL = { render: ensurePanel, openDrawer: openDrawer, add: addExclusions, restore: restore };
})();
