/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 매출 대시보드 [분기별] 토글 + [월별 매출·이익] 추가
 *  (pointail-monthly.js)
 *
 *  ① [분기별 매출 · 이익] 헤더를 클릭하면 접기/펼치기 (상태는 localStorage 유지)
 *  ② 그 아래 [월별 매출 · 이익] 섹션 신규 추가 (연도 선택 · 1~12월 한 번에)
 *      · 12개월 비교 그래프 : (실행) 전체 매출 · (실행) 마케팅 서비스 매출
 *      · 월별 표            : 캠페인 수 / (계약) 전체·서비스 / (실행) 전체·서비스 / 연간 기여도
 *
 *  집계 기준은 분기별 섹션과 100% 동일한 원본 함수를 그대로 사용한다.
 *      날짜 : sd_date(r)              (연/월 판정)
 *      금액 : sd_val(r,'contractFinal')      → (계약) 전체 매출
 *             sd_val(r,'contractMktCost')    → (계약) 마케팅 서비스 매출
 *             sd_vatIncl(r,'execTotalAmount')→ (실행) 전체 매출
 *             sd_vatIncl(r,'execNetAmount')  → (실행) 마케팅 서비스 매출
 *
 *  ※ index.html 의 DB 는 const 전역이라 window.DB 로는 접근 불가 → bare DB 사용.
 *  원본 index.html 은 수정하지 않는다(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var LSK = 'pt_sec_collapse';
  var MN = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
  var C_EXEC = '#3498db', C_MKT = '#27ae60';
  var C_KR = '#2563eb', C_JP = '#e11d48';   // 한국 / 일본 구분색

  function camps() { return (typeof DB !== 'undefined' && DB && DB.camp) ? DB.camp : []; }
  function members() { return (typeof DB !== 'undefined' && DB && DB.member) ? DB.member : []; }
  // 회원엔 국가 필드가 없어 캠페인 advertiserCountry(법인명 매칭)로 추론, 미매칭은 일본문자 휴리스틱
  function isJpCtry(s) { return /일본|japan|jp/i.test(String(s || '')); }
  function jpText(s) { s = String(s || ''); return /[぀-ヿ㐀-鿿]/.test(s) && !/[가-힣]/.test(s); }
  function memberCountryMap() {
    var byCorp = {};
    camps().forEach(function (c) {
      var co = String(c.corpName == null ? '' : c.corpName).trim(); if (!co) return;
      var g = byCorp[co] || (byCorp[co] = { KR: 0, JP: 0 });
      if (isJpCtry(c.advertiserCountry)) g.JP++; else g.KR++;
    });
    return function countryOf(m) {
      var co = String(m.company == null ? '' : m.company).trim();
      var g = co ? byCorp[co] : null;
      if (g) return g.JP > g.KR ? 'JP' : 'KR';
      return jpText(co) ? 'JP' : 'KR';
    };
  }
  function sdDate(r) { try { return (typeof sd_date === 'function') ? (sd_date(r) || '') : String(r.createdAt || '').slice(0, 10); } catch (e) { return ''; } }
  function sdVal(r, k) { try { return (typeof sd_val === 'function') ? sd_val(r, k) : (parseFloat(String(r[k] || 0).replace(/[,\s]/g, '')) || 0); } catch (e) { return 0; } }
  function sdVat(r, k) { try { return (typeof sd_vatIncl === 'function') ? sd_vatIncl(r, k) : sdVal(r, k); } catch (e) { return 0; } }

  function f(v) { return Math.round(v || 0).toLocaleString('ko-KR'); }
  function comp(v) {
    v = Math.round(v || 0);
    if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
    if (v >= 10000) return Math.round(v / 10000).toLocaleString('ko-KR') + '만';
    return v.toLocaleString('ko-KR');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }

  // ── 접힘 상태 ──
  function stGet() { try { return JSON.parse(localStorage.getItem(LSK) || '{}'); } catch (e) { return {}; } }
  function stSet(k, v) { var s = stGet(); s[k] = v; try { localStorage.setItem(LSK, JSON.stringify(s)); } catch (e) {} }

  // ── ① 분기별 섹션 토글 ──
  function wireQuarterToggle() {
    var sec = document.getElementById('sd-quarterly-section');
    if (!sec) return;
    var badge = sec.previousElementSibling;
    if (!badge || badge.__ptTgl) return;
    badge.__ptTgl = true;
    badge.style.cursor = 'pointer';
    badge.title = '클릭하면 접기 / 펼치기';
    var ind = document.createElement('span');
    ind.style.marginLeft = '6px';
    ind.style.fontSize = '11px';
    badge.appendChild(ind);
    function apply() {
      var c = stGet().q === true;
      sec.style.display = c ? 'none' : '';
      ind.textContent = c ? '▶' : '▼';
    }
    badge.addEventListener('click', function () { stSet('q', !(stGet().q === true)); apply(); });
    apply();
  }

  // ── ② 월별 섹션 ──
  function ensureMonthly() {
    var qsec = document.getElementById('sd-quarterly-section');
    if (!qsec || !qsec.parentNode) return;
    if (document.getElementById('ptm-section')) { render(); return; }

    var qbadge = qsec.previousElementSibling;
    var badge = qbadge ? qbadge.cloneNode(true) : document.createElement('div');
    badge.id = 'ptm-badge';
    badge.removeAttribute('style');
    if (qbadge) badge.setAttribute('style', qbadge.getAttribute('style') || '');
    badge.textContent = '[월별 매출 · 이익]';
    badge.style.cursor = 'pointer';
    badge.style.marginTop = '18px';
    badge.title = '클릭하면 접기 / 펼치기';
    var ind = document.createElement('span');
    ind.id = 'ptm-ind';
    ind.style.marginLeft = '6px';
    ind.style.fontSize = '11px';
    badge.appendChild(ind);

    var sec = document.createElement('div');
    sec.id = 'ptm-section';

    qsec.parentNode.insertBefore(badge, qsec.nextSibling);
    qsec.parentNode.insertBefore(sec, badge.nextSibling);

    badge.addEventListener('click', function () { stSet('m', !(stGet().m === true)); applyM(); });
    render();
    applyM();
  }
  function applyM() {
    var sec = document.getElementById('ptm-section'), ind = document.getElementById('ptm-ind');
    if (!sec) return;
    var c = stGet().m === true;
    sec.style.display = c ? 'none' : '';
    if (ind) ind.textContent = c ? '▶' : '▼';
  }

  function render() {
    var sec = document.getElementById('ptm-section');
    if (!sec) return;
    var rows = camps();

    var years = [];
    var seen = {};
    rows.forEach(function (r) { var d = sdDate(r); if (d) { var y = d.slice(0, 4); if (!seen[y]) { seen[y] = 1; years.push(y); } } });
    years.sort().reverse();
    if (!years.length) years = [String(new Date().getFullYear())];

    var selEl = document.getElementById('ptm-year');
    var qy = document.getElementById('sd-qt-year');
    var year = (selEl && selEl.value) ? selEl.value : ((qy && qy.value) ? qy.value : years[0]);
    if (years.indexOf(year) < 0) year = years[0];

    var mem = members();
    var sig = rows.length + '|' + mem.length + '|' + year;
    if (sec.__sig === sig) return;        // 데이터·연도 동일하면 재렌더 생략
    sec.__sig = sig;

    // 광고주(회원) 신규 가입 / 누적 (국가별) — 가입일(joinDate) 기준
    var ctryOf = memberCountryMap();
    var newKR = [], newJP = [], i2;
    for (i2 = 0; i2 < 12; i2++) { newKR.push(0); newJP.push(0); }
    var baseKR = 0, baseJP = 0;   // 선택연도 이전까지 누적
    mem.forEach(function (m) {
      var d = String(m.joinDate || '').slice(0, 10); if (!d) return;
      var y = d.slice(0, 4), isJP = ctryOf(m) === 'JP';
      if (y < year) { if (isJP) baseJP++; else baseKR++; return; }
      if (y !== year) return;
      var mi = parseInt(d.slice(5, 7), 10) - 1; if (!(mi >= 0 && mi < 12)) return;
      if (isJP) newJP[mi]++; else newKR[mi]++;
    });
    var cumKR = [], cumJP = [], ck = baseKR, cj = baseJP;
    for (i2 = 0; i2 < 12; i2++) { ck += newKR[i2]; cj += newJP[i2]; cumKR.push(ck); cumJP.push(cj); }
    var newTotY = 0; for (i2 = 0; i2 < 12; i2++) newTotY += newKR[i2] + newJP[i2];

    // 월별 집계 (분기별과 동일 지표)
    var M = [], i;
    for (i = 0; i < 12; i++) M.push({ cnt: 0, kr: 0, jp: 0, cRev: 0, cMkt: 0, eRev: 0, eMkt: 0 });
    var yt = { cnt: 0, kr: 0, jp: 0, cRev: 0, cMkt: 0, eRev: 0, eMkt: 0 };
    rows.forEach(function (r) {
      var d = sdDate(r);
      if (!d || d.slice(0, 4) !== year) return;
      var mi = parseInt(d.slice(5, 7), 10) - 1;
      if (!(mi >= 0 && mi < 12)) return;
      var a = sdVal(r, 'contractFinal'), b = sdVal(r, 'contractMktCost'),
          c = sdVat(r, 'execTotalAmount'), e = sdVat(r, 'execNetAmount');
      var ctry = String(r.advertiserCountry == null ? '' : r.advertiserCountry).trim();
      var isJP = /일본|japan|jp/i.test(ctry);
      var m = M[mi];
      m.cnt++; m.cRev += a; m.cMkt += b; m.eRev += c; m.eMkt += e;
      yt.cnt++; yt.cRev += a; yt.cMkt += b; yt.eRev += c; yt.eMkt += e;
      if (isJP) { m.jp++; yt.jp++; } else { m.kr++; yt.kr++; }
    });

    var maxV = 1;
    for (i = 0; i < 12; i++) { if (M[i].eRev > maxV) maxV = M[i].eRev; if (M[i].eMkt > maxV) maxV = M[i].eMkt; }
    var pct = function (p, t) { return t > 0 ? Math.round(p / t * 100) : 0; };

    var yearOpts = years.map(function (y) {
      return '<option value="' + esc(y) + '"' + (y === year ? ' selected' : '') + '>' + esc(y) + '년</option>';
    }).join('');

    // 헤더 (연도 선택 + 연간 합계)
    var head =
      '<div style="padding:10px 14px;background:var(--bg2);border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<span style="font-size:11px;font-weight:600;color:var(--tx2)">연도</span>' +
          '<select id="ptm-year" style="font-size:13px;font-weight:700;padding:4px 10px;border:1px solid var(--bd2);border-radius:var(--r);background:var(--bg);color:var(--tx);cursor:pointer">' + yearOpts + '</select>' +
          '<span style="font-size:11px;color:var(--tx2)">캠페인 <b style="color:var(--tx)">' + f(yt.cnt) + '</b>건</span>' +
          '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#eef2ff;color:' + C_KR + ';font-weight:600">🇰🇷 한국 ' + f(yt.kr) + '</span>' +
          '<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:#fff1f2;color:' + C_JP + ';font-weight:600">🇯🇵 일본 ' + f(yt.jp) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:10px;color:var(--tx2)">' +
          '<span>연간 (계약) 전체 매출<br><b style="font-size:12px;color:var(--tx)">' + f(yt.cRev) + '</b>원</span>' +
          '<span>연간 (계약) 마케팅 서비스 매출<br><b style="font-size:12px;color:var(--tx)">' + f(yt.cMkt) + '</b>원</span>' +
          '<span>연간 (실행) 전체 매출<br><b style="font-size:12px;color:var(--tx)">' + f(yt.eRev) + '</b>원</span>' +
          '<span>연간 (실행) 마케팅 서비스 매출<br><b style="font-size:12px;color:var(--tx)">' + f(yt.eMkt) + '</b>원</span>' +
        '</div>' +
      '</div>';

    // 12개월 그래프
    var bars = '';
    for (i = 0; i < 12; i++) {
      var m = M[i];
      var h1 = Math.max(m.eRev > 0 ? 3 : 0, Math.round(m.eRev / maxV * 110));
      var h2 = Math.max(m.eMkt > 0 ? 3 : 0, Math.round(m.eMkt / maxV * 110));
      bars +=
        '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">' +
          '<div style="font-size:9px;color:var(--tx2);white-space:nowrap">' + (m.eRev > 0 ? comp(m.eRev) : '') + '</div>' +
          '<div style="display:flex;align-items:flex-end;gap:3px;height:112px">' +
            '<div title="(실행) 전체 매출 ' + f(m.eRev) + '원" style="width:13px;height:' + h1 + 'px;background:' + C_EXEC + ';opacity:.85;border-radius:3px 3px 0 0"></div>' +
            '<div title="(실행) 마케팅 서비스 매출 ' + f(m.eMkt) + '원" style="width:13px;height:' + h2 + 'px;background:' + C_MKT + ';opacity:.85;border-radius:3px 3px 0 0"></div>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--tx2);border-top:1px solid var(--bd);width:100%;text-align:center;padding-top:4px">' + MN[i] + '</div>' +
        '</div>';
    }
    var chart =
      '<div style="padding:14px">' +
        '<div style="font-size:10px;color:var(--tx2);margin-bottom:10px;font-weight:500">' + esc(year) + '년 월별 비교 — (실행) 전체 매출 · (실행) 마케팅 서비스 매출</div>' +
        '<div style="display:flex;align-items:flex-end;gap:6px">' + bars + '</div>' +
        '<div style="display:flex;gap:14px;margin-top:10px;font-size:10px;color:var(--tx2)">' +
          '<span><i style="display:inline-block;width:9px;height:9px;background:' + C_EXEC + ';border-radius:2px;margin-right:4px"></i>(실행) 전체 매출</span>' +
          '<span><i style="display:inline-block;width:9px;height:9px;background:' + C_MKT + ';border-radius:2px;margin-right:4px"></i>(실행) 마케팅 서비스 매출</span>' +
        '</div>' +
      '</div>';

    // 월별 표
    var trs = '';
    for (i = 0; i < 12; i++) {
      var m2 = M[i];
      var zero = m2.cnt === 0;
      trs +=
        '<tr style="border-top:1px solid var(--bd)' + (zero ? ';opacity:.45' : '') + '">' +
          '<td style="padding:7px 10px;font-weight:600;white-space:nowrap">' + esc(year.slice(2)) + '년 ' + (i + 1) + '월</td>' +
          '<td style="padding:7px 10px;text-align:center;color:' + C_KR + '">' + f(cumKR[i]) + '</td>' +
          '<td style="padding:7px 10px;text-align:center;color:' + C_JP + '">' + f(cumJP[i]) + '</td>' +
          '<td style="padding:7px 10px;text-align:center;font-weight:600">' + ((newKR[i] + newJP[i]) ? ('+' + f(newKR[i] + newJP[i]) + ' <span style="font-size:10px;font-weight:400;color:var(--tx2)">(🇰🇷' + newKR[i] + ' 🇯🇵' + newJP[i] + ')</span>') : '-') + '</td>' +
          '<td style="padding:7px 10px;text-align:center;border-left:1px solid var(--bd);font-weight:600">' + f(m2.cnt) + '</td>' +
          '<td style="padding:7px 10px;text-align:center;color:' + C_KR + '">' + (m2.kr ? f(m2.kr) : '-') + '</td>' +
          '<td style="padding:7px 10px;text-align:center;color:' + C_JP + '">' + (m2.jp ? f(m2.jp) : '-') + '</td>' +
          '<td style="padding:7px 10px;text-align:right;font-weight:600">' + f(m2.cRev) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;color:var(--tx2)">' + f(m2.cMkt) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;font-weight:600;color:' + C_EXEC + '">' + f(m2.eRev) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;color:' + C_MKT + '">' + f(m2.eMkt) + '</td>' +
          '<td style="padding:7px 10px;text-align:right;color:var(--tx2)">' + pct(m2.eRev, yt.eRev) + '%</td>' +
        '</tr>';
    }
    var table =
      '<div style="overflow:auto;border-top:1px solid var(--bd)">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
          '<thead><tr style="background:var(--bg2);font-size:11px;color:var(--tx2)">' +
            '<th style="padding:8px 10px;text-align:left">월</th>' +
            '<th style="padding:8px 10px;text-align:center;color:' + C_KR + '">누적 광고주<br>🇰🇷 한국</th>' +
            '<th style="padding:8px 10px;text-align:center;color:' + C_JP + '">누적 광고주<br>🇯🇵 일본</th>' +
            '<th style="padding:8px 10px;text-align:center">신규 가입<br>광고주</th>' +
            '<th style="padding:8px 10px;text-align:center;border-left:1px solid var(--bd)">캠페인 합계</th>' +
            '<th style="padding:8px 10px;text-align:center;color:' + C_KR + '">🇰🇷 한국</th>' +
            '<th style="padding:8px 10px;text-align:center;color:' + C_JP + '">🇯🇵 일본</th>' +
            '<th style="padding:8px 10px;text-align:right">(계약) 전체 매출</th>' +
            '<th style="padding:8px 10px;text-align:right">(계약) 마케팅 서비스</th>' +
            '<th style="padding:8px 10px;text-align:right">(실행) 전체 매출</th>' +
            '<th style="padding:8px 10px;text-align:right">(실행) 마케팅 서비스</th>' +
            '<th style="padding:8px 10px;text-align:right">연간 기여도</th>' +
          '</tr></thead><tbody>' + trs +
          '<tr style="border-top:2px solid var(--bd);background:var(--bg2);font-weight:700">' +
            '<td style="padding:8px 10px">' + esc(year.slice(2)) + '년 합계</td>' +
            '<td style="padding:8px 10px;text-align:center;color:' + C_KR + '">' + f(cumKR[11]) + '</td>' +
            '<td style="padding:8px 10px;text-align:center;color:' + C_JP + '">' + f(cumJP[11]) + '</td>' +
            '<td style="padding:8px 10px;text-align:center">+' + f(newTotY) + '</td>' +
            '<td style="padding:8px 10px;text-align:center;border-left:1px solid var(--bd)">' + f(yt.cnt) + '</td>' +
            '<td style="padding:8px 10px;text-align:center;color:' + C_KR + '">' + f(yt.kr) + '</td>' +
            '<td style="padding:8px 10px;text-align:center;color:' + C_JP + '">' + f(yt.jp) + '</td>' +
            '<td style="padding:8px 10px;text-align:right">' + f(yt.cRev) + '</td>' +
            '<td style="padding:8px 10px;text-align:right">' + f(yt.cMkt) + '</td>' +
            '<td style="padding:8px 10px;text-align:right;color:' + C_EXEC + '">' + f(yt.eRev) + '</td>' +
            '<td style="padding:8px 10px;text-align:right;color:' + C_MKT + '">' + f(yt.eMkt) + '</td>' +
            '<td style="padding:8px 10px;text-align:right">100%</td>' +
          '</tr>' +
        '</tbody></table>' +
      '</div>';

    sec.innerHTML =
      '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rl);overflow:hidden">' +
        head + chart + table +
      '</div>';

    var ns = document.getElementById('ptm-year');
    if (ns) ns.addEventListener('change', function () { sec.__sig = null; render(); });
  }

  // ── 렌더 유지(원본 재렌더 대응) ──
  function tick() {
    try { wireQuarterToggle(); } catch (e) {}
    try { ensureMonthly(); } catch (e) {}
  }
  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(tick, 150); }

  function start() {
    var host = document.getElementById('sd-body') || document.body;
    try { new MutationObserver(schedule).observe(host, { childList: true, subtree: true }); } catch (e) {}
    setInterval(tick, 1200);
    tick();
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
