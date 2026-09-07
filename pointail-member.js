/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 👥 회원관리 모듈 v3 (pointail-member.js)
 *
 *  [v3 2026-09-07] 대상 전면 교체: 광고주 회원 → **앱(체험단) 회원**(사용자 정정).
 *  데이터: Worker /appmembers (앱 회원 8천+ 스냅샷: 가입일·유입경로·성별·나이·
 *          상태·이름 마스킹 / SNS 인증 계정 목록) + /applies (회원별 캠페인 지원
 *          이력 맵 {c:지원수, f:첫지원일 근사}) — 3시간 크론으로 스냅샷 갱신.
 *  활성화 = 캠페인 지원 이력 ≥ 1건. 지원 이력은 회원별 개별 API라 Worker
 *  /applies/crawl 로 **점진 수집**(1회 35명) — 미수집분이 있으면 탭이 열려 있는
 *  동안 자동으로 이어서 수집하고 진행률을 표시한다(수집분은 KV에 영구 캐시,
 *  이후 신규 가입자만 추가 수집).
 *   · KPI: 오늘·이번달 신규(전월비) · 활성화율 · 온보딩 필요
 *   · 유입 채널 비율(도넛+리스트) — registerInflowPath (앱 회원엔 데이터 존재!)
 *   · 신규회원 추이: 일별(월 선택)/월별/연도별 채널별 누적 막대 + CSV
 *   · SNS 인증 현황: 채널(인스타/X/틱톡)×상태 집계
 *   · 활성화 분석: 가입월 코호트 — 지원/미지원/활성화율/첫 지원까지 평균일
 *   · 온보딩 필요 회원: 지원 0건 리스트(경과 3단계·SNS 인증 여부) + CSV
 *  내비 배치는 pointail-nav.js v5 member 그룹. 원본 index.html 무수정(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var MV = { view: 'day', selMonth: null, obWin: 90 };
  var SNAP = null;          // /appmembers 응답
  var AP = null;            // /applies 맵
  var loading = false, crawling = false, crawlMsg = '', crawlDone = false;
  var TTD = {};             // [v6] 추이 차트 툴팁 데이터 (막대 키 → {head,sum,items})

  var INFLOW = [
    { id: 'INSTAGRAM',         label: 'Instagram',             color: '#D6567A' },
    { id: 'X',                 label: 'X',                     color: '#4B5563' },
    { id: 'LINE',              label: '라인',                  color: '#2BA84A' },
    { id: 'TIKTOK',            label: 'TikTok',                color: '#18B5C4' },
    { id: 'YOUTUBE',           label: 'YouTube',               color: '#DE4038' },
    { id: 'WEB_ADVERTISE',     label: '웹 광고(배너 등)',       color: '#EE9B2E' },
    { id: 'WEB_NEWS',          label: '웹 기사(PRTIMES 등)',    color: '#9A7BD1' },
    { id: 'WEB_SEARCH',        label: '인터넷 검색(Google 등)',  color: '#3B6FDB' },
    { id: 'SOMEONE_RECOMMEND', label: '지인 소개',              color: '#7E8F5A' },
    { id: 'ETC',               label: '기타',                   color: '#98A0AB' },
    { id: '',                  label: '미응답',                 color: '#C6CCD4' }
  ];
  function inflowOf(v) {
    v = String(v || '').trim();
    for (var i = 0; i < INFLOW.length; i++) if (INFLOW[i].id === v) return INFLOW[i];
    return { id: v, label: v, color: '#5F7A9E' };
  }
  var SNS_LABEL = { INSTAGRAM: '📸 Instagram', X: '𝕏 X', TIKTOK: '🎵 TikTok' };
  function snsStateLabel(st) {
    if (/COMPLETE|SUCCESS|AUTHENTICATED$|^AUTHENTICATION$|FINISH/i.test(st)) return '완료';
    if (/WAIT/i.test(st)) return '대기';
    if (/CANCEL|REJECT|FAIL|DENY/i.test(st)) return '거절';
    return st || '기타';
  }

  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s]/g, '')) || 0; }
  function f(v) { return Math.round(n(v)).toLocaleString('ko-KR'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function d10(s) { return String(s || '').slice(0, 10); }
  function todayStr() { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); }
  function dayDiff(a, b) { var x = Date.parse(a), y = Date.parse(b); return (isFinite(x) && isFinite(y)) ? Math.round((y - x) / 86400000) : null; }
  // [v5] 탈퇴 판정 — Worker MEMSTATE_MAP 미매핑 enum(WITHDRAWAL 등) 원문도 포함
  function isOut(m) { return /탈퇴|WITHDRAW/.test(String((m && m.state) || '')); }

  /* ── 데이터 로드 ── */
  function loadData(cb) {
    if (loading) return;
    loading = true;
    Promise.all([
      fetch(WORKER + 'appmembers?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }),
      fetch(WORKER + 'applies?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (res) {
      SNAP = res[0]; AP = res[1] || {};
      loading = false;
      if (cb) cb();
    }).catch(function () { loading = false; if (cb) cb(); });
  }

  /* ── 지원 이력 점진 수집(탭 열려 있는 동안 자동) ── */
  function crawl() {
    if (crawling) return;
    crawling = true;
    var iter = 0;
    function step() {
      var p = document.getElementById('tab-member');
      if (!p || !p.classList.contains('active') || iter++ > 400) { crawling = false; return; }
      fetch(WORKER + 'applies/crawl?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) { crawling = false; crawlMsg = '수집 오류 — 잠시 후 자동 재시도'; render(); return; }
          crawlMsg = j.remaining > 0
            ? '⏳ 활성화 데이터 수집 중… ' + f(j.collected) + ' / ' + f(j.total) + '명 (남은 ' + f(j.remaining) + '명 · 탭을 열어두면 자동 진행)'
            : '';
          var bn = document.getElementById('ptmem-crawl'); if (bn) bn.textContent = crawlMsg || '✅ 수집 완료';
          if (j.remaining > 0 && j.added > 0) { setTimeout(step, 300); }
          else {
            crawling = false;
            crawlDone = true;   // [v4] 이 세션에서는 자동 수집 재시작 안 함
            // 최신 맵 반영 후 재렌더
            fetch(WORKER + 'applies?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); })
              .then(function (m2) { AP = m2 || AP; render(); });
          }
        })
        .catch(function () { crawling = false; });
    }
    step();
  }

  /* ── [v6] 추이 차트 호버 툴팁 ── */
  function ensureTip() {
    var t = document.getElementById('ptmem-tt');
    if (t) return t;
    t = document.createElement('div');
    t.id = 'ptmem-tt';
    t.style.cssText = 'position:fixed;z-index:2147483000;display:none;pointer-events:none;background:rgba(23,27,34,.96);color:#fff;border-radius:10px;padding:10px 13px;font-size:12px;line-height:1.7;box-shadow:0 6px 20px rgba(0,0,0,.28);max-width:240px;white-space:nowrap';
    document.body.appendChild(t);
    return t;
  }
  function tipHTML(d) {
    var rows = d.items.map(function (x) {
      return '<div style="display:flex;align-items:center;gap:7px">' +
        '<span style="width:9px;height:9px;border-radius:2px;background:' + x.c + ';flex:0 0 auto"></span>' +
        '<span style="flex:1;padding-right:14px">' + esc(x.l) + '</span><b>' + f(x.v) + '명</b></div>';
    }).join('');
    return '<div style="font-weight:700;margin-bottom:5px">' + esc(d.head) + '</div>' + (rows || '<div style="color:#9aa3b2">가입 없음</div>') +
      '<div style="border-top:1px solid rgba(255,255,255,.22);margin-top:6px;padding-top:5px;font-weight:700">합계 ' + f(d.sum) + '명</div>';
  }
  function hookTooltip() {
    var chart = document.getElementById('ptmem-chart');
    if (!chart || chart.__ptTT) return;
    chart.__ptTT = true;
    var tip = ensureTip();
    function move(ev) {
      var col = ev.target && ev.target.closest ? ev.target.closest('[data-ttk]') : null;
      var d = col && TTD[col.getAttribute('data-ttk')];
      if (!d) { tip.style.display = 'none'; return; }
      tip.innerHTML = tipHTML(d);
      tip.style.display = 'block';
      var w = tip.offsetWidth, h = tip.offsetHeight;
      var x = ev.clientX + 14, y = ev.clientY - h / 2;
      if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
      if (y < 8) y = 8;
      if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    chart.addEventListener('mousemove', move);
    chart.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  }

  /* ── 렌더 ── */
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
    if (!SNAP || !SNAP.members || !SNAP.members.length) {
      host.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#8a94a6"><div style="font-size:34px;margin-bottom:10px">👥</div>' +
        '<div style="font-size:14px">' + (loading ? '앱 회원 데이터를 불러오는 중…' : '앱 회원 스냅샷이 아직 없습니다.<br>다음 자동 동기화(3시간 주기) 후 표시되거나, 새로고침 해주세요.') + '</div>' +
        '<div style="margin-top:12px"><button onclick="window.PTMEM&&PTMEM.reload()" style="padding:6px 14px;border:1px solid #e5e8ee;background:#fff;border-radius:8px;cursor:pointer;font-size:12px;color:#48505c">🔄 다시 불러오기</button></div></div>';
      return;
    }
    var mems = SNAP.members, sns = SNAP.sns || [];
    var today = todayStr(), thisM = today.slice(0, 7);
    var pv = new Date(); pv.setDate(1); pv.setMonth(pv.getMonth() - 1);
    var prevM = pv.getFullYear() + '-' + ('0' + (pv.getMonth() + 1)).slice(-2);

    /* SNS 인증 보유 회원 집합(완료 기준) + 채널×상태 집계 */
    var verified = {}, snsAgg = {};
    sns.forEach(function (a) {
      var st = snsStateLabel(a.st);
      var t = a.t || '?';
      if (!snsAgg[t]) snsAgg[t] = {};
      snsAgg[t][st] = (snsAgg[t][st] || 0) + 1;
      if (st === '완료') verified[a.m] = 1;
    });

    var todayNew = 0, monthNew = 0, prevNew = 0;
    var covered = 0, act = 0, obAll = [];
    var byDay = {}, byMonth = {}, byYear = {}, byInflow = {};
    var coh = {};
    mems.forEach(function (m) {
      var jd = d10(m.join);
      /* [v5] 활성화·온보딩 집계는 가입일 유무와 무관하게 수행
         (탈퇴 회원 475명은 가입일이 비어 있어 v3~v4에서 수집 94%로 잘못 표시됨) */
      var e = AP && AP[m.no];
      if (e !== undefined) {
        covered++;
        if (e.c > 0) act++;
        else if (!isOut(m)) obAll.push(m);
      }
      var ch = inflowOf(m.inflow);
      byInflow[ch.id] = (byInflow[ch.id] || 0) + 1;   // [v5] 유입경로 도넛은 전체 회원 기준(가입일 없어도 집계)
      if (!jd) return;   // 이하 날짜 기반 통계(추이·코호트)만 가입일 필요
      if (jd === today) todayNew++;
      if (jd.slice(0, 7) === thisM) monthNew++;
      if (jd.slice(0, 7) === prevM) prevNew++;
      if (!byDay[jd]) byDay[jd] = {}; byDay[jd][ch.id] = (byDay[jd][ch.id] || 0) + 1;
      var mk = jd.slice(0, 7); if (!byMonth[mk]) byMonth[mk] = {}; byMonth[mk][ch.id] = (byMonth[mk][ch.id] || 0) + 1;
      var yk = jd.slice(0, 4); if (!byYear[yk]) byYear[yk] = {}; byYear[yk][ch.id] = (byYear[yk][ch.id] || 0) + 1;

      if (!coh[mk]) coh[mk] = { join: 0, cov: 0, act: 0, dsum: 0, dcnt: 0 };
      coh[mk].join++;
      if (e !== undefined) {
        coh[mk].cov++;
        if (e.c > 0) {
          coh[mk].act++;
          if (e.f) { var dd = dayDiff(jd, e.f); if (dd != null && dd >= 0) { coh[mk].dsum += dd; coh[mk].dcnt++; } }
        }
      }
    });
    var rate = covered ? Math.round(act / covered * 100) : 0;
    var covPct = mems.length ? Math.round(covered / mems.length * 100) : 0;
    var momTxt = prevNew > 0 ? ('전월 ' + f(prevNew) + '명 <span style="color:' + (monthNew >= prevNew ? '#128a3a' : '#c0392b') + ';font-weight:600">' + (monthNew >= prevNew ? '▲' : '▼') + Math.abs(Math.round((monthNew - prevNew) / prevNew * 100)) + '%</span> (진행 중)') : '전월 데이터 없음';

    /* 유입경로 도넛(conic-gradient) + 리스트 */
    var inflowSorted = Object.keys(byInflow).map(function (id) { return { ch: inflowOf(id), cnt: byInflow[id] }; })
      .sort(function (a, b) { return b.cnt - a.cnt; });
    var tot = mems.length, acc = 0, segs = [];   // 도넛 세그먼트는 아래에서 byInflow 합 기준으로 계산
    inflowSorted.forEach(function (x) {
      var from = acc / tot * 100; acc += x.cnt;
      segs.push(x.ch.color + ' ' + from.toFixed(2) + '% ' + (acc / tot * 100).toFixed(2) + '%');
    });
    var donut = '<div style="width:150px;height:150px;border-radius:50%;margin:4px auto;background:conic-gradient(' + segs.join(', ') + ');position:relative;flex:0 0 auto">' +
      '<div style="position:absolute;inset:30px;border-radius:50%;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
        '<div style="font-size:10px;color:#98a2b3">전체 회원</div><div style="font-size:19px;font-weight:700">' + f(tot) + '</div><div style="font-size:10px;color:#98a2b3">명</div></div></div>';
    var inflowList = inflowSorted.map(function (x) {
      var pct = (x.cnt / tot * 100).toFixed(1);
      return '<div style="display:flex;align-items:center;gap:7px;padding:4px 0;border-bottom:1px solid #f2f4f7;font-size:12px">' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + x.ch.color + ';flex:0 0 auto"></span>' +
        '<span style="flex:1;color:#48505c">' + esc(x.ch.label) + '</span>' +
        '<b>' + f(x.cnt) + '명</b><span style="width:52px;text-align:right;font-weight:700;color:' + x.ch.color + '">' + pct + '%</span></div>';
    }).join('');

    /* 추이(채널별 누적 막대, CSS) */
    var monthList = Object.keys(byMonth).sort().reverse();
    if (MV.view === 'day' && (!MV.selMonth || monthList.indexOf(MV.selMonth) < 0)) MV.selMonth = monthList[0] || null;
    var keys, src, labFn;
    if (MV.view === 'day') {
      src = byDay; keys = [];
      if (MV.selMonth) {
        var dy = parseInt(MV.selMonth.slice(0, 4), 10), dm = parseInt(MV.selMonth.slice(5, 7), 10);
        var dmax = new Date(dy, dm, 0).getDate();
        for (var di = 1; di <= dmax; di++) keys.push(MV.selMonth + '-' + ('0' + di).slice(-2));
      }
      labFn = function (k) { return parseInt(k.slice(8, 10), 10); };
    } else if (MV.view === 'month') {
      src = byMonth; keys = Object.keys(byMonth).sort().slice(-24);
      labFn = function (k) { return k.slice(2).replace('-', '.'); };
    } else {
      src = byYear; keys = Object.keys(byYear).sort();
      labFn = function (k) { return k; };
    }
    var chOrder = inflowSorted.map(function (x) { return x.ch; });
    var maxV = 1;
    keys.forEach(function (k) { var r = src[k] || {}, s = 0; Object.keys(r).forEach(function (c) { s += r[c]; }); maxV = Math.max(maxV, s); });
    var H = 130;
    TTD = {};   // [v6] 뷰 전환 때마다 재구성
    var ttHead = function (k) {
      if (MV.view === 'day') return parseInt(k.slice(5, 7), 10) + '/' + parseInt(k.slice(8, 10), 10);
      if (MV.view === 'month') return k.replace('-', '.');
      return k + '년';
    };
    var bars = keys.map(function (k) {
      var r = src[k] || {}, sum = 0; Object.keys(r).forEach(function (c) { sum += r[c]; });
      TTD[k] = { head: ttHead(k), sum: sum, items: chOrder.map(function (ch) { return { l: ch.label, c: ch.color, v: r[ch.id] || 0 }; }).filter(function (x) { return x.v > 0; }) };
      var seg = chOrder.map(function (ch) {
        var v = r[ch.id] || 0; if (!v) return '';
        return '<div style="width:100%;height:' + Math.max(1, Math.round(v / maxV * H)) + 'px;background:' + ch.color + '"></div>';
      }).join('');
      return '<div data-ttk="' + esc(k) + '" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;cursor:default">' +
        '<div style="font-size:9px;color:#8a94a6;line-height:1">' + (sum || '') + '</div>' +
        '<div style="display:flex;flex-direction:column-reverse;justify-content:flex-start;height:' + H + 'px;width:70%;min-width:5px;max-width:26px;border-radius:3px 3px 0 0;overflow:hidden;align-self:center">' + seg + '</div>' +
        '<div style="font-size:9.5px;color:#8a94a6;border-top:1px solid #eef0f3;width:100%;text-align:center;padding-top:2px;white-space:nowrap;overflow:hidden">' + labFn(k) + '</div></div>';
    }).join('');
    var monthPills = MV.view === 'day'
      ? '<div style="display:flex;gap:5px;overflow-x:auto;padding-bottom:6px;margin-bottom:4px">' + monthList.slice(0, 18).map(function (mm) {
          return '<button onclick="window.PTMEM&&PTMEM.month(\'' + mm + '\')" style="font-size:11px;padding:3px 10px;border-radius:99px;cursor:pointer;white-space:nowrap;flex:0 0 auto;' + (mm === MV.selMonth ? 'background:#111827;color:#fff;border:1px solid #111827' : 'background:#fff;border:1px solid #e5e8ee;color:#667085') + '">' + mm.replace('-', '.') + '</button>';
        }).join('') + '</div>' : '';

    /* SNS 인증 현황 */
    var snsRows = Object.keys(snsAgg).sort().map(function (t) {
      var g = snsAgg[t], total = 0; Object.keys(g).forEach(function (s) { total += g[s]; });
      var done = g['완료'] || 0, wait = g['대기'] || 0, rej = g['거절'] || 0, etcC = total - done - wait - rej;
      var pct = total ? Math.round(done / total * 100) : 0;
      return '<tr><td style="text-align:left;font-weight:700">' + esc(SNS_LABEL[t] || t) + '</td>' +
        '<td>' + f(total) + '건</td>' +
        '<td style="color:#128a3a;font-weight:700">' + f(done) + '</td>' +
        '<td style="color:#b45309;font-weight:700">' + f(wait) + '</td>' +
        '<td style="color:#c0392b">' + f(rej) + '</td>' +
        '<td style="color:#8a94a6">' + f(etcC) + '</td>' +
        '<td style="text-align:left"><div style="display:flex;align-items:center;gap:7px"><div style="height:7px;border-radius:5px;background:#eceff3;position:relative;min-width:80px;max-width:160px;flex:1"><div style="position:absolute;left:0;top:0;height:7px;width:' + pct + '%;border-radius:5px;background:#128a3a"></div></div><span style="font-size:11px;font-weight:700;color:#128a3a">' + pct + '%</span></div></td></tr>';
    }).join('');
    var verifiedMembers = Object.keys(verified).length;

    /* 활성화 코호트(최근 12개월) */
    var cohRows = Object.keys(coh).sort().reverse().slice(0, 12).map(function (mk) {
      var c = coh[mk];
      if (!c.cov) return '<tr><td style="text-align:left;font-weight:700">' + mk.replace('-', '.') + '</td><td>' + f(c.join) + '명</td><td colspan="4" style="color:#98a2b3">수집 대기 중</td></tr>';
      var pct = Math.round(c.act / c.cov * 100), col = pct >= 50 ? '#128a3a' : '#b45309';
      var avg = c.dcnt ? Math.round(c.dsum / c.dcnt) : null;
      var covNote = c.cov < c.join ? ' <span style="font-size:10px;color:#98a2b3">(' + f(c.cov) + '명 수집)</span>' : '';
      return '<tr>' +
        '<td style="text-align:left;font-weight:700">' + mk.replace('-', '.') + '</td>' +
        '<td>' + f(c.join) + '명' + covNote + '</td>' +
        '<td style="color:#128a3a;font-weight:700">' + f(c.act) + '명</td>' +
        '<td style="color:#c0392b;font-weight:700">' + f(c.cov - c.act) + '명</td>' +
        '<td style="text-align:left"><div style="display:flex;align-items:center;gap:7px"><div style="height:7px;border-radius:5px;background:#eceff3;position:relative;min-width:90px;max-width:200px"><div style="position:absolute;left:0;top:0;height:7px;width:' + Math.min(100, pct) + '%;border-radius:5px;background:' + col + '"></div></div><span style="font-size:11px;font-weight:700;color:' + col + '">' + pct + '%</span></div></td>' +
        '<td>' + (avg != null ? avg + '일' : '–') + '</td></tr>';
    }).join('');

    /* 온보딩 리스트 */
    var obs = obAll.filter(function (m) {
      if (!MV.obWin) return true;
      var d = dayDiff(d10(m.join), today); return d != null && d <= MV.obWin;
    }).map(function (m) { m.elapsed = dayDiff(d10(m.join), today) || 0; return m; })
      .sort(function (a, b) { return b.elapsed - a.elapsed; });
    function stageBadge(d) {
      if (d > 45) return '<span style="font-size:10.5px;padding:2px 8px;border-radius:20px;background:#fceaea;color:#c0392b;font-weight:700">🚨 장기 미지원</span>';
      if (d >= 14) return '<span style="font-size:10.5px;padding:2px 8px;border-radius:20px;background:#fef3e2;color:#b45309;font-weight:700">💬 재안내 대상</span>';
      return '<span style="font-size:10.5px;padding:2px 8px;border-radius:20px;background:#e6f1fb;color:#185fa5;font-weight:700">🌱 신규</span>';
    }
    var obRows = obs.slice(0, 300).map(function (m) {
      return '<tr>' +
        '<td style="text-align:left;font-weight:600">' + esc(m.name || '') + ' <span style="color:#98a2b3">№' + esc(m.no) + '</span></td>' +
        '<td>' + esc(d10(m.join)) + '</td>' +
        '<td style="font-weight:700;color:' + (m.elapsed > 45 ? '#c0392b' : (m.elapsed >= 14 ? '#b45309' : '#48505c')) + '">' + m.elapsed + '일</td>' +
        '<td>' + esc(inflowOf(m.inflow).label) + '</td>' +
        '<td>' + (verified[m.no] ? '<span style="color:#128a3a;font-weight:700">✓ 인증</span>' : '<span style="color:#98a2b3">–</span>') + '</td>' +
        '<td>' + esc(m.state) + '</td>' +
        '<td style="text-align:left">' + stageBadge(m.elapsed) + '</td></tr>';
    }).join('');

    var TH = 'background:#f7f8fa;color:#667085;font-size:11.5px;padding:7px 10px;text-align:right;white-space:nowrap;border-bottom:1px solid #e5e8ee';
    var TD = 'font-size:12px;padding:7px 10px;text-align:right;border-bottom:1px solid #f2f4f7;white-space:nowrap';
    var fetchedTxt = SNAP.fetchedAt ? String(SNAP.fetchedAt).replace('T', ' ').slice(0, 16) : '';

    host.innerHTML =
      '<div style="padding:18px 20px;line-height:1.55">' +
      '<style>#tab-member th{' + TH + '}#tab-member td{' + TD + '}#tab-member th:first-child,#tab-member td:first-child{text-align:left}#tab-member tbody tr:hover td{background:#f7f8fa}</style>' +

      (covPct < 100 ? '<div id="ptmem-crawl" style="background:#fef3e2;border:1px solid #f5d9a8;color:#7a5312;border-radius:10px;padding:9px 13px;font-size:12px;margin-bottom:12px">' +
        (crawlMsg || ('⏳ 활성화 데이터 수집 중… ' + f(covered) + ' / ' + f(tot) + '명 (' + covPct + '%) · 탭을 열어두면 자동 진행됩니다')) + '</div>' : '') +

      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
        kpiCard('👤', '오늘 신규', f(todayNew) + '<span style="font-size:13px;color:#8a94a6;font-weight:500">명</span>', today, '#185fa5') +
        kpiCard('📅', '이번 달 신규', f(monthNew) + '<span style="font-size:13px;color:#8a94a6;font-weight:500">명</span>', momTxt) +
        kpiCard('⚡', '활성화율', rate + '<span style="font-size:13px;color:#8a94a6;font-weight:500">%</span>', '수집 ' + f(covered) + '명 중 ' + f(act) + '명 캠페인 지원' + (covPct < 100 ? ' · 수집 ' + covPct + '%' : ''), rate >= 50 ? '#128a3a' : '#b45309') +
        kpiCard('🚨', '온보딩 필요', f(obAll.length) + '<span style="font-size:13px;color:#8a94a6;font-weight:500">명</span>', '가입 후 캠페인 미지원(탈퇴 제외)', '#c0392b') +
      '</div>' +

      '<div style="display:grid;grid-template-columns:330px 1fr;gap:12px;margin-bottom:12px" class="ptmem-grid">' +
      '<style>@media(max-width:980px){.ptmem-grid{grid-template-columns:1fr!important}}</style>' +
        '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px;min-width:0">' +
          '<div style="font-size:13px;font-weight:700;margin-bottom:8px">🧭 유입 채널 비율 <span style="font-size:11px;font-weight:400;color:#8a94a6">가입 시 응답</span></div>' +
          donut + '<div style="margin-top:8px">' + inflowList + '</div>' +
        '</div>' +
        '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px;min-width:0">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">' +
            '<div style="font-size:13px;font-weight:700">📈 신규회원 추이 <span style="font-size:11px;font-weight:400;color:#8a94a6">채널별 누적 · 가입일 기준</span></div>' +
            '<div style="display:flex;gap:5px">' +
              pill(MV.view === 'day', '일별', 'window.PTMEM&&PTMEM.view(\'day\')') +
              pill(MV.view === 'month', '월별', 'window.PTMEM&&PTMEM.view(\'month\')') +
              pill(MV.view === 'year', '연도별', 'window.PTMEM&&PTMEM.view(\'year\')') +
              '<button onclick="window.PTMEM&&PTMEM.csvTrend()" style="font-size:11.5px;padding:4px 10px;border-radius:8px;background:#fff;border:1px solid #e5e8ee;color:#667085;cursor:pointer">⬇ CSV</button>' +
            '</div></div>' +
          monthPills +
          '<div id="ptmem-chart" style="display:flex;align-items:flex-end;gap:3px;overflow-x:auto">' + bars + '</div>' +
          '<div style="font-size:10.5px;color:#98a2b3;margin-top:6px">' + (MV.view === 'month' ? '최근 24개월 · ' : '') + '수집: ' + esc(fetchedTxt) + ' (3시간 자동 동기화)</div>' +
        '</div>' +
      '</div>' +

      '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px;margin-bottom:12px">' +
        '<div style="font-size:13px;font-weight:700;margin-bottom:4px">📱 SNS 계정 인증 현황 <span style="font-size:11px;font-weight:400;color:#8a94a6">— 인증 완료 보유 회원 ' + f(verifiedMembers) + '명 / 계정 ' + f(sns.length) + '건</span></div>' +
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:640px">' +
          '<thead><tr><th>채널</th><th>계정 수</th><th>완료</th><th>대기</th><th>거절</th><th>기타</th><th style="text-align:left">인증 완료율</th></tr></thead>' +
          '<tbody>' + (snsRows || '<tr><td colspan="7" style="text-align:center;color:#98a2b3">데이터 없음</td></tr>') + '</tbody></table></div>' +
      '</div>' +

      '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px;margin-bottom:12px">' +
        '<div style="font-size:13px;font-weight:700;margin-bottom:4px">⚡ 활성화 분석 — 가입 회원이 실제 캠페인에 지원했는가 <span style="font-size:11px;font-weight:400;color:#8a94a6">(가입월 코호트 · 최근 12개월 · 지원 이력 기준)</span></div>' +
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:720px">' +
          '<thead><tr><th>가입월</th><th>가입</th><th>캠페인 지원</th><th>미지원</th><th style="text-align:left">활성화율</th><th>첫 지원까지 평균</th></tr></thead>' +
          '<tbody>' + cohRows + '</tbody></table></div>' +
        '<div style="font-size:10.5px;color:#98a2b3;margin-top:8px">활성화 = 캠페인 지원 1건 이상 · 첫 지원일은 이력의 최초 처리일 기준(근사) · 활성화율 50% 미만 = 주황</div>' +
      '</div>' +

      '<div style="background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px 16px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:8px">' +
          '<div style="font-size:13px;font-weight:700">🚨 온보딩 필요 회원 <span style="font-size:11px;font-weight:400;color:#8a94a6">— 가입 후 캠페인 미지원 · 경과일 긴 순 · ' + f(obs.length) + '명' + (obs.length > 300 ? ' (상위 300명 표시)' : '') + '</span></div>' +
          '<div style="display:flex;gap:5px">' +
            pill(MV.obWin === 90, '최근 90일', 'window.PTMEM&&PTMEM.win(90)') +
            pill(MV.obWin === 0, '전체', 'window.PTMEM&&PTMEM.win(0)') +
            '<button onclick="window.PTMEM&&PTMEM.csvOb()" style="font-size:11.5px;padding:4px 10px;border-radius:8px;background:#fff;border:1px solid #e5e8ee;color:#667085;cursor:pointer">⬇ CSV</button>' +
          '</div></div>' +
        '<div style="overflow:auto;max-height:430px"><table style="width:100%;border-collapse:collapse;min-width:760px">' +
          '<thead><tr><th>회원</th><th>가입일</th><th>경과</th><th>유입경로</th><th>SNS 인증</th><th>상태</th><th style="text-align:left">단계</th></tr></thead>' +
          '<tbody>' + (obRows || '<tr><td colspan="7" style="text-align:center;color:#0f6e56">✅ 해당 기간 온보딩 필요 회원이 없습니다.</td></tr>') + '</tbody></table></div>' +
        '<div style="font-size:10.5px;color:#98a2b3;margin-top:8px">단계: 가입 14일 미만 🌱 신규 / 14~45일 💬 재안내 / 45일 초과 🚨 장기 미지원 · 회원번호로 어드민 회원 정보 관리에서 검색</div>' +
      '</div>' +
      '</div>';

    hookTooltip();   // [v6] 추이 차트 호버 툴팁

    /* 미수집분 있으면 자동 수집 시작 — [v4] 서버가 이미 수집 완료(remaining=0)를
       보고한 세션에서는 재시작하지 않는다(KV 반영 지연으로 covered<100%로 보여도
       render→crawl 무한 반복·KV 되감기 유발 방지) */
    if (covPct < 100 && !crawlDone) crawl();
  }

  /* ── 탭 전환 ── */
  function show() {
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (x) { x.classList.remove('active'); });
    var p = document.getElementById('tab-member'); if (p) p.classList.add('active');
    var b = document.getElementById('tab-btn-member'); if (b) b.classList.add('active');
    render();
    if (!SNAP && !loading) loadData(render);
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
    reload: function () { SNAP = null; AP = null; crawlMsg = ''; crawlDone = false; loadData(render); render(); },
    view: function (v) { MV.view = v; render(); },
    month: function (m) { MV.selMonth = m; render(); },
    win: function (w) { MV.obWin = w; render(); },
    crawl: crawl,
    csvTrend: function () {
      if (!SNAP) return;
      var byM = {};
      SNAP.members.forEach(function (m) {
        var mk = d10(m.join).slice(0, 7); if (!mk) return;
        if (!byM[mk]) byM[mk] = { t: 0 };
        byM[mk].t++;
        var id = inflowOf(m.inflow).id || 'NONE';
        byM[mk][id] = (byM[mk][id] || 0) + 1;
      });
      var chIds = INFLOW.map(function (c) { return c.id || 'NONE'; });
      var head = '월,신규합계,' + INFLOW.map(function (c) { return '"' + c.label + '"'; }).join(',');
      var lines = Object.keys(byM).sort().map(function (k) {
        return '"' + k + '",' + byM[k].t + ',' + chIds.map(function (id) { return byM[k][id] || 0; }).join(',');
      });
      csvDownload('pointail_앱회원_유입경로_월별.csv', head, lines);
    },
    csvOb: function () {
      if (!SNAP) return;
      var today = todayStr();
      var lines = [];
      SNAP.members.forEach(function (m) {
        var e = AP && AP[m.no];
        if (e === undefined || e.c > 0 || isOut(m)) return;
        lines.push('"' + (m.name || '') + '",' + m.no + ',"' + d10(m.join) + '",' + (dayDiff(d10(m.join), today) || 0) + ',"' + inflowOf(m.inflow).label + '","' + m.state + '"');
      });
      csvDownload('pointail_온보딩필요회원.csv', '이름,회원번호,가입일,경과일,유입경로,상태', lines);
    }
  };

  var t = null;
  function sched() { clearTimeout(t); t = setTimeout(function () { try { ensure(); } catch (e) {} }, 250); }
  function start() {
    try { new MutationObserver(sched).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    ensure();
    loadData(function () {
      var p = document.getElementById('tab-member');
      if (p && p.classList.contains('active')) render();   // 로드 완료 시 열려 있으면 즉시 반영
    });
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
