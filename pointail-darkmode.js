/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 🌓 화면 색상 전환 (pointail-darkmode.js)
 *
 *  [배경] 일부 컴퓨터(OS 다크 모드 + 크롬 '웹 콘텐츠 자동 다크')에서
 *  대시보드가 강제로 어둡게 변환되어 글자가 안 보이는 문제(2026-08-27 리포트).
 *  이 모듈은:
 *    ① `color-scheme: only light` 로 브라우저 자동 다크 변환을 차단하고
 *    ② 헤더의 ⚡ API 동기화 버튼 옆에 🌙/☀️ 전환 버튼을 추가한다.
 *       - ☀️ 라이트(기본): 원본 밝은 화면 그대로
 *       - 🌙 다크: invert+hue-rotate 필터로 전체 반전(이미지·차트 캔버스는 재반전)
 *    ③ 선택은 localStorage(pt_theme)에 저장 — 컴퓨터(브라우저)별 개인 설정.
 *  원본 index.html은 수정하지 않는다(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var KEY = 'pt_theme';

  function cur() { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
  function save(m) { try { localStorage.setItem(KEY, m); } catch (e) {} }

  function apply(m) {
    var st = document.getElementById('pt-dark-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'pt-dark-style';
      (document.head || document.documentElement).appendChild(st);
    }
    /* 브라우저 자동 다크(강제 변환) 차단 — 색상은 이 모듈이 직접 제어 */
    var block = ':root{color-scheme:only light}';
    if (m === 'dark') {
      st.textContent = block +
        'html.pt-dark{filter:invert(0.93) hue-rotate(180deg);background:#0f1115!important}' +
        'html.pt-dark img,html.pt-dark video,html.pt-dark iframe,html.pt-dark canvas,html.pt-dark svg image{filter:invert(1) hue-rotate(180deg)}';
      document.documentElement.classList.add('pt-dark');
    } else {
      st.textContent = block;
      document.documentElement.classList.remove('pt-dark');
    }
    var b = document.getElementById('pt-theme-toggle');
    if (b) {
      b.textContent = m === 'dark' ? '☀️ 밝게' : '🌙 어둡게';
      b.title = '화면 색상 전환 (현재: ' + (m === 'dark' ? '다크' : '라이트') + ' · 이 컴퓨터에만 저장됩니다)';
    }
  }

  function toggle() {
    var m = cur() === 'dark' ? 'light' : 'dark';
    save(m);
    apply(m);
  }

  function ensure() {
    if (document.getElementById('pt-theme-toggle')) return;
    /* ⚡ API 동기화 버튼 옆(같은 헤더 컨테이너)에 배치. 없으면 다음 재시도. */
    var sync = null, btns = document.querySelectorAll('button'), i;
    for (i = 0; i < btns.length; i++) {
      if (/API 동기화/.test(btns[i].textContent || '')) { sync = btns[i]; break; }
    }
    if (!sync || !sync.parentNode) return;
    var b = document.createElement('button');
    b.id = 'pt-theme-toggle'; b.type = 'button';
    b.style.cssText = 'height:28px;padding:0 10px;margin-left:6px;border:1px solid #e5e8ee;background:#fff;border-radius:8px;cursor:pointer;font-size:12px;color:#48505c;vertical-align:middle';
    b.addEventListener('click', toggle);
    if (sync.nextSibling) sync.parentNode.insertBefore(b, sync.nextSibling);
    else sync.parentNode.appendChild(b);
    apply(cur());
  }

  apply(cur());   // 버튼 생성 전이라도 즉시 적용(자동 다크 차단 포함)

  var t = null;
  function sched() { clearTimeout(t); t = setTimeout(function () { try { ensure(); } catch (e) {} }, 300); }
  function start() {
    try { new MutationObserver(sched).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    ensure();
    setInterval(function () { try { ensure(); } catch (e) {} }, 5000);
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
