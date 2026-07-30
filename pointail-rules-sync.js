/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 규칙(금액·제외) 공유 동기화 (pointail-rules-sync.js)
 *
 *  「설정 → 규칙」(localStorage `pt_rules`: 일본 ×10 환산 + 행 제외필터)은
 *  기존에 컴퓨터별로만 저장돼, 컴퓨터마다 건수·금액이 달라지는 원인이었다.
 *  이 모듈이 제외목록·비용처럼 **Cloudflare KV(/rules)로 공유**한다.
 *
 *   · 로드 시  : KV(/rules) GET → 로컬과 다르면 로컬을 KV로 교체 후 1회 새로고침
 *                (원본 index.html의 전역 RULES 는 localStorage 에서 로드되므로 새로고침 필요),
 *                이어서 window._autoApplyRules() 로 현재 스냅샷에 재적용.
 *                KV가 비어있으면 이 컴퓨터 규칙으로 시드(seed).
 *   · 변경 감지: 사용자가 규칙을 바꾸면(saveRules → pt_rules 갱신) 폴링으로 감지해 KV에 PUT.
 *   · 정확한 금액은 규칙 반영 후 ⚡ API 동기화로 최신화(안내 토스트).
 *
 *  ※ /rules 엔드포인트 미배포 시엔 조용히 로컬 전용으로 동작(무해).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var EP = 'https://pointail-api.zeroho.workers.dev/rules';
  var LSK = 'pt_rules';
  var RELOAD_FLAG = 'pt_rules_reloaded';
  var lastKnown = null;   // KV와 마지막으로 일치한 로컬 규칙(정규화 문자열)

  function norm(s) { try { return JSON.stringify(JSON.parse(s || 'null')); } catch (e) { return null; } }
  function localRaw() { return localStorage.getItem(LSK); }
  function isRuleObj(txt) { return !!txt && /"jpy"|"rowFilters"/.test(txt); }
  function toast(m, bad) {
    var d = document.createElement('div');
    d.textContent = m;
    d.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;background:' + (bad ? '#c0392b' : '#111') + ';color:#fff;padding:9px 18px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    document.body.appendChild(d); setTimeout(function () { d.remove(); }, 2600);
  }
  function put(body) {
    return fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // 새로고침 후 공유 규칙을 현재 DB 스냅샷에 재적용
  function reapplyWhenReady() {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (typeof window._autoApplyRules === 'function' && typeof DB !== 'undefined' && DB && DB.camp) {
        try { window._autoApplyRules(); } catch (e) {}
        clearInterval(iv);
        toast('공유 규칙 적용됨 · 정확한 금액은 ⚡ API 동기화로 최신화하세요');
      } else if (tries > 50) clearInterval(iv);
    }, 400);
  }

  function pushPoll() {
    if (pushPoll.__on) return; pushPoll.__on = true;
    setInterval(function () {
      var loc = norm(localRaw());
      if (loc && loc !== 'null' && loc !== lastKnown) {
        lastKnown = loc;
        put(localRaw()).then(function (ok) { if (ok) toast('규칙을 공유 저장했습니다 (모든 컴퓨터 반영)'); });
      }
    }, 2500);
  }

  function sync() {
    fetch(EP + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) {
        var kv = isRuleObj(txt) ? norm(txt) : null;
        var loc = norm(localRaw());
        if (!kv) {                                   // KV 비어있음 → 이 컴퓨터 규칙으로 시드
          if (loc && loc !== 'null') { put(localRaw()); lastKnown = loc; }
          else lastKnown = loc;
          if (sessionStorage.getItem(RELOAD_FLAG)) { sessionStorage.removeItem(RELOAD_FLAG); reapplyWhenReady(); }
          pushPoll(); return;
        }
        if (kv !== loc) {                            // 공유 규칙 채택
          try { localStorage.setItem(LSK, txt); } catch (e) {}
          lastKnown = kv;
          if (!sessionStorage.getItem(RELOAD_FLAG)) {
            sessionStorage.setItem(RELOAD_FLAG, '1');
            location.reload();                       // 전역 RULES 를 KV 규칙으로 재로딩
            return;
          }
        } else { lastKnown = kv; }
        if (sessionStorage.getItem(RELOAD_FLAG)) { sessionStorage.removeItem(RELOAD_FLAG); reapplyWhenReady(); }
        pushPoll();
      })
      .catch(function () { lastKnown = norm(localRaw()); pushPoll(); });   // 실패 시 clobber 방지
  }

  if (document.readyState !== 'loading') setTimeout(sync, 1500);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(sync, 1500); });
})();
