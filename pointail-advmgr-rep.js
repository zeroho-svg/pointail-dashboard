/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 광고주 관리 "영업담당자" 캠페인 기준 통일 (pointail-advmgr-rep.js)
 *
 *  광고주 관리 > 🧑‍💼 영업담당자 하위탭은 원래 회원 담당자(salesRep) 기준이라
 *  캠페인 기반 대시보드(매출·메타성과 등)와 담당자 집계가 어긋났다.
 *  이 모듈은 그 표와 '담당자 상세(히스토리)'를 캠페인 담당자 기준으로 다시 계산한다.
 *    · 담당자 = 캠페인의 salesManager (pointail-rep-unify.js가 확정한 값: 캠페인 담당자 → 회원 → 미배정)
 *    · 담당 광고주 = 그 담당자에게 귀속된 캠페인의 법인명(고유) + 0캠페인 광고주는 회원 담당자로 포함
 *    · 계약/실행 매출 4종 = 그 담당자 캠페인 합계 (DB.camp 금액 = 대시보드 보정규칙 적용된 값)
 *  광고주 목록·재신청 하위탭은 계정 담당(회원) 기준 그대로 둔다(원본 유지).
 *  원본 pointail-advertiser.js 는 수정하지 않고 DOM 을 후처리(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var ACTIVE = ['모집중', '선정 완료', '등록 대기', '추가 모집중', '등록 완료', '일시 중지'];
  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s₩¥]/g, '')) || 0; }
  function f(v) { return Math.round(n(v)).toLocaleString('ko-KR'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function isActive(st) { return ACTIVE.indexOf(st) >= 0; }
  function camps() { return (window.DB && DB.camp) ? DB.camp : []; }
  function members() { return (window.DB && DB.member) ? DB.member : []; }
  function repOf(c) { return String(c.salesManager == null ? '' : c.salesManager).trim() || '미배정'; }

  // ── 캠페인 기준 담당자별 집계 ──
  function aggregate() {
    var by = {};
    function ens(r) { if (!by[r]) by[r] = { rep: r, corps: {}, actCorps: {}, camps: 0, cSale: 0, cSvc: 0, eSale: 0, eSvc: 0 }; return by[r]; }
    var cs = camps();
    cs.forEach(function (c) {
      var a = ens(repOf(c));
      a.camps++;
      var corp = String(c.corpName || '').trim() || '(법인명 없음)';
      a.corps[corp] = 1;
      if (isActive(c.campaignStatus)) a.actCorps[corp] = 1;
      a.cSale += n(c.contractFinal); a.cSvc += n(c.contractMktCost);
      a.eSale += n(c.execTotalAmount); a.eSvc += n(c.execNetAmount);
    });
    // 0캠페인 광고주 → 회원 담당자 기준으로 담당 광고주에 포함
    var campCorps = {};
    cs.forEach(function (c) { var co = String(c.corpName || '').trim(); if (co) campCorps[co] = 1; });
    members().forEach(function (m) {
      var r = String(m.salesRep || '').trim(); if (!r) return;
      var comp = String(m.company || '').trim(); if (!comp) return;
      if (!campCorps[comp]) ens(r).corps[comp] = 1;   // 캠페인이 전혀 없는 광고주
    });
    return by;
  }

  function nk(o) { return Object.keys(o).length; }

  // ── 담당자별 표(tbody) 재생성 ──
  function rebuildTable() {
    var rows = document.querySelectorAll('#ptad-view .ptad-rep-row');
    if (!rows.length) return;
    // 이미 우리 행이면 스킵(무한 루프 방지)
    if (rows[0].classList.contains('ptrep-mine')) return;
    var tbl = rows[0].closest('table'); if (!tbl) return;
    var tbody = rows[0].parentNode;

    var by = aggregate();
    var list = Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.cSale - a.cSale; });

    var html = list.map(function (a) {
      var av = (a.rep || '?').slice(0, 1);
      return '<tr class="ptad-click ptad-rep-row ptrep-mine" data-rep="' + esc(a.rep) + '">' +
        '<td><span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#eef1f5;color:#556;font-size:11px;margin-right:6px">' + esc(av) + '</span><b>' + esc(a.rep) + '</b></td>' +
        '<td class="c">' + nk(a.corps) + '</td>' +
        '<td class="c">' + nk(a.actCorps) + '</td>' +
        '<td class="c">' + a.camps + '</td>' +
        '<td class="r"><b>' + f(a.cSale) + '</b></td>' +
        '<td class="r ptad-muted">' + f(a.cSvc) + '</td>' +
        '<td class="r">' + f(a.eSale) + '</td>' +
        '<td class="r ptad-muted">' + f(a.eSvc) + '</td>' +
        '<td class="c"><button class="ptrep-hist" data-rep="' + esc(a.rep) + '" style="font-size:11px;padding:3px 10px;border:1px solid #d7dbe0;border-radius:6px;background:#f4f6fb;cursor:pointer">히스토리</button></td>' +
        '</tr>';
    }).join('');

    tbody.innerHTML = html;

    // 클릭 재바인딩 → 캠페인 기준 상세
    [].slice.call(tbody.querySelectorAll('.ptrep-hist')).forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); openRepDetail(b.getAttribute('data-rep')); };
    });
    [].slice.call(tbody.querySelectorAll('.ptad-rep-row')).forEach(function (tr) {
      tr.onclick = function () { openRepDetail(tr.getAttribute('data-rep')); };
    });
  }

  // ── 담당자 상세 모달(캠페인 기준) ──
  function openRepDetail(rep) {
    var cs = camps().filter(function (c) { return repOf(c) === rep; });
    var tot = { cSale: 0, cSvc: 0, eSale: 0, eSvc: 0 };
    var byCorp = {};
    cs.forEach(function (c) {
      tot.cSale += n(c.contractFinal); tot.cSvc += n(c.contractMktCost);
      tot.eSale += n(c.execTotalAmount); tot.eSvc += n(c.execNetAmount);
      var corp = String(c.corpName || '').trim() || '(법인명 없음)';
      var g = byCorp[corp] || (byCorp[corp] = { corp: corp, camps: 0, cSale: 0, cSvc: 0, eSale: 0, eSvc: 0, last: '' });
      g.camps++; g.cSale += n(c.contractFinal); g.cSvc += n(c.contractMktCost);
      g.eSale += n(c.execTotalAmount); g.eSvc += n(c.execNetAmount);
      var dt = String(c.createdAt || '').slice(0, 10); if (dt > g.last) g.last = dt;
    });
    var corps = Object.keys(byCorp).map(function (k) { return byCorp[k]; }).sort(function (a, b) { return b.cSale - a.cSale; });

    var head = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
      '<div><div style="font-size:12px;color:#888">영업 담당자 (캠페인 기준)</div>' +
      '<div style="font-size:20px;font-weight:700">' + esc(rep) + ' <span style="font-size:13px;color:#888">(총 ' + cs.length + '건 · 광고주 ' + corps.length + '곳)</span></div></div></div>';
    var kpis = '<div style="display:flex;gap:10px;margin:10px 0;flex-wrap:wrap">' +
      kbox('(계약) 전체', tot.cSale) + kbox('(계약) 서비스', tot.cSvc) + kbox('(실행) 전체', tot.eSale) + kbox('(실행) 서비스', tot.eSvc) + '</div>';
    var rowsH = corps.map(function (g) {
      return '<tr><td><b>' + esc(g.corp) + '</b></td><td class="c">' + g.camps + '</td><td class="c ptad-muted">' + esc(g.last) + '</td>' +
        '<td class="r"><b>' + f(g.cSale) + '</b></td><td class="r ptad-muted">' + f(g.cSvc) + '</td><td class="r">' + f(g.eSale) + '</td><td class="r ptad-muted">' + f(g.eSvc) + '</td></tr>';
    }).join('');
    var table = '<div style="overflow:auto;max-height:52vh"><table class="ptad-tbl" style="width:100%"><thead><tr>' +
      '<th>법인명</th><th class="c">캠페인</th><th class="c">최근</th><th class="r">계약 전체</th><th class="r">계약 서비스</th><th class="r">실행 전체</th><th class="r">실행 서비스</th>' +
      '</tr></thead><tbody>' + rowsH + '</tbody></table></div>';
    var closeBtn = '<div style="text-align:right;margin-top:10px"><button data-ptrep-close style="padding:6px 16px;border:1px solid #d7dbe0;border-radius:6px;background:#fff;cursor:pointer">닫기</button></div>';

    showMy(head + kpis + table + closeBtn);
  }
  function kbox(l, v) {
    return '<div style="flex:1;min-width:140px;background:#f7f8fb;border:1px solid #eceef2;border-radius:10px;padding:10px 12px">' +
      '<div style="font-size:11px;color:#888">' + esc(l) + '</div><div style="font-size:17px;font-weight:700">' + f(v) + '</div></div>';
  }
  function showMy(html) {
    var modal = document.getElementById('ptad-modal'), ov = document.getElementById('ptad-overlay');
    if (!modal || !ov) return;
    modal.innerHTML = html;
    ov.classList.add('open');
    [].slice.call(modal.querySelectorAll('[data-ptrep-close]')).forEach(function (b) { b.onclick = function () { ov.classList.remove('open'); }; });
  }

  // ── rep 뷰가 렌더될 때마다 재적용 ──
  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(function () { try { rebuildTable(); } catch (e) {} }, 120); }
  function start() {
    var host = document.getElementById('tab-advmgr') || document.body;
    try { new MutationObserver(schedule).observe(host, { childList: true, subtree: true }); } catch (e) {}
    schedule();
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
