/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 공유 자동 동기화 (pointail-autosync.js)
 *
 *  [배경] 기존에는 사용자마다 ⚡ API 동기화를 눌러 각자 어드민 API를
 *  호출(캠페인 전량+회원)해 중복 부하가 발생했다.
 *  이제 Cloudflare Worker 크론(3시간, KST 09·12·15·18·21·00·03·06시)이
 *  중앙에서 1회 수집해 KV 스냅샷(/snapshot)으로 공유한다.
 *
 *  이 모듈의 역할:
 *   1) 접속 시  : /snapshot/meta 확인 → 로컬보다 새 스냅샷이면 자동 적용
 *                (DB.camp/DB.member 교체 → 규칙 재적용 → renderAll → saveState)
 *   2) 5분 폴링 : 세션 중에도 크론 갱신분을 자동 반영
 *   3) ⚡ 버튼   : "공유 강제 새로고침"으로 대체 — /snapshot/refresh 호출로
 *                중앙 스냅샷 자체를 갱신(5분 제한) → 모두가 즉시 최신본
 *                (엔드포인트 미배포 시 기존 syncFromApi로 폴백)
 *   4) 버튼 옆에 "공유 동기화 HH:MM" 배지 표시
 *   5) [v2] 헤더 정리: 사용하지 않는 버튼(데이터 저장/불러오기·다운로드·
 *      구글시트 동기화·업로드·⚙·+데이터 입력)과 "마지막 저장" 문구를 숨기고
 *      ⚡ API 동기화 버튼 + 공유 동기화 배지만 남긴다.
 *
 *  ※ DB는 window 프로퍼티가 아니라 스크립트 전역(let/const)이므로 bare DB 사용.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var WORKER = 'https://pointail-api.zeroho.workers.dev';
  var LS_TS = 'pt_snap_applied_at';
  var POLL_MS = 5 * 60 * 1000;
  var busy = false;

  function toast(m, bad) {
    var d = document.createElement('div');
    d.textContent = m;
    d.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;background:' + (bad ? '#c0392b' : '#111') + ';color:#fff;padding:9px 18px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    document.body.appendChild(d); setTimeout(function () { d.remove(); }, 3200);
  }
  function hhmm(iso) {
    try { var t = new Date(iso); return ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2); } catch (e) { return ''; }
  }
  function getMeta() {
    return fetch(WORKER + '/snapshot/meta?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  // 스냅샷 데이터를 대시보드 DB에 적용(원본 syncFromApi와 동일한 후처리 순서)
  function applySnap(snap) {
    if (!snap || !snap.camp || !Array.isArray(snap.camp.campaigns) || !snap.camp.campaigns.length) return false;
    if (typeof DB === 'undefined' || !DB) return false;
    DB.camp = snap.camp.campaigns;
    if (snap.member && Array.isArray(snap.member.members) && snap.member.members.length) DB.member = snap.member.members;
    try { if (window.ptResolveReps) window.ptResolveReps(); } catch (e) {}
    try { if (window._autoApplyRules) window._autoApplyRules(); } catch (e) {}
    try { if (typeof renderAll === 'function') renderAll(); } catch (e) {}
    try { if (typeof saveState === 'function') saveState(); } catch (e) {}
    return true;
  }

  function pullAndApply(meta, silent) {
    return fetch(WORKER + '/snapshot?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (snap) {
        if (!snap || snap.empty) return false;
        var ok = applySnap(snap);
        if (ok) {
          var ts = (snap.meta && snap.meta.updatedAt) || (meta && meta.updatedAt) || '';
          try { localStorage.setItem(LS_TS, ts); } catch (e) {}
          updateBadge(ts);
          if (!silent) toast('공유 데이터 적용됨 · ' + hhmm(ts) + ' 동기화 기준 (캠페인 ' + snap.camp.count + '건)');
        }
        return ok;
      }).catch(function () { return false; });
  }

  // 접속/폴링 시: 새 스냅샷이면 자동 적용
  function checkAndSync(silent) {
    getMeta().then(function (meta) {
      if (!meta || !meta.updatedAt) return;                     // 스냅샷 없음(크론 미가동)
      var loc = '';
      try { loc = localStorage.getItem(LS_TS) || ''; } catch (e) {}
      updateBadge(meta.updatedAt);
      if (meta.updatedAt !== loc) pullAndApply(meta, silent);
    });
  }

  // ⚡ 버튼 → 공유 강제 새로고침 (중앙 스냅샷 갱신 후 모두 최신)
  function sharedRefresh() {
    if (busy) return; busy = true;
    var btn = document.getElementById('api-sync-btn');
    var orig = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '⏳ 공유 동기화 중…'; btn.disabled = true; }
    function done() { if (btn) { btn.textContent = orig || '⚡ API 동기화'; btn.disabled = false; } busy = false; }
    fetch(WORKER + '/snapshot/refresh?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) {                                              // 엔드포인트 미배포 → 기존 방식 폴백
          done();
          if (typeof window.syncFromApi === 'function') window.syncFromApi();
          return;
        }
        if (j.tooSoon) {
          toast('이미 ' + hhmm(j.meta && j.meta.updatedAt) + '에 동기화됨 · 5분 후 다시 시도 가능 (최신 공유본을 불러옵니다)');
        } else if (!j.ok) {
          toast('동기화 실패: ' + (j.error || '알 수 없음'), true);
          done(); return;
        }
        pullAndApply(j.meta, true).then(function (ok) {
          if (ok && !j.tooSoon) toast('전체 공유 동기화 완료 · 모든 사용자에게 반영됩니다');
          done();
        });
      })
      .catch(function () { done(); if (typeof window.syncFromApi === 'function') window.syncFromApi(); });
  }

  // ⚡ 버튼 교체(기존 리스너 제거) + 배지 부착
  function updateBadge(iso) {
    var b = document.getElementById('pt-snap-badge');
    if (b) b.textContent = '🕘 공유 동기화 ' + hhmm(iso);
  }
  function ensureButton() {
    var btn = document.getElementById('api-sync-btn');
    if (!btn || btn.__ptAuto) return;
    var nb = btn.cloneNode(true);                              // 기존(개별 호출) 리스너 제거
    nb.__ptAuto = true;
    nb.title = '중앙 스냅샷을 강제로 새로고침합니다(5분 제한). 평소엔 3시간마다 자동 동기화됩니다.';
    btn.parentNode.replaceChild(nb, btn);
    nb.addEventListener('click', sharedRefresh);
    if (!document.getElementById('pt-snap-badge')) {
      var s = document.createElement('span');
      s.id = 'pt-snap-badge';
      s.style.cssText = 'font-size:11px;color:#8a94a6;margin-left:6px;white-space:nowrap';
      s.textContent = '🕘 공유 동기화 —';
      nb.parentNode.insertBefore(s, nb.nextSibling);
    }
  }

  // [v2] 헤더 정리 — ⚡버튼·공유 배지만 남기고 미사용 버튼/문구 숨김
  // [v3 2026-08-27] 화이트리스트에 pt-theme-toggle(🌓 화면 색상 전환 버튼) 추가 —
  //     darkmode 모듈이 넣는 버튼을 tidyHeader가 숨기던 문제 수정
  function tidyHeader() {
    var saved = document.getElementById('last-saved-txt');           // "마지막 저장 · 본인 마지막 동기화"
    if (saved && saved.style.display !== 'none') saved.style.display = 'none';
    var row = document.getElementById('topbar-btns');
    if (row) {
      [].slice.call(row.children).forEach(function (el) {
        if (el.id !== 'gs-btn-group' && el.style.display !== 'none') el.style.display = 'none';
      });
    }
    var grp = document.getElementById('gs-btn-group');
    if (grp) {
      [].slice.call(grp.children).forEach(function (el) {
        if (el.id !== 'api-sync-btn' && el.id !== 'pt-snap-badge' && el.id !== 'pt-theme-toggle' && el.style.display !== 'none') el.style.display = 'none';
      });
    }
  }

  function start() {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      try { ensureButton(); tidyHeader(); } catch (e) {}
      if (document.getElementById('api-sync-btn') && document.getElementById('api-sync-btn').__ptAuto) clearInterval(iv);
      else if (tries > 60) clearInterval(iv);
    }, 500);
    setInterval(function () { try { tidyHeader(); } catch (e) {} }, 3000);   // 재렌더 대비
    setTimeout(function () { checkAndSync(false); }, 2500);    // 접속 시 1회(규칙 동기화 이후)
    setInterval(function () { checkAndSync(true); }, POLL_MS); // 5분 폴링(크론 갱신 자동 반영)
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
