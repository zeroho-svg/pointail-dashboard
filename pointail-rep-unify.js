/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 담당자 통일 전처리 모듈 (pointail-rep-unify.js)
 *
 *  [규칙] 각 캠페인의 영업 담당자(salesManager)를 아래 우선순위로 확정한다.
 *    1) 캠페인 신청 영업자(campaign.salesManager) — 있으면 그대로 (과거/퇴사 담당자 포함, 규칙 그대로)
 *    2) 없으면 → 광고주 회원DB에 연결된 담당자(member.salesRep), 법인명(corpName ↔ company)으로 매칭
 *    3) 그래도 없으면(회원 매칭 실패/법인명 없음/법인명 중복충돌) → '미배정'
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

    // 법인명(company) → 회원 담당자(salesRep) 매핑. 충돌 시 '__DUP__'
    var map = {};
    for (var i = 0; i < mems.length; i++) {
      var co = String(mems[i].company == null ? '' : mems[i].company).trim();
      if (!co) continue;
      var rp = String(mems[i].salesRep == null ? '' : mems[i].salesRep).trim();
      if (map[co] === undefined) map[co] = rp;
      else if (map[co] !== rp) map[co] = '__DUP__';
    }

    var camps = DB.camp;
    for (var j = 0; j < camps.length; j++) {
      var c = camps[j];
      // 원본 캠페인 담당자 1회 보존
      if (c.__smOrig === undefined) c.__smOrig = String(c.salesManager == null ? '' : c.salesManager).trim();
      var sm = c.__smOrig;
      if (sm) { c.salesManager = sm; continue; }               // 1) 캠페인 담당자
      var co2 = String(c.corpName == null ? '' : c.corpName).trim();
      var fb = co2 ? map[co2] : undefined;
      c.salesManager = (fb && fb !== '__DUP__') ? fb : MI;       // 2) 회원 담당자  3) 미배정
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
