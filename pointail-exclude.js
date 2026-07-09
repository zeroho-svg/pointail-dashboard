/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 캠페인 수동 제외 모듈 (공용 저장소 동기화판)
 *  "신청은 됐지만 사용하지 않은" 캠페인을 번호로 제외 → 모든 집계(매출/영업성과 등)에서 빠짐.
 *  제외 목록은 Cloudflare Worker(KV)에 공유 저장 → 여러 컴퓨터에서 누적·공유.
 *  캠페인DB(tab-camp-t) 탭 상단에 "🚫 캠페인 수동 제외" 패널을 주입한다.
 * ──────────────────────────────────────────────────────────── */
(function () {
  var LS = 'pt_excluded_camps';                 // 로컬 캐시 { "<no>": {..., _full} }
  var MIG = 'pt_excl_migrated';                 // 로컬 제외를 공용으로 1회 병합했는지 플래그
  var WORKER = 'https://pointail-api.zeroho.workers.dev';

  function loadEx() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
  function saveEx(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) {} }
  function isEx(no) { return Object.prototype.hasOwnProperty.call(loadEx(), String(no)); }
  function noOf(c) { return String((c && (c.campaignNo != null ? c.campaignNo : c.campaignNoText)) || '').trim(); }
  function numify(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s]/g, '')) || 0; }
  function fmt(v) { return numify(v).toLocaleString('ko-KR'); }
  function snap(c) {
    return {
      no: noOf(c), title: c.campaignTitle || '', campaignType: c.campaignType || '',
      advertiserCountry: c.advertiserCountry || '', contractFinal: c.contractFinal || '0',
      salesManager: c.salesManager || '', marketingType: c.marketingType || '', createdAt: c.createdAt || '',
      _full: c
    };
  }

  // ── 공용 저장소(Worker KV) ──
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

  // ── 제외 추가(번호 배열): 공용 저장소 read-modify-write ──
  function addExclusions(nums) {
    var byNo = {}; (typeof DB !== 'undefined' && DB.camp ? DB.camp : []).forEach(function (c) { byNo[noOf(c)] = c; });
    var toAdd = {}, added = 0, notFound = [];
    nums.forEach(function (n) {
      n = String(n).trim(); if (!n) return;
      if (byNo[n]) { toAdd[n] = snap(byNo[n]); added++; }
      else { toAdd[n] = { no: n, title: '(현재 목록에 없음 · 동기화 후 확인)', contractFinal: '0' }; added++; notFound.push(n); }
    });
    if (!added) return;
    pullShared(function (shared) {
      var merged = Object.assign({}, shared || loadEx());
      for (var k in toAdd) merged[k] = toAdd[k];
      saveEx(merged); pushShared(merged);
      if (typeof DB !== 'undefined' && DB.camp) DB.camp = DB.camp.filter(function (c) { return !merged[noOf(c)]; });
      persistAndRender();
      alert('✅ 제외 추가: ' + added + '건 (모든 컴퓨터에 공유 저장됨)' +
        (notFound.length ? '\n※ 현재 목록에 없는 번호: ' + notFound.join(', ') + ' — 동기화 후 반영됩니다.' : ''));
    });
  }

  // ── 복원 ──
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
      persistAndRender();
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
      persistAndRender();
    });
  }

  function persistAndRender() {
    try { if (typeof saveState === 'function') saveState(); } catch (e) {}
    try { if (typeof renderAll === 'function') renderAll(); } catch (e) {}
    ensurePanel();
  }

  // ── UI 패널 ──
  function panelHTML() {
    return (
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">🚫 캠페인 수동 제외 <span style="font-weight:400;color:#888;font-size:12px">(신청만 하고 미사용 · 모든 집계에서 제외 · 모든 컴퓨터 공유)</span></div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">' +
        '<div style="flex:1;min-width:240px">' +
          '<div style="font-size:12px;color:#555;margin-bottom:4px">캠페인 번호로 제외 (여러 개는 쉼표/공백/줄바꿈)</div>' +
          '<div style="display:flex;gap:6px"><textarea id="pt-ex-input" rows="1" placeholder="예: 102683, 102540" style="flex:1;min-height:32px;padding:6px 8px;border:1px solid #ccc;border-radius:6px;resize:vertical;font-size:13px"></textarea>' +
          '<button id="pt-ex-add" class="btn btn-sm" style="white-space:nowrap">제외 추가</button></div>' +
          '<div style="font-size:12px;color:#555;margin:10px 0 4px">목록에서 검색해 제외 (번호/제목/스토어명/법인명/영업·운영담당자)</div>' +
          '<input id="pt-ex-search" placeholder="검색어 입력" style="width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px" />' +
          '<div id="pt-ex-results" style="margin-top:6px;max-height:180px;overflow:auto"></div>' +
        '</div>' +
        '<div style="flex:1.3;min-width:300px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
            '<div style="font-size:12px;color:#555" id="pt-ex-summary">제외된 캠페인</div>' +
            '<button id="pt-ex-restore-all" class="btn btn-sm" style="font-size:11px">전체 복원</button>' +
          '</div>' +
          '<div id="pt-ex-list" style="max-height:260px;overflow:auto;border:1px solid #eee;border-radius:6px"></div>' +
        '</div>' +
      '</div>'
    );
  }

  function ensurePanel() {
    var host = document.getElementById('tab-camp-t');
    if (!host) return;
    var panel = document.getElementById('pt-exclude-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'pt-exclude-panel';
      panel.className = 'card';
      panel.style.cssText = 'margin:10px 0;padding:14px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa';
      panel.innerHTML = panelHTML();
      if (host.children.length > 1) host.insertBefore(panel, host.children[1]);
      else host.appendChild(panel);
      wireEvents(panel);
    }
    renderResults();
    renderExList();
  }

  function wireEvents(panel) {
    var addBtn = panel.querySelector('#pt-ex-add');
    var input = panel.querySelector('#pt-ex-input');
    addBtn.addEventListener('click', function () {
      var nums = (input.value || '').split(/[\s,]+/).filter(Boolean);
      if (!nums.length) return;
      addBtn.disabled = true; addBtn.textContent = '저장 중...';
      addExclusions(nums);
      input.value = '';
      setTimeout(function () { addBtn.disabled = false; addBtn.textContent = '제외 추가'; }, 1200);
    });
    var search = panel.querySelector('#pt-ex-search');
    search.addEventListener('input', function () { renderResults(); });
    panel.querySelector('#pt-ex-restore-all').addEventListener('click', function () {
      var ex = loadEx(); var n = Object.keys(ex).length;
      if (!n) return;
      if (confirm('제외된 ' + n + '건을 모두 복원할까요? (모든 컴퓨터 공유)')) restoreAll();
    });
  }

  function renderResults() {
    var box = document.getElementById('pt-ex-results'); if (!box) return;
    var q = (document.getElementById('pt-ex-search') || {}).value || '';
    q = q.trim().toLowerCase();
    if (!q) { box.innerHTML = '<div style="font-size:12px;color:#aaa;padding:4px">검색어를 입력하면 캠페인이 표시됩니다.</div>'; return; }
    var rows = (typeof DB !== 'undefined' && DB.camp ? DB.camp : []).filter(function (c) {
      var hay = (noOf(c) + ' ' + (c.campaignTitle || '') + ' ' + (c.storeName || '') + ' ' +
        (c.corpName || '') + ' ' + (c.salesManager || '') + ' ' + (c.opManager || '')).toLowerCase();
      return hay.indexOf(q) > -1;
    }).slice(0, 40);
    if (!rows.length) { box.innerHTML = '<div style="font-size:12px;color:#aaa;padding:4px">일치하는 캠페인이 없습니다.</div>'; return; }
    box.innerHTML = rows.map(function (c) {
      var no = noOf(c);
      var meta = [c.storeName, c.corpName, c.salesManager ? '영업 ' + c.salesManager : '', c.opManager ? '운영 ' + c.opManager : '']
        .filter(Boolean).join(' · ');
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 6px;border-bottom:1px solid #f0f0f0;font-size:12px">' +
        '<span style="flex:1;overflow:hidden"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>' + no + '</b> ' + esc(c.campaignTitle || '') + '</div>' +
        (meta ? '<div style="color:#999;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(meta) + '</div>' : '') + '</span>' +
        '<button class="btn btn-sm pt-ex-pick" data-no="' + no + '" style="font-size:11px;padding:2px 8px">제외</button></div>';
    }).join('');
    [].slice.call(box.querySelectorAll('.pt-ex-pick')).forEach(function (b) {
      b.addEventListener('click', function () { addExclusions([b.getAttribute('data-no')]); });
    });
  }

  function renderExList() {
    var list = document.getElementById('pt-ex-list'); if (!list) return;
    var ex = loadEx(); var keys = Object.keys(ex);
    var sum = keys.reduce(function (a, k) { return a + numify(ex[k].contractFinal); }, 0);
    var sumEl = document.getElementById('pt-ex-summary');
    if (sumEl) sumEl.innerHTML = '제외된 캠페인 <b>' + keys.length + '건</b> · 제외 계약매출 <b>' + fmt(sum) + '원</b> <span style="color:#aaa">· 공유</span>';
    if (!keys.length) { list.innerHTML = '<div style="font-size:12px;color:#aaa;padding:10px">제외된 캠페인이 없습니다.</div>'; return; }
    keys.sort(function (a, b) { return numify(b) - numify(a); });
    list.innerHTML =
      '<div style="display:flex;font-size:11px;color:#888;padding:4px 8px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff">' +
        '<span style="width:64px">번호</span><span style="flex:1">제목</span><span style="width:56px;text-align:center">유형</span><span style="width:90px;text-align:right">계약매출</span><span style="width:52px"></span></div>' +
      keys.map(function (no) {
        var r = ex[no];
        return '<div style="display:flex;align-items:center;font-size:12px;padding:5px 8px;border-bottom:1px solid #f4f4f4">' +
          '<span style="width:64px"><b>' + no + '</b></span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.title || '') + '</span>' +
          '<span style="width:56px;text-align:center;color:#666">' + esc(r.campaignType || '') + '</span>' +
          '<span style="width:90px;text-align:right">' + fmt(r.contractFinal) + '</span>' +
          '<span style="width:52px;text-align:right"><button class="btn btn-sm pt-ex-restore" data-no="' + no + '" style="font-size:11px;padding:2px 8px">복원</button></span></div>';
      }).join('');
    [].slice.call(list.querySelectorAll('.pt-ex-restore')).forEach(function (b) {
      b.addEventListener('click', function () { restore(b.getAttribute('data-no')); });
    });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }

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
        // 이 기기의 기존 로컬 제외를 공용에 누적(병합)
        var local = loadEx(), merged = Object.assign({}, shared), changed = false;
        Object.keys(local).forEach(function (k) { if (!merged[k]) { merged[k] = local[k]; changed = true; } });
        saveEx(merged);
        if (changed) pushShared(merged);
        try { localStorage.setItem(MIG, '1'); } catch (e) {}
      } else {
        // 이후엔 공용 저장소를 원본으로 사용(다른 컴퓨터의 추가/복원 반영)
        saveEx(shared);
      }
      trimDbCamp();
      persistAndRender();
    });
  }
  var tries = 0;
  var iv = setInterval(function () { tries++; if ((document.getElementById('tab-camp-t') && typeof DB !== 'undefined') || tries > 80) { clearInterval(iv); init(); } }, 400);
})();
