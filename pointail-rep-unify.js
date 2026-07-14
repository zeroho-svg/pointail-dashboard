/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 담당자 통일 전처리 모듈 (pointail-rep-unify.js)
 *
 *  [규칙] 각 캠페인의 영업 담당자(salesManager)를 아래 우선순위로 확정한다.
 *    1) 캠페인 신청 영업자(campaign.salesManager) — 있으면 그대로 (과거/퇴사 담당자 포함, 규칙 그대로)
 *    2) 없으면 → 광고주 회원DB에 연결된 담당자(member.salesRep), 법인명(corpName ↔ company)으로 매칭
 *       · [v2 2026-07-15] 법인명 중복(여러 계정) 시 → "캠페인 신청일 이전에 가입한 계정 중
 *         가장 최신 계정"의 담당자에 귀속(없으면 그 후 최초 가입 계정). 기존 '__DUP__→미배정' 대체.
 *    3) 그래도 없으면(회원 매칭 실패/법인명 없음/담당자 공란) → '미배정'
 *
 *  DB.camp 의 각 캠페인 salesManager 값을 위 규칙으로 덮어써서,
 *  이 필드를 읽는 모든 대시보드(매출 대시보드·영업 성과 분석·KPI·메타성과)가
 *  동일한 담당자 기준으로 집계되게 한다. (원본 index.html 로직은 수정하지 않음)
 *
 *  · 원본 salesManager 는 c.__smOrig 에 1회 보존 → 매 실행이 멱등(idempotent)하고,
 *    회원 데이터가 나중에 로드돼도 재매칭됨.
 *  · renderAll 을 래핑해 매 렌더 직전 규칙을 재적용(⚡동기화·필터 재렌더 대응).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var MI = '미배정';

  function build() {
    if (typeof DB === 'undefined' || !DB || !DB.camp || !DB.camp.length) return;
    var mems = DB.member || [];

    // 법인명(company) → 계정 목록(가입일 오름차순). 중복 법인명은
    // "캠페인 신청일 기준 당시 최신 계정"의 담당자에 귀속.
    var idx = {};
    for (var i = 0; i < mems.length; i++) {
      var co = String(mems[i].company == null ? '' : mems[i].company).trim();
      if (!co) continue;
      (idx[co] = idx[co] || []).push(mems[i]);
    }
    for (var k in idx) {
      idx[k].sort(function (a, b) { return String(a.joinDate || '').localeCompare(String(b.joinDate || '')); });
    }

    // 캠페인 c의 소유 계정 담당자: 신청일 이전 가입 계정 중 가장 최신 → 없으면 그 후 최초 가입 계정
    function ownerRep(c) {
      var co = String(c.corpName == null ? '' : c.corpName).trim();
      var list = co ? idx[co] : null;
      if (!list || !list.length) return '';
      var own = null;
      if (list.length === 1) own = list[0];
      else {
        var cd = String(c.createdAt || '').slice(0, 10);
        for (var x = 0; x < list.length; x++) {
          var jd = String(list[x].joinDate || '').slice(0, 10);
          if (!cd || !jd || jd <= cd) own = list[x];   // 오름차순 → 마지막 통과 항목 = 당시 최신
        }
        if (!own) own = list[0];
      }
      return String(own.salesRep == null ? '' : own.salesRep).trim();
    }

    var camps = DB.camp;
    for (var j = 0; j < camps.length; j++) {
      var c = camps[j];
      // 원본 캠페인 담당자 1회 보존
      if (c.__smOrig === undefined) c.__smOrig = String(c.salesManager == null ? '' : c.salesManager).trim();
      var sm = c.__smOrig;
      if (sm) { c.salesManager = sm; continue; }               // 1) 캠페인 담당자
      var fb = ownerRep(c);
      c.salesManager = fb || MI;                                // 2) 회원 담당자  3) 미배정
    }
  }

  // 외부에서도 호출 가능하게 노출
  window.ptResolveReps = build;

  // renderAll 을 래핑: 매 렌더 직전 규칙 재적용
  function wrapRenderAll() {
    if (typeof window.renderAll === 'function' && !window.renderAll.__ptWrap) {
      var orig = window.renderAll;
      var w = function () { try { build(); } catch (e) {} return orig.apply(this, arguments); };
      w.__ptWrap = true;
      window.renderAll = w;
      return true;
    }
    return !!(window.renderAll && window.renderAll.__ptWrap);
  }

  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var wrapped = wrapRenderAll();
    try { build(); } catch (e) {}
    if ((wrapped && DB && DB.camp && DB.camp.length) || tries > 120) clearInterval(iv);
  }, 400);

  if (document.readyState !== 'loading') { wrapRenderAll(); try { build(); } catch (e) {} }
  else document.addEventListener('DOMContentLoaded', function () { wrapRenderAll(); try { build(); } catch (e) {} });
})();
