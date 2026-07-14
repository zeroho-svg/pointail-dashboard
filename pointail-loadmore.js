/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – "나머지 더보기" 토글 수정 모듈 (pointail-loadmore.js)
 *
 *  매출 대시보드 등의 표에는 "▼ 나머지 N건 더 보기 / ▲ 접기" 버튼이 있으나,
 *  기존 코드가 텍스트만 바뀌고 실제로는 나머지 행이 항상 보이는 버그가 있었다.
 *  이 모듈이 그 토글을 실제로 동작하게 고친다:
 *    · 최초 15건만 표시(상위 표), 나머지 표는 접어서 숨김
 *    · "더 보기" → 나머지 표시 / "접기" → 다시 15건
 *  필터 변경 등으로 표가 다시 그려지면 자동으로 재적용(MutationObserver).
 *  원본 코드는 수정하지 않는다(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function fixAll() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      if (btn.__lmfixed) continue;
      var txt = (btn.textContent || '').trim().replace(/\s+/g, ' ');
      if (!(/^[▼▲]?\s*나머지 \d+건 더 보기$/.test(txt) || /^[▼▲]?\s*접기$/.test(txt))) continue;

      // 나머지 표 = 이 버튼 바로 앞(DOM 순서상 가장 가까운 앞)의 table
      var restTbl = null, tables = document.querySelectorAll('table');
      for (var j = 0; j < tables.length; j++) {
        if (btn.compareDocumentPosition(tables[j]) & Node.DOCUMENT_POSITION_PRECEDING) restTbl = tables[j];
      }
      if (!restTbl) { btn.__lmfixed = true; continue; }
      var body = restTbl.querySelector('tbody') || restTbl;
      var rows = [];
      for (var k = 0; k < body.children.length; k++) { if (body.children[k].tagName === 'TR') rows.push(body.children[k]); }
      if (!rows.length) { btn.__lmfixed = true; continue; }   // 나머지 없음(≤15) → 손대지 않음

      (function (btn, rows) {
        var expanded = false;
        function apply() { for (var r = 0; r < rows.length; r++) rows[r].style.display = expanded ? '' : 'none'; }
        apply();
        var nb = btn.cloneNode(false);   // 기존(고장난) 핸들러 제거
        nb.className = btn.className;
        nb.__lmfixed = true;
        btn.parentNode.replaceChild(nb, btn);
        function label() { nb.textContent = expanded ? '▲ 접기' : ('▼ 나머지 ' + rows.length + '건 더 보기'); }
        label();
        nb.addEventListener('click', function () { expanded = !expanded; apply(); label(); });
      })(btn, rows);
    }
  }

  var timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(fixAll, 200); }

  function start() {
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    fixAll();
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();

/* ────────────────────────────────────────────────────────────
 *  [부트로더] index.html을 직접 수정하지 않고 신규 모듈을 동적 로드한다.
 *  · pointail-rep-unify.js  — 캠페인 담당자 통일 전처리 (모든 대시보드 공통)
 *  이미 index.html이 이 loadmore 스크립트를 로드하므로, 여기서 이어서 로드하면
 *  별도의 <script> 태그 추가 없이 신규 모듈이 적용된다.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var MODS = ['pointail-rep-unify.js?v=1', 'pointail-advmgr-rep.js?v=3'];
  function load(src) {
    if (document.querySelector('script[data-ptmod="' + src + '"]')) return;
    var s = document.createElement('script');
    s.src = src;
    s.setAttribute('data-ptmod', src);
    document.body.appendChild(s);
  }
  function boot() { MODS.forEach(load); }
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
