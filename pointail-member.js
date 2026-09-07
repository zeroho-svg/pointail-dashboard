/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 👥 회원관리 모듈 v1 (pointail-member.js)
 *
 *  상위 탭 「👥 회원관리」 — 신규회원 가입 추이 + 활성화(가입→캠페인 진행) 분석.
 *  목적: 가입만 하는지/활성화가 잘 되는지 확인해 온보딩 집중 대상을 찾는다.
 *   · KPI: 오늘·이번달 신규(전월비) · 전체 활성화율 · 온보딩 필요 인원
 *   · 신규회원 추이: 일별(월 선택)/월별/연도별 막대 + CSV
 *   · 활성화 분석: 가입월 코호트 — 가입/진행/미진행/활성화율/첫 캠페인까지 평균일
 *   · 온보딩 필요 회원: 가입 후 캠페인 미진행 리스트(경과일 3단계 배지) + CSV
 *  데이터: DB.member(joinDate·company·salesRep·accountStatus) ↔ DB.camp(corpName)
 *  법인명 정규화 매칭(광고주 관리와 동일 방식). ※ 유입경로 항목은 어드민에 추후
 *  개발 예정이라 이 버전에서는 다루지 않는다(사용자 확정 2026-09-07).
 *  내비 배치는 pointail-nav.js v5의 member 그룹이 흡수. 원본 index.html 무수정(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MV = { view: 'day', selMonth: null, obWin: 90 };

  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s]/g, '')) || 0; }
  function f(v) { return Math.round(n(v)).toLocaleString('ko-KR'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function d10(s) { return String(s || '').slice(0, 10); }
  function todayStr() { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); }
  function norm(s) { return String(s || '').replace(/주식회사|\(주\)|㈜|株式会社|合同会社|有限会社|\s+/g, '').toLowerCase(); }
  function members() { return (typeof DB !== 'undefined' && DB && DB.member) ? DB.member : []; }
  function camps() { return (typeof DB !== 'undefined' && DB && DB.camp) ? DB.camp : []; }
  function dayDiff(a, b) { var x = Date.parse(a), y = Date.parse(b); return (isFinite(x) && isFinite(y)) ? Math.round((y - x) / 86400000) : null; }

  /* ── 회원 ↔ 캠페인 매칭 (법인명 정규화) ── */
  function build() {
    var byCorp = {};                                   // normCorp → 정렬된 캠페인 오픈일 배열
    camps().forEach(function (c) {
      if (['캠페인 취소', '등록 취소'].indexOf(c.campaignStatus) >= 0) return;
      var k = norm(c.corpName); if (!k) return;
      var d = d10(c.realStartAt) || d10(c.recruitStartAt) || d10(c.createdAt); if (!d) return;
      (byCorp[k] = byCorp[k] || []).push(d);
    });
    Object.keys(byCorp).forEach(function (k) { byCorp[k].sort(); });

    var rows = [];
    members().forEach(function (m) {
      var jd = d10(m.joinDate); if (!jd) return;
      var k = norm(m.company);
      var dates = (k && byCorp[k]) || null;
      var firstAfter = null;
      if (dates) for (var i = 0; i < dates.length; i++) { if (dates[i] >= jd) { firstAfter = dates[i]; break; } }
      rows.push({
        join: jd, company: String(m.company || '').trim() || String(m.memberName || '').trim() || '(미상)',
        rep: String(m.salesRep || '미배정').trim() || '미배정',
        state: String(m.accountStatus || ''),
        activated: !!(dates && dates.length),
        days: firstAfter ? dayDiff(jd, firstAfter) : null
      });
    });
    return rows;
  }

  /* ── 렌더 ── */
  function bar(pct, col) {
    return '<div style="height:7px;border-radius:5px;background:#eceff3;position:relative;min-width:90px;max-width:200px">' +
      '<div style="position:absolute;left:0;top:0;height:7px;width:' + Math.min(100, pct) + '%;border-radius:5px;background:' + col + '"></div></div>' +
      '<span style="font-size:11px;font-weight:700;color:' + col + '">' + pct + '%</span>';
  }
  function pill(on, label, onclick) {
    return '<button onclick="' + onclick + '" style="font-size:11.5px;font-weight:700;padding:4px 12px;border-radius:8px;cursor:pointer;' +
      (on ? 'background:#111827;color:#fff;border:1.5px solid #111827' : 'background:#fff;border:1.5px solid #e5e8ee;color:#667085') + '">' + label + '</button>';
  }
  function kpiCard(icon, label, valHtml, sub, color) {
    return '<div style="flex:1;min-width:175px;background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px">' +
      '<div style="font-size:12px;color:#8a94a6">' + icon + ' ' + label + '</div>' +
      '<div style="font-size:23px;font-weight:700;margin-top:3px;color:' + (color || '#1a1f29') + '">' + valHtml + '</div>' +
      '<div style="font-size:11.5px;color:#8a94a6;margin-top:3px">' + sub + '</div></div>';
  }

  function render() {
    var host = document.getElementById('tab-member'); if (!host) return;
    var rows = build();
    if (!rows.length) {
      host.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#8a94a6"><div style="font-size:34px;margin-bottom:10px">👥</div><div style="font-size:14px">데이터 로드 후 표시됩니다. 상단 <b>⚡ API 동기화</b>를 눌러주세요.</div></div>';
      return;
    }
    var today = todayStr(), thisM = today.slice(0, 7), thisY = today.slice(0, 4);
    var pv = new Date(); pv.setDate(1); pv.setMonth(pv.getMonth() - 1);
    var prevM = pv.getFullYear() + '-' + ('0' + (pv.getMonth() + 1)).slice(-2);

    var todayNew = 0, monthNew = 0, prevNew = 0, act = 0, obAll = [];
    rows.forEach(function (r) {
      if (r.join === today) todayNew++;
      if (r.join.slice(0, 7) === thisM) monthNew++;
      if (r.join.slice(0, 7) === prevM) prevNew++;
      if (r.activated) act++;
      else if (r.state !== '탈퇴') obAll.push(r);
    });
    var rate = rows.length ? Math.round(act / rows.length * 100) : 0;
    var momTxt = prevNew > 0 ? ('전월 ' + f(prevNew) + '명 <span style="color:' + (monthNew >= prevNew ? '#128a3a' : '#c0392b') + ';font-weight:600">' + (monthNew >= prevNew ? '▲' : '▼') + Math.abs(Math.round((monthNew - prevNew) / prevNew * 100)) + '%</span> (진행 중)') : '전월 데이터 없음';

    /* 추이 집계 */
    var byDay = {}, byMonth = {}, byYear = {};
    rows.forEach(function (r) {
      byDay[r.join] = (byDay[r.join] || 0) + 1;
      var mk = r.join.slice(0, 7); byMonth[mk] = (byMonth[mk] || 0) + 1;
      var yk = r.join.slice(0, 4); byYear[yk] = (byYear[yk] || 0) + 1;
    });
    var monthList = Object.keys(byMonth).sort().reverse();
    if (MV.view === 'day' && (!MV.selMonth || monthList.indexOf(MV.selMonth) < 0)) MV.selMonth = monthList[0] || null;

    var keys, src, labFn;
    if (MV.view === 'day') {
      src = byDay;
      keys = Object.keys(byDay).filter(function (k) { return k.slice(0, 7) === MV.selMonth; }).sort();
      labFn = function (k) { return parseInt(k.slice(8, 10), 10); };
    } else if (MV.view === 'month') {
      src = byMonth; keys = Object.keys(byMonth).sort().slice(-24);
      labFn = function (k) { return k.slice(2).replace('-', '.'); };
    } else {
      src = byYear; keys = Object.keys(byYear).sort();
      labFn = function (k) { return k; };
    }
    var maxV = 1; keys.forEach(function (k) { maxV = Math.max(maxV, src[k]); });
    var bars = keys.map(function (k) {
      var v = src[k], h = Math.max(v ? 4 : 0, Math.round(v / maxV * 120));
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0" title="' + esc(k) + ' · ' + f(v) + '명">' +
        '<div style="font-size:9px;color:#8a94a6;line-height:1">' + (v || '') + '</div>' +
        '<div style="display:flex;align-items:flex-end;height:120px"><div style="width:70%;min-width:5px;max-width:26px;height:' + h + 'px;background:#3778c2;opacity:.85;border-radius:3px 3px 0 0"></div></div>' +
        '<div style="font-size:9.5px;color:#8a94a6;border-top:1px solid #eef0f3;width:100%;text-align:center;padding-top:2px;white-space:nowrap;overflow:hidden">' + labFn(k) + '</div></div>';
    }).join('');
    var monthPills = MV.view === 'day'
      ? '<div style="display:flex;gap:5px;overflow-x:auto;padding-bottom:6px;margin-bottom:4px">' + monthList.slice(0, 18).map(function (m) {
          return '<button onclick="window.PTMEM&&PTMEM.month(\'' + m + '\')" style="font-size:11px;padding:3px 10px;border-radius:99px;cursor:pointer;white-space:nowrap;flex:0 0 auto;' + (m === MV.selMonth ? 'background:#111827;color:#fff;border:1px solid #111827' : 'background:#fff;border:1px solid #e5e8ee;color:#667085') + '">' + m.replace('-', '.') + '</button>';
        }).join('') + '</div>' : '';

    /* 활성화 코호트 (최근 12개월) */
    var coh = {};
    rows.forEach(function (r) {
      var mk = r.join.slice(0, 7);
      if (!coh[mk]) coh[mk] = { join: 0, act: 0, dsum: 0, dcnt: 0 };
      coh[mk].join++;
      if (r.activated) { coh[mk].act++; if (r.days != null) { coh[mk].dsum += r.days; coh[mk].dcnt++; } }
    });
    var cohRows = Object.keys(coh).sort().reverse().slice(0, 12).map(function (mk) {
      var c = coh[mk], pct = Math.round(c.act / c.join * 100);
      var col = pct >= 70 ? '#128a3a' : '#b45309';
      var avg = c.dcnt ? Math.round(c.dsum / c.dcnt) : null;
      return '<tr>' +
        '<td style="text-align:left;font-weight:700">' + mk.replace('-', '.') + '</td>' +
        '<td>' + f(c.join) + '명</td>' +
        '<td style="color:#128a3a;font-weight:700">' + f(c.act) + '명</td>' +
        '<td style="color:#c0392b;font-weight:700">' + f(c.join - c.act) + '명</td>' +
        '<td style="text-align:left"><div style="display:flex;align-items:center;gap:7px">' + bar(pct, col) + '</div></td>' +
        '<td>' + (avg != null ? avg + '일' : '–') + '</td></tr>';
    }).join('');

    /* 온보딩 리스트 */
    var obs = obAll.filter(function (r) {
      if (!MV.obWin) return true;
      var d = dayDiff(r.join, today); return d != null && d <= MV.obWin;
    }).map(function (r) { r.elapsed = dayDiff(r.join, today) || 0; return r; })
      .sort(function (a, b) { return b.elapsed - a.elapsed; });
    function stageBadge(d) {
      if (d > 45) return '<span style="font-size:10.5px;padding:2px 8px;border-radius:20px;background:#fceaea;color:#c0392b;font-weight:700">🚨 장기 미진행 — 연락 필요</span>';
      if (d >= 14) return '<span style="font-size:10.5px;padding:2px 8px;border-radius:20px;background:#fef3e2;color:#b45309;font-weight:700">💬 재안내 대상</span>';
      return '<span style="font-size:10.5px;padding:2px 8px;border-radius:20px;background:#e6f1fb;color:#185fa5;font-weight:700">🌱 신규 — 온보딩 진행 중</span>';
    }
    var obRows = obs.map(function (r) {
      return '<tr onclick="window.PTMEM&&PTMEM.goAdv()" style="cursor:pointer">' +
        '<td style="text-align:left;font-weight:600">' + esc(r.company) + '</td>' +
        '<td>' + esc(r.join) + '</td>' +
        '<td style="font-weight:700;color:' + (r.elapsed > 45 ? '#c0392b' : (r.elapsed >= 14 ? '#b45309' : '#48505c')) + '">' + r.elapsed + '일</td>' +
        '<td>' + esc(r.rep) + '</td>' +
        '<td>' + esc(r.state) + '</td>' +
        '<td style="text-align:left">' + stageBadge(r.elapsed) + '</td></tr>';
    }).join('');

    var TH = 'background:#f7f8fa;color:#667085;font-size:11.5px;padding:7px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid #e5e8ee';
    var TD = 'font-size:12px;padding:7px 10px;text-align:right;border-bottom:1px solid #f2f4f7;white-space:nowrap';

    host.innerHTML =
      '<div style="padding:18px 20px;line-height:1.55">' +
      '<style>#tab-member th{' + TH + '}#tab-member td{' + TD + '}#tab-member th:first-child,#tab-member td:first-child{text-align:left}#tab-member tbody tr:hover td{background:#f7f8fa}</style>' +

      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
        kpiCard('👤', '오늘 신규', f(todayNew) + '<span style="font-size:13px;color:#8a94a6;font-weight:500">명</span>', today, '#185fa5') +
        kpiCard('📅', '이번 달 신규', f(monthNew) + '<span style="font-size:13px;color:#8a94a6;font-weight:500">명</span>', momTxt) +
        kpiCard('⚡', '전체 활성화율', rate + '<span style="font-size:13px;color:#8a94a6;font-weight:500">%</span>', '가입 ' + f(rows.length) + '명 중 ' + f(act) + '명 캠페인 진행', rate >= 70 ? '#128a3a' : '#b45309') +
        kpiCard('🚨', '온보딩 필요', f(obAll.length) + '<span style="font-size:13px;color:#8a94a6;font-weight:500">명</span>', '가입만 하고 캠페인 미진행(탈퇴 제외)', '#c0392b') +
      '</div>' +

      '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px;margin-bottom:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">' +
          '<div style="font-size:13px;font-weight:700">📈 신규회원 추이 <span style="font-size:11px;font-weight:400;color:#8a94a6">가입일 기준</span></div>' +
          '<div style="display:flex;gap:5px">' +
            pill(MV.view === 'day', '일별', 'window.PTMEM&&PTMEM.view(\'day\')') +
            pill(MV.view === 'month', '월별', 'window.PTMEM&&PTMEM.view(\'month\')') +
            pill(MV.view === 'year', '연도별', 'window.PTMEM&&PTMEM.view(\'year\')') +
            '<button onclick="window.PTMEM&&PTMEM.csvTrend()" style="font-size:11.5px;padding:4px 10px;border-radius:8px;background:#fff;border:1px solid #e5e8ee;color:#667085;cursor:pointer">⬇ CSV</button>' +
          '</div></div>' +
        monthPills +
        '<div style="display:flex;align-items:flex-end;gap:3px;overflow-x:auto">' + (bars || '<div style="color:#98a2b3;font-size:12px;padding:20px 0">데이터 없음</div>') + '</div>' +
        (MV.view === 'month' ? '<div style="font-size:10.5px;color:#98a2b3;margin-top:6px">최근 24개월 표시</div>' : '') +
      '</div>' +

      '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px;margin-bottom:12px">' +
        '<div style="font-size:13px;font-weight:700;margin-bottom:4px">⚡ 활성화 분석 — 가입 회원이 실제 캠페인을 진행했는가 <span style="font-size:11px;font-weight:400;color:#8a94a6">(가입월 코호트 · 법인명으로 캠페인 매칭 · 최근 12개월)</span></div>' +
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:720px">' +
          '<thead><tr><th>가입월</th><th>가입</th><th>캠페인 진행</th><th>미진행</th><th style="text-align:left">활성화율</th><th>첫 캠페인까지 평균</th></tr></thead>' +
          '<tbody>' + cohRows + '</tbody></table></div>' +
        '<div style="font-size:10.5px;color:#98a2b3;margin-top:8px">활성화율 70% 미만 = 주황 · 최근 월은 아직 진행 중이라 낮게 시작 → 시간이 지나며 상승하는지 추적 · 3시간마다 자동 동기화</div>' +
      '</div>' +

      '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:8px">' +
          '<div style="font-size:13px;font-weight:700">🚨 온보딩 필요 회원 <span style="font-size:11px;font-weight:400;color:#8a94a6">— 가입 후 캠페인 미진행 · 경과일 긴 순 · ' + f(obs.length) + '명</span></div>' +
          '<div style="display:flex;gap:5px">' +
            pill(MV.obWin === 90, '최근 90일', 'window.PTMEM&&PTMEM.win(90)') +
            pill(MV.obWin === 0, '전체', 'window.PTMEM&&PTMEM.win(0)') +
            '<button onclick="window.PTMEM&&PTMEM.csvOb()" style="font-size:11.5px;padding:4px 10px;border-radius:8px;background:#fff;border:1px solid #e5e8ee;color:#667085;cursor:pointer">⬇ CSV</button>' +
          '</div></div>' +
        '<div style="overflow:auto;max-height:430px"><table style="width:100%;border-collapse:collapse;min-width:720px">' +
          '<thead><tr><th>법인명</th><th>가입일</th><th>경과</th><th>영업담당</th><th>상태</th><th style="text-align:left">온보딩 단계</th></tr></thead>' +
          '<tbody>' + (obRows || '<tr><td colspan="6" style="text-align:center;color:#0f6e56">✅ 해당 기간 온보딩 필요 회원이 없습니다.</td></tr>') + '</tbody></table></div>' +
        '<div style="font-size:10.5px;color:#98a2b3;margin-top:8px">단계: 가입 14일 미만 🌱 신규 / 14~45일 💬 재안내 / 45일 초과 🚨 장기 미진행 · 행 클릭 시 광고주 관리로 이동</div>' +
      '</div>' +
      '</div>';
  }

  /* ── 탭 전환 ── */
  function show() {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (x) { x.classList.remove('active'); });
    var p = document.getElementById('tab-member'); if (p) p.classList.add('active');
    var b = document.getElementById('tab-btn-member'); if (b) b.classList.add('active');
    render();
  }

  function ensure() {
    var nav = document.getElementById('main-tabs'); if (!nav) return;
    if (!document.getElementById('tab-member')) {
      var ref = document.querySelector('.panel');
      if (ref && ref.parentNode) { var p = document.createElement('div'); p.id = 'tab-member'; p.className = 'panel'; ref.parentNode.appendChild(p); }
    }
    if (!document.getElementById('tab-btn-member')) {
      var anyTab = nav.querySelector('.tab');
      var b = document.createElement('button');
      b.id = 'tab-btn-member'; b.className = anyTab ? anyTab.className.replace(' active', '') : 'tab';
      b.textContent = '👥 회원관리'; b.type = 'button';
      b.addEventListener('click', show);
      var tm = nav.querySelector('.tabs-main') || nav;
      tm.appendChild(b);
    }
  }

  if (typeof window.showTab === 'function' && !window.showTab.__ptMem) {
    var _st = window.showTab;
    window.showTab = function () { var b = document.getElementById('tab-btn-member'); if (b) b.classList.remove('active'); return _st.apply(this, arguments); };
    window.showTab.__ptMem = true;
  }

  function csvDownload(name, head, lines) {
    var blob = new Blob(['﻿' + head + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    URL.revokeObjectURL(a.href);
  }

  window.PTMEM = {
    show: show,
    view: function (v) { MV.view = v; render(); },
    month: function (m) { MV.selMonth = m; render(); },
    win: function (w) { MV.obWin = w; render(); },
    goAdv: function () { var b = document.getElementById('tab-btn-advmgr'); if (b) b.click(); },
    csvTrend: function () {
      var byMonth = {};
      build().forEach(function (r) { var mk = r.join.slice(0, 7); byMonth[mk] = (byMonth[mk] || 0) + 1; });
      csvDownload('pointail_신규회원_월별.csv', '월,신규회원',
        Object.keys(byMonth).sort().map(function (k) { return '"' + k + '",' + byMonth[k]; }));
    },
    csvOb: function () {
      var today = todayStr();
      var lines = build().filter(function (r) { return !r.activated && r.state !== '탈퇴'; })
        .map(function (r) { return '"' + r.company.replace(/"/g, '""') + '","' + r.join + '",' + (dayDiff(r.join, today) || 0) + ',"' + r.rep + '","' + r.state + '"'; });
      csvDownload('pointail_온보딩필요회원.csv', '법인명,가입일,경과일,영업담당,상태', lines);
    }
  };

  var t = null;
  function sched() { clearTimeout(t); t = setTimeout(function () { try { ensure(); } catch (e) {} }, 250); }
  function start() {
    try { new MutationObserver(sched).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(function () {
      try {
        ensure();
        var p = document.getElementById('tab-member');
        if (p && p.classList.contains('active')) render();
      } catch (e) {}
    }, 5000);
    ensure();
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
