/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 메타성과(마케팅·영업·대표) 모듈  v2  (pointail-marketing.js)
 *
 *  기존 통합 대시보드에 상위 탭 "📊 메타성과" 1개를 추가하고,
 *  그 안에 하위 4탭(📣 마케팅 · 🤝 영업 · 👑 대표 · ✏️ 입력)을 렌더한다.
 *
 *  퍼널: 광고소재(이미지) → 메타 세팅(광고비/노출/클릭) → 리드(유입경로·획득일)
 *        → MQL/SQL/미팅/제안/계약 → 캠페인 매출(캠페인DB corpName 조인).
 *  - 마케팅 KPI: CTR/CPC/CPM/CPL/MQL/QCPL (종료지점=MQL)
 *  - 영업 KPI: MQL→SQL/미팅/제안/계약/계약률/계약매출/리드타임 (종료지점=계약)
 *  - 대표 KPI: ROAS/ROI/CAC/LTV/LTV·CAC/재계약률
 *  매출·서비스비는 캠페인DB(DB.camp) 실현값만 사용(영업 입력 계약금액 미사용).
 *  입력 데이터는 Cloudflare Worker KV(/marketing)에 공유 저장(모든 컴퓨터 반영).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var WORKER = 'https://pointail-api.zeroho.workers.dev';
  var EP = WORKER + '/marketing';
  var LS = 'pt_marketing_v2';

  var REV_FIELDS = [
    { key: 'contractFinal',   label: '계약매출(최종금액)' },
    { key: 'contractMktCost', label: '서비스비용(마케팅비 소계)' },
    { key: 'execTotalAmount', label: '집행 총액(현재까지)' },
    { key: 'contractSaleSum', label: '계약 총액(부가세 포함)' }
  ];

  var DATA = { creatives: [], adsets: [], leads: [], settings: { revenueField: 'contractFinal', marginRate: 70 } };
  var view = 'mkt';       // 하위 탭
  var charts = {};

  // ── 유틸 ──
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s₩¥]/g, '')) || 0; }
  function f(v) { return Math.round(n(v)).toLocaleString('ko-KR'); }
  function won(v) { return f(v) + '원'; }
  function p1(v) { return isFinite(v) ? (Math.round(v * 10) / 10).toLocaleString('ko-KR') : '—'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function d(s) { return String(s || '').slice(0, 10); }
  function camps() { return (typeof DB !== 'undefined' && DB.camp) ? DB.camp : (window.DB && window.DB.camp) || []; }
  function revField() { return (DATA.settings && DATA.settings.revenueField) || 'contractFinal'; }
  function margin() { return (DATA.settings && DATA.settings.marginRate != null ? DATA.settings.marginRate : 70) / 100; }

  function normalize(o) {
    if (!o || typeof o !== 'object') o = {};
    return {
      creatives: Array.isArray(o.creatives) ? o.creatives : [],
      adsets: Array.isArray(o.adsets) ? o.adsets : [],
      leads: Array.isArray(o.leads) ? o.leads : (Array.isArray(o.matches) ? o.matches : []),
      settings: Object.assign({ revenueField: 'contractFinal', marginRate: 70 }, o.settings || {})
    };
  }

  function creOf(id) { return DATA.creatives.filter(function (c) { return c.id === id; })[0] || null; }
  function creName(id) { var c = creOf(id); return c ? c.name : '(소재 없음)'; }
  function asOf(id) { return DATA.adsets.filter(function (a) { return a.id === id; })[0] || null; }
  function leadsOfAdset(id) { return DATA.leads.filter(function (l) { return l.adsetId === id; }); }

  // ── 이미지 압축 썸네일 ──
  function fileToThumb(file, cb) {
    if (!file) { cb(''); return; }
    var rd = new FileReader();
    rd.onload = function () {
      var im = new Image();
      im.onload = function () {
        var mx = 360, sc = Math.min(1, mx / Math.max(im.width, im.height));
        var cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(im.width * sc)); cv.height = Math.max(1, Math.round(im.height * sc));
        try { cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height); cb(cv.toDataURL('image/jpeg', 0.82)); } catch (e) { cb(rd.result); }
      };
      im.onerror = function () { cb(''); }; im.src = rd.result;
    };
    rd.onerror = function () { cb(''); }; rd.readAsDataURL(file);
  }
  function thumb(img, name, size) {
    size = size || 38;
    if (img) return '<img class="ptmk-thumb" data-img="' + esc(img) + '" src="' + esc(img) + '" style="width:' + size + 'px;height:' + size + 'px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;vertical-align:middle;cursor:zoom-in" />';
    var ch = (name || '?').trim().charAt(0) || '?';
    return '<span style="display:inline-flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;border-radius:6px;background:#eef1f5;color:#98a2b3;border:1px solid #e5e7eb;font-size:' + Math.round(size * 0.4) + 'px;vertical-align:middle">' + esc(ch) + '</span>';
  }

  // ── 저장소(KV 공유) ──
  function loadLocal() { try { return normalize(JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) { return normalize({}); } }
  function saveLocal(x) { try { localStorage.setItem(LS, JSON.stringify(x)); } catch (e) {} }
  function pullShared(cb) {
    fetch(EP + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (o) { cb(o && typeof o === 'object' ? normalize(o) : null); })
      .catch(function () { cb(null); });
  }
  function pushShared(x, cb) {
    fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(x) })
      .then(function (r) { cb && cb(r.ok); }).catch(function () { cb && cb(false); });
  }
  function commit(mutator) {
    pullShared(function (shared) {
      var x = normalize(shared || DATA);
      try { mutator(x); } catch (e) {}
      DATA = x; saveLocal(x);
      renderInner();
      pushShared(x, function (ok) { if (!ok) toast('⚠️ 공유 저장 실패(로컬엔 저장됨). 네트워크 확인 후 재시도.'); });
    });
  }
  function toast(msg) {
    var t = document.getElementById('ptmk-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ptmk-toast'; t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:99999;opacity:0;transition:opacity .2s;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:80vw'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; clearTimeout(t._tm); t._tm = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }

  // ── 캠페인DB(corpName) 조인 ──
  function campIdx() {
    var idx = {};
    camps().forEach(function (c) {
      var k = String(c.corpName || '').trim(); if (!k) return;
      var r = idx[k] || (idx[k] = { list: [], rev: 0, svc: 0, count: 0, stores: {} });
      r.list.push(c); r.count++; r.rev += n(c[revField()]); r.svc += n(c.contractMktCost);
      if (c.storeName) r.stores[c.storeName] = 1;
    });
    return idx;
  }

  // ── 지표 계산 ──
  function mktByAdset() {
    return DATA.adsets.map(function (a) {
      var L = leadsOfAdset(a.id);
      var leads = L.length, mql = L.filter(function (x) { return x.mqlYn; }).length;
      var spend = n(a.spend), impr = n(a.impressions), clk = n(a.clicks);
      return { a: a, leads: leads, mql: mql, spend: spend, impr: impr, clk: clk,
        ctr: impr > 0 ? clk / impr * 100 : NaN, cpc: clk > 0 ? spend / clk : NaN, cpm: impr > 0 ? spend / impr * 1000 : NaN,
        cpl: leads > 0 ? spend / leads : NaN, qcpl: mql > 0 ? spend / mql : NaN, mqlRate: leads > 0 ? mql / leads * 100 : NaN };
    });
  }
  function salesFunnel(list) {
    list = list || DATA.leads;
    var mql = list.filter(function (x) { return x.mqlYn; }).length;
    var sql = list.filter(function (x) { return x.sqlYn; }).length;
    var meet = list.filter(function (x) { return x.meetingDate; }).length;
    var prop = list.filter(function (x) { return x.proposalDate; }).length;
    var contract = list.filter(function (x) { return x.contractDate; }).length;
    var idx = campIdx(); var adv = {}; list.forEach(function (x) { if (x.contractDate) adv[x.advertiser] = 1; });
    var advList = Object.keys(adv); var rev = 0, svc = 0;
    advList.forEach(function (a) { var r = idx[a]; if (r) { rev += r.rev; svc += r.svc; } });
    var lt = []; list.forEach(function (x) { if (x.contractDate && x.leadDate) { var days = (new Date(x.contractDate) - new Date(x.leadDate)) / 86400000; if (isFinite(days) && days >= 0) lt.push(days); } });
    return { leads: list.length, mql: mql, sql: sql, meet: meet, prop: prop, contract: contract,
      advCount: advList.length, rev: rev, svc: svc,
      avgLeadTime: lt.length ? lt.reduce(function (s, v) { return s + v; }, 0) / lt.length : NaN,
      mql2sql: mql > 0 ? sql / mql * 100 : NaN, meetRate: sql > 0 ? meet / sql * 100 : NaN, closeRate: sql > 0 ? contract / sql * 100 : NaN,
      avgRev: advList.length > 0 ? rev / advList.length : NaN };
  }
  function execKpi() {
    var totSpend = DATA.adsets.reduce(function (s, a) { return s + n(a.spend); }, 0);
    var fn = salesFunnel(); var idx = campIdx();
    var adv = {}; DATA.leads.forEach(function (l) { if (l.contractDate) adv[l.advertiser] = 1; });
    var advList = Object.keys(adv); var rev = 0, svc = 0, reCount = 0;
    advList.forEach(function (a) { var r = idx[a]; if (r) { rev += r.rev; svc += r.svc; if (r.count > 1) reCount++; } });
    var gp = svc * margin();
    var cac = advList.length > 0 ? totSpend / advList.length : NaN;
    var roas = totSpend > 0 ? rev / totSpend * 100 : NaN;
    var roi = totSpend > 0 ? (gp - totSpend) / totSpend * 100 : NaN;
    var ltv = advList.length > 0 ? rev / advList.length : NaN;
    var ltvCac = (isFinite(cac) && cac > 0) ? ltv / cac : NaN;
    var reRate = advList.length > 0 ? reCount / advList.length * 100 : NaN;
    return { totSpend: totSpend, fn: fn, rev: rev, svc: svc, gp: gp, cac: cac, roas: roas, roi: roi, ltv: ltv, ltvCac: ltvCac, advCount: advList.length, reRate: reRate };
  }

  function kpi(l, v, s, cls) { return '<div class="ptmk-kpi"><div class="ptmk-l">' + esc(l) + '</div><div class="ptmk-v" style="color:' + (cls || '#111') + '">' + v + '</div>' + (s ? '<div class="ptmk-s">' + s + '</div>' : '') + '</div>'; }

  // ══════════ 하위 탭 렌더 ══════════
  function renderInner() {
    var host = document.getElementById('ptmk-view'); if (!host) return;
    document.getElementById('ptmk-assume').innerHTML = 'ℹ️ <b>계산 가정</b> — 매출·서비스비는 <b>캠페인DB(법인명 조인) 실현값만</b> 사용 · 매출총이익 = 서비스비 × ' + (margin() * 100) + '% · ROI = (매출총이익−광고비)÷광고비 · CAC = 광고비÷계약광고주 · LTV = 계약매출÷계약광고주 · 계약률 = 계약÷SQL · 재계약률 = 캠페인 2건+ 광고주 비율.';
    if (view === 'mkt') { host.innerHTML = renderMkt(); drawMktCharts(); }
    else if (view === 'sales') { host.innerHTML = renderSales(); drawFunnel('ptmk-sales-funnel', salesFunnelData()); }
    else if (view === 'exec') { host.innerHTML = renderExec(); drawFunnel('ptmk-exec-funnel', execFunnelData()); }
    else { host.innerHTML = renderInput(); wireInput(); }
  }

  function renderMkt() {
    var rows = mktByAdset();
    var tot = { spend: 0, impr: 0, clk: 0, leads: 0, mql: 0 };
    rows.forEach(function (r) { tot.spend += r.spend; tot.impr += r.impr; tot.clk += r.clk; tot.leads += r.leads; tot.mql += r.mql; });
    var ctr = tot.impr > 0 ? tot.clk / tot.impr * 100 : NaN, cpc = tot.clk > 0 ? tot.spend / tot.clk : NaN, cpm = tot.impr > 0 ? tot.spend / tot.impr * 1000 : NaN;
    var cpl = tot.leads > 0 ? tot.spend / tot.leads : NaN, qcpl = tot.mql > 0 ? tot.spend / tot.mql : NaN, mqlRate = tot.leads > 0 ? tot.mql / tot.leads * 100 : NaN;
    var unattr = DATA.leads.filter(function (l) { return !l.adsetId; }); var unMql = unattr.filter(function (l) { return l.mqlYn; }).length;
    var cards = '<div class="ptmk-sec">운영지표</div><div class="ptmk-cards">' +
      kpi('광고비', won(tot.spend)) + kpi('노출', f(tot.impr)) + kpi('클릭', f(tot.clk)) +
      kpi('CTR', p1(ctr) + '%') + kpi('CPC', won(cpc)) + kpi('CPM', won(cpm)) + '</div>' +
      '<div class="ptmk-sec">리드 KPI (마케팅 종료지점 = MQL · 메타 귀속분만 CPL/QCPL)</div><div class="ptmk-cards">' +
      kpi('메타 귀속 리드', tot.leads + '건') + kpi('CPL', won(cpl)) + kpi('MQL', tot.mql + '건', null, '#128a3a') +
      kpi('MQL 전환율', p1(mqlRate) + '%') + kpi('QCPL(MQL당)', won(qcpl)) + kpi('미귀속 리드', unattr.length + '건', unMql + ' MQL · 사이트상담 등') + '</div>';
    var chartsH = '<div style="display:flex;gap:12px;flex-wrap:wrap"><div class="ptmk-card" style="flex:1;min-width:320px"><h3>세팅별 광고비 vs MQL</h3><div style="height:250px"><canvas id="ptmk-mc1"></canvas></div></div>' +
      '<div class="ptmk-card" style="flex:1;min-width:320px"><h3>세팅별 QCPL(MQL당 비용)</h3><div style="height:250px"><canvas id="ptmk-mc2"></canvas></div></div></div>';
    var tbl = '<div class="ptmk-card"><h3>세팅별 성과</h3><div style="overflow:auto"><table class="ptmk-tbl"><thead><tr>' +
      '<th>소재</th><th>메타 세팅</th><th class="r">광고비</th><th class="r">노출</th><th class="r">클릭</th><th class="r">CTR</th><th class="r">CPC</th><th class="c">리드</th><th class="r">CPL</th><th class="c">MQL</th><th class="r">QCPL</th></tr></thead><tbody>' +
      (rows.length ? rows.sort(function (x, y) { return y.mql - x.mql; }).map(function (r) { var c = creOf(r.a.creativeId);
        return '<tr><td><div style="display:flex;align-items:center;gap:6px">' + thumb(c && c.img, c && c.name, 32) + '<span>' + esc(c ? c.name : '-') + '</span></div></td>' +
          '<td><b>' + esc(r.a.name) + '</b><div style="font-size:11px;color:#aab">' + esc(r.a.period || '') + '</div></td>' +
          '<td class="r">' + f(r.spend) + '</td><td class="r">' + f(r.impr) + '</td><td class="r">' + f(r.clk) + '</td>' +
          '<td class="r">' + p1(r.ctr) + '%</td><td class="r">' + f(r.cpc) + '</td><td class="c">' + r.leads + '</td><td class="r">' + f(r.cpl) + '</td>' +
          '<td class="c" style="color:#128a3a">' + r.mql + '</td><td class="r">' + f(r.qcpl) + '</td></tr>';
      }).join('') : '<tr><td colspan="11" style="text-align:center;color:#aab;padding:14px">입력 탭에서 소재·세팅을 추가하세요.</td></tr>') + '</tbody></table></div></div>';
    return cards + chartsH + tbl + '<div class="ptmk-card" style="color:#889;font-size:12px">📌 마케팅팀 평가는 <b>MQL 확보 효율(QCPL·MQL전환율)</b> 기준. 병목: CTR↓→소재개선 · CPL↑→타겟개선 · MQL율↓→타겟수정.</div>';
  }
  function drawMktCharts() {
    var rows = mktByAdset(); var labels = rows.map(function (r) { return r.a.name; });
    mkBar('ptmk-mc1', labels, [{ label: '광고비', data: rows.map(function (r) { return r.spend; }), backgroundColor: '#f0a33c' }, { label: 'MQL', data: rows.map(function (r) { return r.mql; }), backgroundColor: '#128a3a', yAxisID: 'y1' }], true);
    mkBar('ptmk-mc2', labels, [{ label: 'QCPL', data: rows.map(function (r) { return isFinite(r.qcpl) ? Math.round(r.qcpl) : 0; }), backgroundColor: '#3b82f6' }]);
  }

  function renderSales() {
    var fn = salesFunnel();
    var cards = '<div class="ptmk-sec">영업 KPI (영업 종료지점 = 계약)</div><div class="ptmk-cards">' +
      kpi('MQL', fn.mql + '건') + kpi('SQL', fn.sql + '건') + kpi('MQL→SQL', p1(fn.mql2sql) + '%') +
      kpi('미팅', fn.meet + '건') + kpi('미팅 전환율', p1(fn.meetRate) + '%') + kpi('제안서', fn.prop + '건') + '</div>' +
      '<div class="ptmk-cards">' + kpi('계약', fn.contract + '건', null, '#128a3a') + kpi('계약률(계약÷SQL)', p1(fn.closeRate) + '%') +
      kpi('계약매출(실현)', won(fn.rev), fn.advCount + '개 광고주 · 캠페인DB') + kpi('평균 계약매출', won(fn.avgRev)) + kpi('서비스비', won(fn.svc)) +
      kpi('평균 리드타임', isFinite(fn.avgLeadTime) ? Math.round(fn.avgLeadTime) + '일' : '—', '획득→계약') + '</div>';
    var idxo = campIdx();
    var owners = {}; DATA.leads.forEach(function (l) { var o = l.salesOwner || '(미배정)'; var r = owners[o] || (owners[o] = { sql: 0, contract: 0, meet: 0, advs: {} }); if (l.sqlYn) r.sql++; if (l.meetingDate) r.meet++; if (l.contractDate) { r.contract++; r.advs[l.advertiser] = 1; } });
    function ownerRev(r) { return Object.keys(r.advs).reduce(function (s, a) { return s + (idxo[a] ? idxo[a].rev : 0); }, 0); }
    var otbl = '<div class="ptmk-card"><h3>담당자별 계약률</h3><div style="overflow:auto"><table class="ptmk-tbl"><thead><tr><th>담당자</th><th class="c">SQL</th><th class="c">미팅</th><th class="c">계약</th><th class="r">계약률</th><th class="r">계약매출(실현)</th></tr></thead><tbody>' +
      Object.keys(owners).filter(function (o) { return o !== '(미배정)'; }).sort(function (a, b) { return ownerRev(owners[b]) - ownerRev(owners[a]); }).map(function (o) { var r = owners[o]; var cr = r.sql > 0 ? r.contract / r.sql * 100 : NaN;
        return '<tr><td><b>' + esc(o) + '</b></td><td class="c">' + r.sql + '</td><td class="c">' + r.meet + '</td><td class="c" style="color:#128a3a">' + r.contract + '</td><td class="r">' + p1(cr) + '%</td><td class="r">' + f(ownerRev(r)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    var idxL = campIdx();
    var ltbl = '<div class="ptmk-card"><h3>리드/광고주 상세 (퍼널 단계)</h3><div style="overflow:auto"><table class="ptmk-tbl"><thead><tr><th>광고주</th><th>유입경로</th><th>세팅</th><th>획득일</th><th class="c">MQL</th><th class="c">SQL</th><th>담당</th><th>미팅</th><th>제안</th><th>계약</th><th class="r">계약매출(실현)</th><th>상태/사유</th></tr></thead><tbody>' +
      (DATA.leads.length ? DATA.leads.map(function (l) { var a = asOf(l.adsetId);
        return '<tr><td><b>' + esc(l.advertiser) + '</b></td><td style="font-size:11px;color:#667">' + esc(l.source || '—') + (l.adsetId ? '' : ' <span style="color:#c98a00">·미귀속</span>') + '</td><td style="color:#667">' + esc(a ? a.name : '—') + '</td><td style="color:#667">' + esc(d(l.leadDate) || '—') + '</td>' +
          '<td class="c">' + (l.mqlYn ? '<span style="color:#128a3a">✔</span>' : '·') + '</td><td class="c">' + (l.sqlYn ? '<span style="color:#128a3a">✔</span>' : '·') + '</td>' +
          '<td>' + esc(l.salesOwner || '—') + '</td><td style="color:#667">' + esc(d(l.meetingDate) || '—') + '</td><td style="color:#667">' + esc(d(l.proposalDate) || '—') + '</td>' +
          '<td style="color:#667">' + esc(d(l.contractDate) || '—') + '</td><td class="r">' + (l.contractDate && idxL[l.advertiser] ? f(idxL[l.advertiser].rev) : '—') + '</td>' +
          '<td>' + esc(l.leadStatus || '') + (l.lostReason ? ' <span style="color:#c0392b;font-size:11px">(' + esc(l.lostReason) + ')</span>' : '') + '</td>' +
          '<td><button class="ptmk-btn-sm ptmk-lead-del" data-id="' + l.id + '" style="color:#c0392b">삭제</button></td></tr>';
      }).join('') : '<tr><td colspan="13" style="text-align:center;color:#aab;padding:14px">입력 탭에서 리드를 추가하세요.</td></tr>') + '</tbody></table></div></div>';
    return cards + '<div class="ptmk-card"><h3>영업 퍼널</h3><div style="height:230px"><canvas id="ptmk-sales-funnel"></canvas></div></div>' + otbl + ltbl +
      '<div class="ptmk-card" style="color:#889;font-size:12px">📌 영업팀 평가는 <b>계약 전환율·계약매출</b> 기준. 병목: MQL→SQL↓→첫 응대 개선 · SQL→계약↓→영업 개선.</div>';
  }
  function salesFunnelData() { var fn = salesFunnel(); return { labels: ['MQL', 'SQL', '미팅', '제안', '계약'], data: [fn.mql, fn.sql, fn.meet, fn.prop, fn.contract] }; }

  function renderExec() {
    var e = execKpi();
    var cards = '<div class="ptmk-sec">대표 KPI</div><div class="ptmk-cards">' +
      kpi('광고비', won(e.totSpend)) + kpi('계약매출', won(e.rev), e.advCount + '개 계약광고주') +
      kpi('서비스비', won(e.svc)) + kpi('매출총이익', won(e.gp), '서비스비×' + (margin() * 100) + '%') + '</div>' +
      '<div class="ptmk-cards">' + kpi('ROAS', p1(e.roas) + '%', '계약매출÷광고비', e.roas >= 100 ? '#128a3a' : '#c0392b') +
      kpi('ROI', p1(e.roi) + '%', '(총이익−광고비)÷광고비', e.roi >= 0 ? '#128a3a' : '#c0392b') +
      kpi('CAC', won(e.cac)) + kpi('광고주 LTV', won(e.ltv)) +
      kpi('LTV/CAC', isFinite(e.ltvCac) ? p1(e.ltvCac) + 'x' : '—', null, e.ltvCac >= 3 ? '#128a3a' : (e.ltvCac >= 1 ? '#111' : '#c0392b')) +
      kpi('재계약률', p1(e.reRate) + '%') + '</div>';
    var idx = campIdx(); var adv = {}; DATA.leads.forEach(function (l) { if (l.contractDate) adv[l.advertiser] = 1; });
    var atbl = '<div class="ptmk-card"><h3>계약 광고주별 실현 매출 / LTV</h3><div style="overflow:auto"><table class="ptmk-tbl"><thead><tr><th>광고주</th><th class="c">캠페인수</th><th class="r">계약매출</th><th class="r">서비스비</th><th class="c">재계약</th></tr></thead><tbody>' +
      (Object.keys(adv).length ? Object.keys(adv).sort(function (a, b) { return (idx[b] ? idx[b].rev : 0) - (idx[a] ? idx[a].rev : 0); }).map(function (a) { var r = idx[a] || { count: 0, rev: 0, svc: 0 };
        return '<tr><td><b>' + esc(a) + '</b></td><td class="c">' + r.count + '</td><td class="r">' + f(r.rev) + '</td><td class="r" style="color:#667">' + f(r.svc) + '</td><td class="c">' + (r.count > 1 ? '<span style="color:#128a3a">○</span>' : '·') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" style="text-align:center;color:#aab;padding:14px">계약(계약일 입력)된 광고주가 없습니다.</td></tr>') + '</tbody></table></div></div>';
    return cards + '<div class="ptmk-card"><h3>전체 퍼널 (광고비 → MQL → SQL → 계약 → 매출 → 매출총이익)</h3><div style="height:260px"><canvas id="ptmk-exec-funnel"></canvas></div></div>' + atbl +
      '<div class="ptmk-card" style="color:#889;font-size:12px">📌 대표는 <b>투자 대비 수익성(ROAS·ROI·LTV/CAC)</b>을 본다. LTV/CAC 3배↑면 예산 확대 신호.</div>';
  }
  function execFunnelData() { var e = execKpi(); return { labels: ['광고비(만원)', 'MQL', 'SQL', '계약', '계약매출(만원)', '매출총이익(만원)'], data: [Math.round(e.totSpend / 10000), e.fn.mql, e.fn.sql, e.fn.contract, Math.round(e.rev / 10000), Math.round(e.gp / 10000)] }; }

  function renderInput() {
    var creOpts = DATA.creatives.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    var asOpts = DATA.adsets.map(function (a) { return '<option value="' + a.id + '">' + esc((creOf(a.creativeId) || {}).name + ' · ' + a.name) + '</option>'; }).join('');
    var inp = 'width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font-size:13px;box-sizing:border-box;margin-bottom:6px';
    var gallery = DATA.creatives.map(function (c) { return '<div style="text-align:center;width:56px">' + thumb(c.img, c.name, 52) + '<div style="font-size:10px;color:#667;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(c.name) + '">' + esc(c.name) + '</div><label style="font-size:10px;color:#2563eb;cursor:pointer">🖼<input type="file" accept="image/*" data-id="' + c.id + '" class="ptmk-cre-imgfile" style="display:none"></label> <button class="ptmk-cre-del" data-id="' + c.id + '" style="font-size:10px;color:#c0392b;border:none;background:none;cursor:pointer">✕</button></div>'; }).join('');
    return '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
      '<div class="ptmk-card" style="flex:1;min-width:260px"><h3>① 광고 소재</h3><div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">' + gallery + '</div>' +
        '<input id="ptmk-i-cre-name" style="' + inp + '" placeholder="소재명"><input id="ptmk-i-cre-img" type="file" accept="image/*" style="' + inp + ';padding:5px"><input id="ptmk-i-cre-imgurl" style="' + inp + '" placeholder="또는 이미지 URL(선택)"><button class="ptmk-btn-p ptmk-i-cre-add">소재 추가</button></div>' +
      '<div class="ptmk-card" style="flex:1.2;min-width:300px"><h3>② 메타 세팅 (광고비·노출·클릭)</h3>' +
        '<select id="ptmk-i-as-cre" style="' + inp + '">' + (creOpts || '<option value="">소재 먼저</option>') + '</select>' +
        '<input id="ptmk-i-as-name" style="' + inp + '" placeholder="세팅명">' +
        '<div style="display:flex;gap:6px"><input id="ptmk-i-as-spend" type="number" style="' + inp + '" placeholder="광고비"><input id="ptmk-i-as-impr" type="number" style="' + inp + '" placeholder="노출"><input id="ptmk-i-as-clk" type="number" style="' + inp + '" placeholder="클릭"></div>' +
        '<input id="ptmk-i-as-period" style="' + inp + '" placeholder="기간 예:6/1~6/30"><button class="ptmk-btn-p ptmk-i-as-add">세팅 추가</button></div>' +
      '<div class="ptmk-card" style="flex:1.4;min-width:320px"><h3>③ 리드/광고주 (퍼널)</h3>' +
        '<select id="ptmk-i-l-source" style="' + inp + '"><option value="메타 리드폼">유입경로: 메타 리드폼 (세팅 수동 귀속)</option><option value="사이트 상담">유입경로: 사이트 상담 (미귀속)</option><option value="기타">유입경로: 기타 (미귀속)</option></select>' +
        '<select id="ptmk-i-l-as" style="' + inp + '"><option value="">— 메타일 때 세팅 선택 —</option>' + asOpts + '</select>' +
        '<input id="ptmk-i-l-adv" style="' + inp + '" placeholder="광고주(법인명)" list="ptmk-adv-list"><datalist id="ptmk-adv-list"></datalist>' +
        '<div style="display:flex;gap:6px;align-items:center"><label style="font-size:11px;color:#667;white-space:nowrap">리드 획득일</label><input id="ptmk-i-l-leaddate" type="date" style="' + inp + '"></div>' +
        '<div style="display:flex;gap:6px;align-items:center"><label style="font-size:11px;color:#667;white-space:nowrap">가입일(선택)</label><input id="ptmk-i-l-signup" type="date" style="' + inp + '"></div>' +
        '<div style="display:flex;gap:10px;margin:2px 0 6px"><label style="font-size:12px"><input type="checkbox" id="ptmk-i-l-mql"> MQL</label><label style="font-size:12px"><input type="checkbox" id="ptmk-i-l-sql"> SQL</label></div>' +
        '<input id="ptmk-i-l-owner" style="' + inp + '" placeholder="영업담당자">' +
        '<div style="display:flex;gap:6px"><input id="ptmk-i-l-meet" type="date" style="' + inp + '" title="미팅일"><input id="ptmk-i-l-prop" type="date" style="' + inp + '" title="제안일"><input id="ptmk-i-l-contract" type="date" style="' + inp + '" title="계약일"></div>' +
        '<input id="ptmk-i-l-lost" style="' + inp + '" placeholder="실패사유(선택)">' +
        '<div style="font-size:11px;color:#889;margin-bottom:6px">※ 계약매출·서비스비는 입력하지 않음 — 계약일 있는 광고주는 캠페인DB(법인명)에서 자동 연결.</div>' +
        '<button class="ptmk-btn-p ptmk-i-l-add">리드 추가</button></div>' +
      '</div>';
  }

  function wireInput() {
    var host = document.getElementById('ptmk-view'); if (!host) return;
    var g = function (id) { return document.getElementById(id); };
    // 광고주 자동완성
    var dl = g('ptmk-adv-list'); if (dl) { var idx = campIdx(); dl.innerHTML = Object.keys(idx).sort().map(function (c) { var r = idx[c]; return '<option value="' + esc(c) + '">' + esc(Object.keys(r.stores).slice(0, 2).join(', ') + ' · ' + r.count + '캠페인') + '</option>'; }).join(''); }

    var creAdd = host.querySelector('.ptmk-i-cre-add');
    if (creAdd) creAdd.onclick = function () {
      var nm = (g('ptmk-i-cre-name').value || '').trim(); if (!nm) return toast('소재명을 입력하세요');
      var file = g('ptmk-i-cre-img').files[0]; var url = (g('ptmk-i-cre-imgurl').value || '').trim();
      var fin = function (img) { commit(function (x) { x.creatives.push({ id: uid(), name: nm, img: img || '', createdAt: new Date().toISOString() }); }); toast('✅ 소재 추가(공유 저장)'); };
      if (file) { creAdd.disabled = true; creAdd.textContent = '처리중...'; fileToThumb(file, function (img) { creAdd.disabled = false; creAdd.textContent = '소재 추가'; fin(img); }); } else fin(url);
    };
    host.querySelectorAll('.ptmk-cre-imgfile').forEach(function (inpf) { inpf.onchange = function () { var id = inpf.getAttribute('data-id'); var ff = inpf.files[0]; if (!ff) return; toast('이미지 처리중...'); fileToThumb(ff, function (img) { if (!img) return toast('이미지 실패'); commit(function (x) { x.creatives.forEach(function (c) { if (c.id === id) c.img = img; }); }); toast('✅ 이미지 저장(공유)'); }); }; });
    host.querySelectorAll('.ptmk-cre-del').forEach(function (b) { b.onclick = function () { var id = b.getAttribute('data-id'); if (!confirm('이 소재와 하위 세팅·리드를 모두 삭제할까요?')) return; commit(function (x) { var asIds = x.adsets.filter(function (a) { return a.creativeId === id; }).map(function (a) { return a.id; }); x.creatives = x.creatives.filter(function (c) { return c.id !== id; }); x.adsets = x.adsets.filter(function (a) { return a.creativeId !== id; }); x.leads = x.leads.filter(function (l) { return asIds.indexOf(l.adsetId) < 0; }); }); }; });

    var asAdd = host.querySelector('.ptmk-i-as-add');
    if (asAdd) asAdd.onclick = function () {
      var cre = g('ptmk-i-as-cre').value, nm = (g('ptmk-i-as-name').value || '').trim();
      if (!cre) return toast('소재를 선택하세요'); if (!nm) return toast('세팅명을 입력하세요');
      commit(function (x) { x.adsets.push({ id: uid(), creativeId: cre, name: nm, platform: 'meta', spend: n(g('ptmk-i-as-spend').value), impressions: n(g('ptmk-i-as-impr').value), clicks: n(g('ptmk-i-as-clk').value), period: (g('ptmk-i-as-period').value || '').trim(), createdAt: new Date().toISOString() }); });
      toast('✅ 메타 세팅 추가(공유 저장)');
    };

    var lAdd = host.querySelector('.ptmk-i-l-add');
    if (lAdd) lAdd.onclick = function () {
      var src = g('ptmk-i-l-source').value, as = g('ptmk-i-l-as').value, adv = (g('ptmk-i-l-adv').value || '').trim();
      if (src === '메타 리드폼' && !as) return toast('메타 리드폼은 세팅을 선택하세요');
      if (!adv) return toast('광고주(법인명)를 입력하세요');
      commit(function (x) { x.leads.push({ id: uid(), source: src, adsetId: as, advertiser: adv, leadDate: g('ptmk-i-l-leaddate').value, signupDate: g('ptmk-i-l-signup').value, mqlYn: g('ptmk-i-l-mql').checked, sqlYn: g('ptmk-i-l-sql').checked, salesOwner: (g('ptmk-i-l-owner').value || '').trim(), meetingDate: g('ptmk-i-l-meet').value, proposalDate: g('ptmk-i-l-prop').value, contractDate: g('ptmk-i-l-contract').value, lostReason: (g('ptmk-i-l-lost').value || '').trim(), leadStatus: g('ptmk-i-l-contract').value ? '계약' : (g('ptmk-i-l-sql').checked ? '제안' : (g('ptmk-i-l-mql').checked ? '상담중' : '신규')) }); });
      toast('✅ 리드 추가(공유 저장)');
    };
  }

  // 리드 삭제(영업 탭)
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.ptmk-lead-del') : null;
    if (!b) return; var id = b.getAttribute('data-id'); if (!confirm('이 리드를 삭제할까요?')) return;
    commit(function (x) { x.leads = x.leads.filter(function (l) { return l.id !== id; }); });
  });

  // ── 차트 ──
  function mkBar(id, labels, ds, dual) { var c = document.getElementById(id); if (!c || typeof Chart === 'undefined') return; if (charts[id]) { try { charts[id].destroy(); } catch (e) {} } var sc = { y: { beginAtZero: true } }; if (dual) sc.y1 = { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } }; charts[id] = new Chart(c.getContext('2d'), { type: 'bar', data: { labels: labels, datasets: ds }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: sc } }); }
  function drawFunnel(id, fd) { var c = document.getElementById(id); if (!c || typeof Chart === 'undefined') return; if (charts[id]) { try { charts[id].destroy(); } catch (e) {} } charts[id] = new Chart(c.getContext('2d'), { type: 'bar', data: { labels: fd.labels, datasets: [{ label: '값', data: fd.data, backgroundColor: ['#f0a33c', '#3b82f6', '#6366f1', '#8b5cf6', '#128a3a', '#0ea5a4'].slice(0, fd.data.length) }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } }); }

  // ── 썸네일 확대 ──
  document.addEventListener('mouseover', function (e) { var t = e.target; if (t && t.classList && t.classList.contains('ptmk-thumb') && t.dataset.img) { var z = ensureZoom(); z.innerHTML = '<img src="' + t.dataset.img + '" style="display:block;max-width:300px;max-height:300px">'; z.style.display = 'block'; z._m = function (ev) { z.style.left = Math.min(window.innerWidth - 320, ev.clientX + 16) + 'px'; z.style.top = Math.min(window.innerHeight - 320, Math.max(10, ev.clientY - 30)) + 'px'; }; z._m(e); window.addEventListener('mousemove', z._m); } });
  document.addEventListener('mouseout', function (e) { var t = e.target; if (t && t.classList && t.classList.contains('ptmk-thumb')) { var z = document.getElementById('ptmk-zoom'); if (z) { z.style.display = 'none'; if (z._m) { window.removeEventListener('mousemove', z._m); z._m = null; } } } });
  function ensureZoom() { var z = document.getElementById('ptmk-zoom'); if (!z) { z = document.createElement('div'); z.id = 'ptmk-zoom'; z.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;display:none;border:3px solid #fff;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.38);overflow:hidden;background:#fff'; document.body.appendChild(z); } return z; }

  // ── 스타일 주입 ──
  function ensureStyle() {
    if (document.getElementById('ptmk-style')) return;
    var s = document.createElement('style'); s.id = 'ptmk-style';
    s.textContent = '.ptmk-subnav{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 12px}.ptmk-subtab{border:none;background:#eef1f5;color:#48505c;padding:7px 13px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600}.ptmk-subtab.active{background:#0ea5a4;color:#fff}' +
      '.ptmk-cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.ptmk-kpi{flex:1;min-width:130px;background:#fff;border:1px solid #eef0f3;border-radius:10px;padding:11px 13px}.ptmk-l{font-size:11.5px;color:#8a94a6}.ptmk-v{font-size:20px;font-weight:800;margin-top:2px}.ptmk-s{font-size:11px;color:#aab;margin-top:2px}' +
      '.ptmk-card{background:#fff;border:1px solid #eef0f3;border-radius:10px;padding:12px;margin-bottom:16px}.ptmk-card h3{font-size:14px;margin:0 0 8px}.ptmk-sec{font-size:12px;font-weight:700;color:#2563eb;margin:2px 0 6px}' +
      '.ptmk-tbl{width:100%;border-collapse:collapse;font-size:13px}.ptmk-tbl th{background:#f7f8fa;color:#556;text-align:left;padding:8px;font-weight:600;white-space:nowrap}.ptmk-tbl td{padding:7px 8px;border-bottom:1px solid #f2f4f7}.ptmk-tbl .r{text-align:right}.ptmk-tbl .c{text-align:center}' +
      '.ptmk-assume{border:1px solid #dbe4ff;background:#f5f8ff;border-radius:8px;padding:8px 12px;font-size:12px;color:#3651a8;margin-bottom:14px}' +
      '.ptmk-btn-p{background:#2563eb;color:#fff;border:1px solid #2563eb;border-radius:7px;padding:7px 12px;font-size:13px;cursor:pointer}.ptmk-btn-sm{font-size:11px;padding:2px 7px;border:1px solid #d0d5dd;background:#fff;border-radius:6px;cursor:pointer}';
    document.head.appendChild(s);
  }

  // ══════════ 탭 주입 & 표시 ══════════
  function ensureTab() {
    ensureStyle();
    if (!document.getElementById('tab-meta')) {
      var ref = document.getElementById('tab-dashboard') || document.querySelector('.panel');
      if (ref && ref.parentNode) { var p = document.createElement('div'); p.id = 'tab-meta'; p.className = 'panel'; p.style.cssText = 'padding:4px 2px'; ref.parentNode.appendChild(p); }
    }
    if (!document.getElementById('tab-btn-meta')) {
      var after = document.getElementById('tab-btn-sales-perf');
      var b = document.createElement('button');
      b.id = 'tab-btn-meta'; b.className = after ? after.className : 'tab'; b.textContent = '📊 메타성과'; b.onclick = show;
      if (after && after.parentNode) after.parentNode.insertBefore(b, after.nextSibling);
      else { var nav = document.getElementById('main-tabs'); if (nav) nav.appendChild(b); }
    }
  }

  function renderShell() {
    var host = document.getElementById('tab-meta'); if (!host) return;
    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">' +
        '<h2 style="margin:0;font-size:18px">📊 메타성과 <span style="font-size:12px;font-weight:400;color:#889">— 메타 광고 기반 마케팅·영업·대표 성과</span></h2>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<label style="font-size:12px;color:#556">매출 기준</label><select id="ptmk-revfield" style="padding:5px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px">' + REV_FIELDS.map(function (x) { return '<option value="' + x.key + '"' + (x.key === revField() ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select>' +
          '<label style="font-size:12px;color:#556">총이익률</label><input id="ptmk-margin" type="number" min="0" max="100" style="width:60px;padding:5px 7px;border:1px solid #ccc;border-radius:6px;font-size:13px"><span style="font-size:12px;color:#889">%</span>' +
          '<button id="ptmk-refresh" class="ptmk-btn-sm">↻ 새로고침</button>' +
        '</div></div>' +
      '<div class="ptmk-subnav" id="ptmk-subnav">' +
        '<button class="ptmk-subtab' + (view === 'mkt' ? ' active' : '') + '" data-v="mkt">📣 마케팅</button>' +
        '<button class="ptmk-subtab' + (view === 'sales' ? ' active' : '') + '" data-v="sales">🤝 영업</button>' +
        '<button class="ptmk-subtab' + (view === 'exec' ? ' active' : '') + '" data-v="exec">👑 대표</button>' +
        '<button class="ptmk-subtab' + (view === 'input' ? ' active' : '') + '" data-v="input">✏️ 입력</button></div>' +
      '<div class="ptmk-assume" id="ptmk-assume"></div><div id="ptmk-view"></div>';
    var rf = document.getElementById('ptmk-revfield'); if (rf) rf.onchange = function () { commit(function (x) { x.settings.revenueField = rf.value; }); };
    var mg = document.getElementById('ptmk-margin'); if (mg) { mg.value = (DATA.settings.marginRate != null ? DATA.settings.marginRate : 70); mg.onchange = function () { commit(function (x) { x.settings.marginRate = n(mg.value); }); }; }
    var rfr = document.getElementById('ptmk-refresh'); if (rfr) rfr.onclick = function () { pullShared(function (s) { if (s) { DATA = s; saveLocal(s); } renderShell(); toast('↻ 최신 데이터로 새로고침'); }); };
    document.getElementById('ptmk-subnav').addEventListener('click', function (e) { var b = e.target.closest('.ptmk-subtab'); if (!b) return; view = b.getAttribute('data-v'); [].forEach.call(document.querySelectorAll('#ptmk-subnav .ptmk-subtab'), function (x) { x.classList.toggle('active', x === b); }); renderInner(); });
    renderInner();
  }

  function show() {
    ensureTab();
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (t) { t.classList.remove('active'); });
    var p = document.getElementById('tab-meta'); if (p) p.classList.add('active');
    var b = document.getElementById('tab-btn-meta'); if (b) b.classList.add('active');
    renderShell();
  }

  // 다른 탭 전환 시 내 버튼 active 해제
  if (typeof window.showTab === 'function' && !window.showTab.__mkWrapped) {
    var _st = window.showTab;
    window.showTab = function () { var b = document.getElementById('tab-btn-meta'); if (b) b.classList.remove('active'); return _st.apply(this, arguments); };
    window.showTab.__mkWrapped = true;
  }

  window.PTMK = { show: show, data: function () { return DATA; } };

  // ── 초기화 ──
  function init() {
    DATA = loadLocal(); ensureTab();
    pullShared(function (s) { if (s) { DATA = s; saveLocal(s); } var p = document.getElementById('tab-meta'); if (p && p.classList.contains('active')) renderShell(); });
  }
  var tries = 0;
  var iv = setInterval(function () { tries++; if (document.getElementById('main-tabs') || tries > 100) { clearInterval(iv); init(); } }, 300);
})();
