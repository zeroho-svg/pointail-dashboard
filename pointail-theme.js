/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 공통 가독성 테마 (pointail-theme.js)
 *
 *  노트북(13~15인치) 화면 기준 가독성 개선:
 *   · Pretendard 가변 폰트 적용(한글 최적화, jsDelivr CDN, 실패 시 시스템 폰트 폴백)
 *   · 기본 줄간격 1.55 / 표 줄간격 1.5
 *   · 표 숫자 고정폭(tabular-nums) → 자릿수 정렬
 *   · 광고주 관리 등 표(cell) 여백 소폭 확대
 *  원본 index.html은 수정하지 않는다(주입형). 부트로더(MODS)로 로드.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (document.getElementById('pt-theme')) return;

  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
  document.head.appendChild(l);

  var s = document.createElement('style');
  s.id = 'pt-theme';
  s.textContent =
    'body,button,input,select,textarea{font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif}' +
    'body{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;letter-spacing:-0.01em;line-height:1.55;font-size:14px}' +
    'h1,h2,h3{letter-spacing:-0.015em}' +
    'table{line-height:1.5;font-variant-numeric:tabular-nums}' +
    'th{font-weight:600}' +
    '.ptad-tbl{font-size:13px}' +
    '.ptad-tbl th{padding:9px 11px}' +
    '.ptad-tbl td{padding:9px 11px}';
  document.head.appendChild(s);
})();
