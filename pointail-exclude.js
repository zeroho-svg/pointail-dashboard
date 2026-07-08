/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 캠페인 수동 제외 모듈
 *  "신청은 됐지만 사용하지 않은" 캠페인을 번호로 제외 → 모든 집계(매출/영업성과 등)에서 빠짐.
 *  제외분은 별도 목록에 모아 보여주고 복원 가능. 원본(pt_db)엔 영향 최소화, 제외분은 스냅샷 보관.
 *  캠페인DB(tab-camp-t) 탭 상단에 "🚫 캠페인 수동 제외" 패널을 주입한다.
 * ──────────────────────────────────────────────────────────── */
(function () {
  var LS = 'pt_excluded_camps';   // { "<no>": {no,title,campaignType,advertiserCountry,contractFinal,salesManager,marketingType,createdAt,_full} }

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

  // ── 1) shouldExcludeRow 패치: 동기화 시 제외 번호 자동 제거(모든 집계 반영) ──
  if (typeof window.shouldExcludeRow === 'function' && !window.shouldExcludeRow.__exPatched) {
    var _sxr = window.shouldExcludeRow;
    window.shouldExcludeRow = function (type, row) {
      if (type === 'camp') { var no = noOf(row); if (no && isEx(no)) return true; }
      return _sxr.apply(this, arguments);
    };
    window.shouldExcludeRow.__exPatched = true;
  }

  // ── 2) 현재 DB.camp에서 제외분 제거 + 스냅샷 최신화(로드/동기화 후) ──
  function trimDbCamp() {
    if (typeof DB === 'undefined' || !DB.camp) return false;
    var ex = loadEx(), changed = false, removed = false;
    DB.camp = DB.camp.filter(function (c) {
      var no = noOf(c);
      if (no && ex[no]) { ex[no] = snap(c); changed = true; removed = true; return false; }
      return true;
    });
    if (changed) saveEx(ex);
    return removed;
  }

  // ── 3) 제외 추가(번호 배열) ──
  function addExclusions(nums) {
    var ex = loadEx(), byNo = {};
    (typeof DB !== 'undefined' && DB.camp ? DB.camp : []).forEach(function (c) { byNo[noOf(c)] = c; });
    var added = 0, notFound = [];
    nums.forEach(function (n) {
      n = String(n).trim(); if (!n) return;
      if (byNo[n]) { ex[n] = snap(byNo[n]); added++; }
      else if (!ex[n]) { ex[n] = { no: n, title: '(현재 목록에 없음 · 동기화 후 확인)', contractFinal: '0' }; added++; notFound.push(n); }
    });
    saveEx(ex);
    if (typeof DB !== 'undefined' && DB.camp) DB.camp = DB.camp.filter(function (c) { return !ex[noOf(c)]; });
    persistAndRender();
    return { added: added, notFound: notFound };
  }

  // ── 4) 복원(번호) ──
  function restore(no) {
    no = String(no); var ex = loadEx(); var rec = ex[no]; delete ex[no]; saveEx(ex);
    if (rec && rec._full && typeof DB !== 'undefined') {
      DB.camp = DB.camp || [];
      if (!DB.camp.some(function (c) { return noOf(c) === no; })) DB.camp.push(rec._full);
    }
    persistAndRender();
  }
  function restoreAll() {
    var ex = loadEx();
    Object.keys(ex).forEach(function (no) {
      var rec = ex[no];
      if (rec && rec._full && typeof DB !== 'undefined') {
        DB.camp = DB.camp || [];
        if (!DB.camp.some(function (c) { return noOf(c) === no; })) DB.camp.push(rec._full);
      }
    });
    saveEx({});
    persistAndRender();
  }

  function persistAndRender() {
    try { if (typeof saveState === 'function') saveState(); } catch (e) {}
    try { if (typeof renderAll === 'function') renderAll(); } catch (e) {}
    ensurePanel();
  }

  // ── 5) UI 패널 ──
  function panelHTML() {
    return (
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">🚫 캠페인 수동 제외 <span style="font-weight:400;color:#888;font-size:12px">(신청만 하고 미사용 · 모든 집계에서 제외)</span></div>' +
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
      // 헤더(첫 자식) 다음에 삽입
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
      var r = addExclusions(nums);
      input.value = '';
      var msg = '제외 추가: ' + r.added + '건';
      if (r.notFound.length) msg += '\n(현재 목록에 없는 번호: ' + r.notFound.join(', ') + ' — 동기화하면 반영됩니다)';
      alert(msg);
    });
    var search = panel.querySelector('#pt-ex-search');
    search.addEventListener('input', function () { renderResults(); });
    panel.querySelector('#pt-ex-restore-all').addEventListener('click', function () {
      var ex = loadEx(); var n = Object.keys(ex).length;
      if (!n) return;
      if (confirm('제외된 ' + n + '건을 모두 복원할까요?')) restoreAll();
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
    if (sumEl) sumEl.innerHTML = '제외된 캠페인 <b>' + keys.length + '건</b> · 제외 계약매출 <b>' + fmt(sum) + '원</b>';
    if (!keys.length) { list.innerHTML = '<div style="font-size:12px;color:#aaa;padding:10px">제외된 캠페인이 없습니다.</div>'; return; }
    // 최신 제외가 위로(입력 순서 유지가 어려우니 번호 역순)
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

  // ── 6) renderAll 래핑: 렌더 후 패널 유지/갱신 ──
  if (typeof window.renderAll === 'function' && !window.renderAll.__exWrapped) {
    var _ra = window.renderAll;
    window.renderAll = function () { var r = _ra.apply(this, arguments); try { ensurePanel(); } catch (e) {} return r; };
    window.renderAll.__exWrapped = true;
  }

  // ── 7) 초기화: 로드 시 제외분 반영 ──
  function init() {
    var removed = trimDbCamp();
    if (removed) { try { if (typeof saveState === 'function') saveState(); } catch (e) {} try { if (typeof renderAll === 'function') renderAll(); } catch (e) {} }
    ensurePanel();
  }
  var tries = 0;
  var iv = setInterval(function () { tries++; if ((document.getElementById('tab-camp-t') && typeof DB !== 'undefined') || tries > 80) { clearInterval(iv); init(); } }, 400);
  if (document.readyState !== 'loading') { /* iv가 처리 */ }
})();
