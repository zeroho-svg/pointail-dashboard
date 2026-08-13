/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 📝 노션 광고주 DB 바로가기 (pointail-notion.js) v1
 *
 *  영업 › 🏢 광고주 관리 › 광고주 목록 표의 각 행과 상세 모달 헤더에
 *  「📝 노션」 버튼을 추가한다.
 *
 *  동작: 클릭 → ① 법인명을 클립보드에 자동 복사
 *              ② 노션 「(국내) 광고주 DB · 일본 광고주(Master View)」 새 탭으로 열기
 *        → 노션 검색창에 Ctrl+V(붙여넣기) 하면 해당 업체의 기록 페이지
 *          (기본정보·회의록·제안서 및 업무 list·진행 캠페인 list·업무 히스토리)로 이동.
 *
 *  ※ 업체별 페이지로 "직행"하려면 법인명↔노션 페이지ID 매핑표를 대시보드가 읽어야 하는데,
 *    이 저장소는 Public 이라 고객사 명단이 노출된다. 그래서 매핑 파일은 배포하지 않고
 *    복사+열기 방식으로 구현했다(홈 캘린더 캠페인 번호 버튼과 동일한 패턴).
 *    추후 저장소를 Private 로 전환하거나 Worker KV(/notion-map)에 두면 직행 링크로 승급 가능.
 *    (참고: 노션 `?q=` 검색 딥링크는 홈으로 리다이렉트되어 작동하지 않음 — 2026-08-13 확인)
 *
 *  원본 index.html·pointail-advertiser.js 는 수정하지 않는다(주입형 오버라이드).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* 노션 (국내) 광고주 DB — 일본 광고주(Master View) */
  var NOTION_DB = 'https://app.notion.com/p/storelink/9e431ed83ebb4a6cb4ef64e7265ad355' +
                  '?v=26267743f1c24cbdaaa2787cd274f4bf';

  var BTN = 'display:inline-block;font-size:11px;font-weight:700;line-height:1.6;padding:2px 8px;' +
            'border-radius:7px;text-decoration:none;white-space:nowrap;margin-right:4px;' +
            'background:#f4f1fb;border:1px solid #ded6f5;color:#5b45a8;cursor:pointer';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }
  function attr(s) { return esc(String(s == null ? '' : s).replace(/'/g, '')); }

  function btnHTML(company) {
    return '<a href="' + NOTION_DB + '" target="_blank" rel="noopener" class="ptntn-b"' +
      ' title="노션 광고주 DB 열기 — 법인명이 복사됩니다. 노션 검색창에 Ctrl+V 붙여넣기 하면 해당 업체 기록 페이지로 이동합니다."' +
      ' onclick="event.stopPropagation();window.PTNTN&amp;&amp;PTNTN.copy(\'' + attr(company) + '\')"' +
      ' style="' + BTN + '">📝 노션</a>';
  }

  /* ── 표·모달에 주입 ── */
  function decorate() {
    /* 광고주 목록 표 (행 마지막 셀 = 「상세」 버튼 칸) */
    var rows = document.querySelectorAll('tr.ptad-adv-row:not([data-ptntn])');
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      tr.setAttribute('data-ptntn', '1');
      var cell = tr.lastElementChild;
      if (cell) cell.insertAdjacentHTML('afterbegin', btnHTML(tr.getAttribute('data-company') || ''));
    }
    /* 광고주 상세 모달 헤더 */
    var meta = document.querySelector('#ptad-modal .ptad-meta:not([data-ptntn])');
    if (meta) {
      meta.setAttribute('data-ptntn', '1');
      var t = document.querySelector('#ptad-modal .ptad-mh div[style*="font-weight:800"]');
      var comp = t ? String(t.textContent || '').split('#')[0].trim() : '';
      if (comp) meta.insertAdjacentHTML('beforeend', '<span>' + btnHTML(comp) + '</span>');
    }
  }

  function boot() {
    decorate();
    try {
      new MutationObserver(function () { decorate(); })
        .observe(document.body, { childList: true, subtree: true });
    } catch (e) { }
    setInterval(decorate, 1500);   // 원본 재렌더(필터·정렬) 대비
  }

  window.PTNTN = {
    /* 법인명 클립보드 복사. 새 탭 이동은 <a target="_blank"> 기본 동작. */
    copy: function (name) {
      try { navigator.clipboard && navigator.clipboard.writeText(String(name)); } catch (e) { }
      return true;
    },
    refresh: decorate
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
