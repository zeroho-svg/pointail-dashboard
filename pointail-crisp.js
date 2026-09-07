/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 화면 선명도 개선 (pointail-crisp.js v1, 2026-09-07)
 *
 *  사용자 리포트: "전체적인 폰트와 컬러가 선명하지 않다"
 *  ① 웹폰트 Pretendard 적용 — 기본 맑은고딕 대비 획이 또렷하고 가독성 높음
 *  ② 흐린 회색 텍스트 자동 진하게 — 인라인 스타일로 박힌 저채도·밝은 회색
 *     (#8a94a6, #98a2b3 등)을 한 단계 어두운 색으로 치환해 대비(contrast) 강화
 *     · 색상 계열(빨강·초록·파랑 등 채도 있는 색)은 건드리지 않음
 *     · MutationObserver 로 다시 그려지는 표·카드에도 계속 적용
 *  ③ 다크모드( html.pt-dark ) 대비 보정 — invert(0.93) 필터가 색을 씻어내는
 *     것을 contrast(1.08) 로 보완 (darkmode 모듈보다 늦게 로드되므로 우선 적용)
 *  원본 index.html은 수정하지 않는다(주입형). 부트로더(MODS)로 로드.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── ① 폰트 ── */
  function ensureFont() {
    if (document.getElementById('pt-crisp-font')) return;
    var l = document.createElement('link');
    l.id = 'pt-crisp-font'; l.rel = 'stylesheet';
    l.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
    document.head.appendChild(l);
    var st = document.createElement('style');
    st.id = 'pt-crisp-style';
    st.textContent =
      'body,button,input,select,textarea,table,th,td{font-family:"Pretendard Variable",Pretendard,"Noto Sans KR","Malgun Gothic",system-ui,-apple-system,sans-serif !important}' +
      'body{text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}' +
      /* 다크모드 대비 보정 — darkmode v2의 filter를 contrast 포함으로 덮어씀 */
      'html.pt-dark{filter:invert(0.93) hue-rotate(180deg) contrast(1.08) !important}';
    document.head.appendChild(st);
  }

  /* ── ② 흐린 회색 텍스트 진하게 ── */
  //  대상: 인라인 style 의 color 가 저채도(회색 계열)이면서 밝은 경우만.
  //  일괄 규칙 대신 실제 값 파싱 → 색상 액센트(초록 128a3a, 빨강 c0392b 등)는 보존.
  function parseColor(v) {
    v = String(v || '').trim();
    var m = v.match(/^#([0-9a-f]{3})$/i);
    if (m) { var h3 = m[1]; return [parseInt(h3[0] + h3[0], 16), parseInt(h3[1] + h3[1], 16), parseInt(h3[2] + h3[2], 16)]; }
    m = v.match(/^#([0-9a-f]{6})$/i);
    if (m) { var h = m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    m = v.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }
  function sweep(root) {
    var els = (root || document).querySelectorAll('[style*="color"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__crisped) continue;
      el.__crisped = true;
      if (el.closest && el.closest('#ptmem-tt')) continue;   // 다크 툴팁 내부 제외
      var c = parseColor(el.style.color);
      if (!c) continue;
      // 어두운 배경 위 텍스트는 제외(어둡게 하면 오히려 안 보임)
      var bg = parseColor(el.style.background || el.style.backgroundColor);
      if (bg && (bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114) / 255 < 0.35) continue;
      var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
      var lum = (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255;
      // 회색 계열(채널 차 ≤ 34) + 중간 밝기(0.42~0.80)만 → 28% 어둡게
      if (mx - mn <= 34 && lum > 0.42 && lum < 0.80) {
        el.style.color = 'rgb(' + Math.round(c[0] * 0.72) + ',' + Math.round(c[1] * 0.72) + ',' + Math.round(c[2] * 0.72) + ')';
      }
    }
  }

  var t = null;
  function sched() { clearTimeout(t); t = setTimeout(function () { try { sweep(); } catch (e) {} }, 300); }
  function start() {
    ensureFont();
    try { new MutationObserver(sched).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    sweep();
    setInterval(function () { try { ensureFont(); } catch (e) {} }, 3000);
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
