/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 그룹 내비게이션 (pointail-nav.js)
 *
 *  상단 탭 10여 개를 4개 그룹 2단 내비게이션으로 재배치한다.
 *    1행(그룹): 💼 영업 · 📊 경영 · 📣 마케팅 · ⚙️ 관리
 *    2행(하위): 선택된 그룹의 기존 탭 버튼들 (원본 버튼을 이동만 하므로
 *               기존 클릭 핸들러·showTab 로직 그대로 동작)
 *  - 💼 영업: 영업 대시보드 · 영업 성과 분석 · 광고주 관리
 *  - 📊 경영: 손익 오버뷰 · 매출 대시보드
 *  - 📣 마케팅: 메타성과
 *  - ⚙️ 관리: 비용내역정리 · 데이터 관리 · DB 조회 · 설정(기존 토글 그룹 유지)
 *  모듈(메타성과·광고주관리·손익)이 늦게 주입하는 버튼도 감시해 흡수한다.
 *  원본 index.html은 수정하지 않는다(주입형). 부트로더(MODS)로 로드.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var GROUPS = [
    { key: 'home', label: '🏠 홈', ids: ['tab-btn-home'], panels: ['tab-home'] },
    { key: 'sales', label: '💼 영업', ids: ['tab-btn-dashboard', 'tab-btn-sales-perf', 'tab-btn-advmgr'], panels: ['tab-dashboard', 'tab-sales-perf', 'tab-advmgr'] },
    { key: 'mgmt', label: '📊 경영', ids: ['tab-btn-cost', 'tab-btn-sales-dash'], panels: ['tab-cost', 'tab-sales-dash'] },
    { key: 'mkt', label: '📣 마케팅', ids: ['tab-btn-meta'], panels: ['tab-meta'] },
    { key: 'admin', label: '⚙️ 관리', ids: ['tab-btn-costin', 'tg-data', 'tg-db', 'tg-settings'], panels: ['tab-costin', 'tab-upload', 'tab-add', 'tab-merged', 'tab-leads-t', 'tab-mem-t', 'tab-camp-t', 'tab-settings', 'tab-rules'] }
  ];
  var cur = 'sales';

  function groupOfPanel(pid) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].panels.indexOf(pid) >= 0) return GROUPS[i].key;
    return null;
  }

  function select(key, click) {
    cur = key;
    GROUPS.forEach(function (g) {
      var on = g.key === key;
      var gb = document.getElementById('ptnav-' + g.key); if (gb) gb.classList.toggle('on', on);
      var row = document.getElementById('ptnavrow-' + g.key);
      if (row) row.classList.toggle('on', on && row.children.length > 1);   // 탭 1개짜리 그룹은 하위 행 생략
    });
    if (click) {
      var g = GROUPS.filter(function (x) { return x.key === key; })[0];
      for (var i = 0; i < g.ids.length; i++) {
        var b = document.getElementById(g.ids[i]);
        if (b && b.classList.contains('tab')) { b.click(); return; }
      }
      var any = document.getElementById(g.ids[0]);
      if (any) any.click();
    }
  }

  // 구(舊) 툴바 정리: 상단바(.topbar)에 같은 버튼이 모두 있는데
  // index.html에 옛 툴바 행(데이터저장/다운로드/구글시트/+입력)이 남아 이중 노출됨 → 숨김
  function hideLegacyToolbar() {
    var app = document.querySelector('.app'); if (!app) return;
    var tb = app.querySelector('.topbar'); if (!tb) return;
    var s = tb.nextElementSibling;
    while (s) {
      if (!s.__pthid) {
        var txt = (s.textContent || '');
        var legacy = s.id === 'dl-wrap' || txt.indexOf('데이터 저장') >= 0 || txt.indexOf('구글시트 동기화') >= 0 || txt.indexOf('+ 데이터 입력') >= 0;
        if (legacy) { s.style.display = 'none'; s.__pthid = true; }
      }
      s = s.nextElementSibling;
    }
  }

  function ensure() {
    hideLegacyToolbar();
    var nav = document.getElementById('main-tabs'); if (!nav) return;

    if (!document.getElementById('ptnav-style')) {
      var st = document.createElement('style'); st.id = 'ptnav-style';
      st.textContent =
        '.ptnav-bar{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px}' +
        '.ptnav-g{border:1px solid transparent;background:#eef1f5;color:#48505c;padding:8px 16px;border-radius:9px;font-size:13.5px;font-weight:700;cursor:pointer;line-height:1.4}' +
        '.ptnav-g:hover{background:#e2e7ee}' +
        '.ptnav-g.on{background:#111827;color:#fff}' +
        '.ptnav-row{display:none;gap:6px;flex-wrap:wrap;align-items:center;margin:0 0 6px;padding:7px 9px;background:#f7f8fa;border-radius:9px}' +
        '.ptnav-row.on{display:flex}';
      document.head.appendChild(st);
    }

    var bar = document.getElementById('ptnav-bar');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'ptnav-bar'; bar.className = 'ptnav-bar';
      nav.insertBefore(bar, nav.firstChild);
      var after = bar;
      GROUPS.forEach(function (g) {
        var b = document.createElement('button');
        b.className = 'ptnav-g'; b.id = 'ptnav-' + g.key; b.type = 'button'; b.textContent = g.label;
        b.addEventListener('click', function () { select(g.key, true); });
        bar.appendChild(b);
        var row = document.createElement('div'); row.className = 'ptnav-row'; row.id = 'ptnavrow-' + g.key;
        if (after.nextSibling) nav.insertBefore(row, after.nextSibling); else nav.appendChild(row);
        after = row;
      });
    }

    // 원본/모듈 탭 버튼을 각 그룹 행으로 흡수 (이동만 — 핸들러 유지)
    GROUPS.forEach(function (g) {
      var row = document.getElementById('ptnavrow-' + g.key); if (!row) return;
      g.ids.forEach(function (id) {
        var b = document.getElementById(id);
        if (b && b.parentElement !== row) row.appendChild(b);
      });
    });

    // 남은 원래 컨테이너는 숨김 (미지정 신규 버튼이 들어오면 다시 표시)
    var tm = nav.querySelector('.tabs-main');
    if (tm) {
      var leftovers = tm.querySelectorAll('button');
      tm.style.display = leftovers.length ? '' : 'none';
      if (!leftovers.length) tm.style.display = 'none';
    }

    // 첫 진입 시 홈으로 랜딩(사용자가 이미 다른 탭을 눌렀으면 유지)
    if (!ensure.__landed && document.getElementById('tab-btn-home')) {
      ensure.__landed = true;
      var act0 = document.querySelector('.panel.active');
      if (!act0 || act0.id === 'tab-dashboard') select('home', true);
    }
    sync();
  }

  function sync() {
    // 활성 패널 기준으로 그룹 하이라이트 동기화
    var act = document.querySelector('.panel.active');
    if (act) {
      var gk = groupOfPanel(act.id);
      if (gk && gk !== cur) { select(gk, false); return; }
    }
    var gb = document.getElementById('ptnav-' + cur);
    if (gb && !gb.classList.contains('on')) select(cur, false);
  }

  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(function () { try { ensure(); } catch (e) {} }, 150); }
  function start() {
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(function () { try { ensure(); } catch (e) {} }, 1200);
    ensure();
    select('sales', false);
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
