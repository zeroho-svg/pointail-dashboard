/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 광고주 관리 모듈  (pointail-advertiser.js)
 *
 *  "🏢 광고주 관리" 상위 탭 + 하위 3탭:
 *    · 광고주 목록  — 회원가입DB(DB.member) × 캠페인DB(DB.camp, 법인명 조인)
 *    · 영업담당자  — 담당자별 실적/담당 광고주 히스토리
 *    · 재신청 관리 — 마지막 캠페인 신청일 경과 기준(1주·2주·1개월·2개월+) 재신청 파악
 *  매출 4종: (계약)전체=contractFinal · (계약)서비스=contractMktCost ·
 *            (실행)전체=execTotalAmount · (실행)서비스=execNetAmount
 *  업체 소통방식(단톡방/이메일/기타[메모], 중복선택)은 Cloudflare KV(/contacts)에 공유 저장.
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var EP_CONTACTS = WORKER + 'contacts';
  var CH_LIST = ['단톡방', '이메일', '기타'];
  var CONTACTS = {};
  var view = 'adv';
  var advLimit = 15, reLimit = 15;   // 15개 표시 + 더보기(+20)

  function n(v) { return parseFloat(String(v == null ? 0 : v).replace(/[,\s₩¥]/g, '')) || 0; }
  function f(v) { return Math.round(n(v)).toLocaleString('ko-KR'); }
  function won(v) { return f(v) + '원'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]; }); }
  function d(s) { return String(s || '').slice(0, 10); }
  function members() { return (typeof DB !== 'undefined' && DB.member) ? DB.member : ((window.DB && window.DB.member) || []); }
  function camps() { return (typeof DB !== 'undefined' && DB.camp) ? DB.camp : ((window.DB && window.DB.camp) || []); }
  function todayStr() { var t = new Date(); return t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2); }
  function daysBetween(a, b) { if (!a || !b) return null; var x = (new Date(b) - new Date(a)) / 86400000; return isFinite(x) ? Math.round(x) : null; }

  function campsOf(company) { company = String(company || '').trim(); return camps().filter(function (c) { return String(c.corpName || '').trim() === company; }); }
  function isActive(st) { return ['모집중', '선정 완료', '등록 대기', '추가 모집중', '등록 완료', '일시 중지'].indexOf(st) >= 0; }

  function advStats(m) {
    var cs = campsOf(m.company);
    var cSale = 0, cSvc = 0, eSale = 0, eSvc = 0, active = 0;
    var dates = [];
    cs.forEach(function (c) {
      cSale += n(c.contractFinal); cSvc += n(c.contractMktCost);
      eSale += n(c.execTotalAmount); eSvc += n(c.execNetAmount);
      if (isActive(c.campaignStatus)) active++;
      if (c.createdAt) dates.push(d(c.createdAt));
    });
    dates.sort();
    var first = dates[0] || '', last = dates[dates.length - 1] || '';
    var leadTime = (cs.length && m.joinDate) ? Math.max(0, daysBetween(m.joinDate, first)) : null;
    var since = last ? daysBetween(last, todayStr()) : null;
    return { cs: cs, count: cs.length, cSale: cSale, cSvc: cSvc, eSale: eSale, eSvc: eSvc, first: first, last: last, active: active, leadTime: leadTime, since: since };
  }

  function repList() { var s = {}; members().forEach(function (m) { if (m.salesRep) s[m.salesRep] = 1; }); return Object.keys(s).sort(); }

  // ── 소통방식 KV ──
  function pullContacts(cb) {
    fetch(EP_CONTACTS + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (o) { CONTACTS = (o && typeof o === 'object' && !('campaigns' in o) && !('source' in o)) ? o : {}; if (cb) cb(); })
      .catch(function () { if (cb) cb(); });
  }
  function saveContact(company, val) {
    fetch(EP_CONTACTS + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (o) {
        var data = (o && typeof o === 'object' && !('campaigns' in o) && !('source' in o)) ? o : {};
        if (val && (val.ch && val.ch.length || val.etc)) data[company] = val; else delete data[company];
        CONTACTS = data;
        renderInner();
        fetch(EP_CONTACTS, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
          .then(function (r) { toast(r.ok ? '✅ 소통방식 저장됨 · 모든 컴퓨터 적용' : '⚠️ 공유 저장 실패(네트워크 확인). /contacts 배포 필요'); })
          .catch(function () { toast('⚠️ 공유 저장 실패 · /contacts 배포 필요'); });
      });
  }
  function chColor(x) { return x === '단톡방' ? ['#e7f7ec', '#128a3a'] : x === '이메일' ? ['#eef2ff', '#4f46e5'] : ['#fef3e2', '#b45309']; }
  function contactChips(company) {
    var c = CONTACTS[company];
    if (!c || !c.ch || !c.ch.length) return '<span class="ptad-muted" style="font-size:11px">미설정</span>';
    var chips = c.ch.map(function (x) { var col = chColor(x); return '<span style="display:inline-block;font-size:10px;padding:1px 7px;border-radius:20px;background:' + col[0] + ';color:' + col[1] + '">' + esc(x) + '</span>'; }).join(' ');
    return chips + ((c.ch.indexOf('기타') >= 0 && c.etc) ? '<div style="font-size:10px;color:#98a2b3;margin-top:2px">' + esc(c.etc) + '</div>' : '');
  }

  function toast(msg) {
    var t = document.getElementById('ptad-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ptad-toast'; t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:2000;opacity:0;transition:opacity .2s;box-shadow:0 6px 20px rgba(0,0,0,.25)'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; clearTimeout(t._tm); t._tm = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }
  function kpi(l, v, s, color) { return '<div class="ptad-kpi"><div class="ptad-l">' + esc(l) + '</div><div class="ptad-v" style="color:' + (color || '#111') + '">' + v + '</div>' + (s ? '<div class="ptad-s">' + esc(s) + '</div>' : '') + '</div>'; }
  function typeBadge(t) { return '<span class="ptad-badge" style="background:' + (t === '대행사' ? '#fef3e2;color:#b45309' : '#eef2ff;color:#4f46e5') + '">' + esc(t || '-') + '</span>'; }
  function statusBadge(s) { var on = s === '정상'; return '<span style="font-size:11px;color:' + (on ? '#128a3a' : '#c0392b') + '">' + esc(s || '-') + '</span>'; }
  function stChip(s) { return '<span style="font-size:11px;padding:1px 7px;border-radius:6px;background:#eef1f5;color:#556">' + esc(s) + '</span>'; }

  // ══════════ 하위 탭 렌더 ══════════
  function renderInner() {
    var host = document.getElementById('ptad-view'); if (!host) return;
    if (!members().length) {
      host.innerHTML = '<div class="ptad-card" style="text-align:center;color:#8a94a6;padding:30px">회원 데이터가 없습니다. 상단 <b>⚡ API 동기화</b>를 눌러 회원가입DB를 불러온 뒤 다시 열어주세요.</div>';
      return;
    }
    if (view === 'adv') host.innerHTML = renderAdvList();
    else if (view === 'rep') host.innerHTML = renderReps();
    else host.innerHTML = renderReapply();
    wire();
  }

  function renderAdvList() {
    advLimit = 15;
    var rows = members().map(function (m) { return { m: m, s: advStats(m) }; });
    var withCamp = rows.filter(function (r) { return r.s.count > 0; }).length;
    var T = { cSale: 0, cSvc: 0, eSale: 0, eSvc: 0 };
    rows.forEach(function (r) { T.cSale += r.s.cSale; T.cSvc += r.s.cSvc; T.eSale += r.s.eSale; T.eSvc += r.s.eSvc; });
    var totCamps = camps().length;
    var cards = '<div class="ptad-cards">' +
      kpi('전체 광고주', members().length + '개') +
      kpi('캠페인 진행', withCamp + '개', '전환율 ' + (members().length ? Math.round(withCamp / members().length * 100) : 0) + '%', '#128a3a') +
      kpi('가입만·미진행', (members().length - withCamp) + '개', '후속 영업 대상') +
      kpi('총 캠페인', totCamps + '건') + '</div>' +
      '<div class="ptad-cards">' +
      kpi('(계약) 전체 매출', won(T.cSale)) + kpi('(계약) 서비스 매출', won(T.cSvc)) +
      kpi('(실행) 전체 매출', won(T.eSale)) + kpi('(실행) 서비스 매출', won(T.eSvc)) + '</div>';

    var reps = ['(전체)'].concat(repList());
    var toolbar = '<div class="ptad-toolbar">' +
      '<input id="ptad-q" placeholder="법인명·회원번호·담당자 검색" style="min-width:200px">' +
      '<select id="ptad-ftype"><option value="">유형 전체</option><option>일반 광고주</option><option>대행사</option></select>' +
      '<select id="ptad-frep">' + reps.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select>' +
      '<select id="ptad-fcamp"><option value="">진행여부 전체</option><option value="y">캠페인 있음</option><option value="n">가입만</option></select>' +
      '<span class="ptad-muted" style="font-size:12px" id="ptad-cnt"></span></div>';

    var body = rows.sort(function (a, b) { return b.s.cSale - a.s.cSale; }).map(function (r) {
      return '<tr class="ptad-click ptad-adv-row" data-company="' + esc(r.m.company) + '" data-mno="' + esc(r.m.memberNo || '') + '" data-type="' + esc(r.m.joinType || '') + '" data-rep="' + esc(r.m.salesRep || '') + '" data-has="' + (r.s.count > 0 ? 'y' : 'n') + '">' +
        '<td><b>' + esc(r.m.company || '(법인명 없음)') + '</b> <span class="ptad-muted" style="font-size:11px">#' + esc(r.m.memberNo || '') + '</span> ' + typeBadge(r.m.joinType) + '</td>' +
        '<td>' + (r.m.salesRep ? esc(r.m.salesRep) : '<span class="ptad-muted">미배정</span>') + '</td>' +
        '<td>' + contactChips(r.m.company) + ' <button class="ptad-btn ptad-ct-edit" data-company="' + esc(r.m.company) + '" style="padding:2px 8px;font-size:11px;margin-top:2px">설정</button></td>' +
        '<td class="ptad-muted">' + esc(r.m.joinDate || '') + '</td>' +
        '<td class="c">' + (r.s.count || '<span class="ptad-muted">0</span>') + '</td>' +
        '<td class="r"><b>' + f(r.s.cSale) + '</b></td>' +
        '<td class="r ptad-muted">' + f(r.s.cSvc) + '</td>' +
        '<td class="r">' + f(r.s.eSale) + '</td>' +
        '<td class="r ptad-muted">' + f(r.s.eSvc) + '</td>' +
        '<td class="ptad-muted">' + (r.s.last || '—') + '</td>' +
        '<td class="c">' + statusBadge(r.m.accountStatus) + '</td>' +
        '<td class="c"><button class="ptad-btn ptad-p ptad-adv-open" data-company="' + esc(r.m.company) + '">상세</button></td></tr>';
    }).join('');

    return cards + '<div class="ptad-card"><h3>광고주 목록 <span class="ptad-muted" style="font-weight:400;font-size:12px">— 행 클릭 시 상세</span></h3>' +
      toolbar + '<div style="overflow:auto"><table class="ptad-tbl"><thead><tr>' +
      '<th>법인명</th><th>영업담당자</th><th style="min-width:150px">소통방식</th><th>가입일</th><th class="c">캠페인</th>' +
      '<th class="r">계약 전체</th><th class="r">계약 서비스</th><th class="r">실행 전체</th><th class="r">실행 서비스</th>' +
      '<th>최근 캠페인</th><th>상태</th><th></th></tr></thead><tbody id="ptad-body">' + body + '</tbody></table></div>' +
      '<div style="text-align:center;margin:10px 0"><button id="ptad-more" class="ptad-btn ptad-p" style="padding:8px 18px">더보기</button></div></div>';
  }

  function renderReps() {
    var reps = repList();
    var stat = {};
    reps.forEach(function (r) { stat[r] = { advs: [], cSale: 0, cSvc: 0, eSale: 0, eSvc: 0, camps: 0, contracted: 0 }; });
    members().forEach(function (m) { var r = m.salesRep; if (!r || !stat[r]) return; var s = advStats(m); stat[r].advs.push({ m: m, s: s }); stat[r].cSale += s.cSale; stat[r].cSvc += s.cSvc; stat[r].eSale += s.eSale; stat[r].eSvc += s.eSvc; stat[r].camps += s.count; if (s.count > 0) stat[r].contracted++; });
    var T = { cSale: 0, cSvc: 0, eSale: 0, eSvc: 0 };
    reps.forEach(function (r) { T.cSale += stat[r].cSale; T.cSvc += stat[r].cSvc; T.eSale += stat[r].eSale; T.eSvc += stat[r].eSvc; });
    var unassigned = members().filter(function (m) { return !m.salesRep; }).length;
    var cards = '<div class="ptad-cards">' +
      kpi('영업담당자', reps.length + '명') +
      kpi('담당 광고주', (members().length - unassigned) + '개') +
      kpi('미배정 광고주', unassigned + '개', '배정 필요') + '</div>' +
      '<div class="ptad-cards">' +
      kpi('(계약) 전체 매출', won(T.cSale)) + kpi('(계약) 서비스 매출', won(T.cSvc)) +
      kpi('(실행) 전체 매출', won(T.eSale)) + kpi('(실행) 서비스 매출', won(T.eSvc)) + '</div>';
    var body = reps.sort(function (a, b) { return stat[b].cSale - stat[a].cSale; }).map(function (r) {
      var s = stat[r];
      return '<tr class="ptad-click ptad-rep-row" data-rep="' + esc(r) + '">' +
        '<td><span class="ptad-avatar">' + esc(r.charAt(0)) + '</span><b>' + esc(r) + '</b></td>' +
        '<td class="c">' + s.advs.length + '</td><td class="c">' + s.contracted + '</td><td class="c">' + s.camps + '</td>' +
        '<td class="r"><b>' + f(s.cSale) + '</b></td><td class="r ptad-muted">' + f(s.cSvc) + '</td>' +
        '<td class="r">' + f(s.eSale) + '</td><td class="r ptad-muted">' + f(s.eSvc) + '</td>' +
        '<td class="c"><button class="ptad-btn ptad-p ptad-rep-open" data-rep="' + esc(r) + '">히스토리</button></td></tr>';
    }).join('');
    return cards + '<div class="ptad-card"><h3>영업담당자별 현황 <span class="ptad-muted" style="font-weight:400;font-size:12px">— 행 클릭 시 담당 광고주 전체 히스토리</span></h3>' +
      '<div style="overflow:auto"><table class="ptad-tbl"><thead><tr><th>담당자</th><th class="c">담당 광고주</th><th class="c">진행</th><th class="c">캠페인</th>' +
      '<th class="r">계약 전체</th><th class="r">계약 서비스</th><th class="r">실행 전체</th><th class="r">실행 서비스</th><th></th></tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }

  function bucketOf(since, count) {
    if (!count) return 'new';
    if (since == null) return 'new';
    if (since <= 7) return 'w1'; if (since <= 14) return 'w2'; if (since <= 30) return 'm1'; if (since <= 60) return 'm2'; return 'm2plus';
  }
  var BUCKETS = [['w1', '1주 이내', '#128a3a'], ['w2', '2주', '#185fa5'], ['m1', '1개월', '#b45309'], ['m2', '2개월', '#c0392b'], ['m2plus', '2개월+', '#a32d2d'], ['new', '신규 미진행', '#8a94a6']];
  function renderReapply() {
    reLimit = 15;
    var rows = members().map(function (m) { var s = advStats(m); return { m: m, s: s, bk: bucketOf(s.since, s.count) }; });
    var cnt = {}; BUCKETS.forEach(function (b) { cnt[b[0]] = 0; }); rows.forEach(function (r) { cnt[r.bk] = (cnt[r.bk] || 0) + 1; });
    var chips = '<div class="ptad-cards" style="margin-bottom:14px">' + BUCKETS.map(function (b) { return kpi(b[1], (cnt[b[0]] || 0) + '개', '', b[2]); }).join('') + '</div>';
    var order = { w1: 1, w2: 2, m1: 3, m2: 4, m2plus: 5, new: 6 };
    var body = rows.sort(function (a, b) { return (b.s.since || -1) - (a.s.since || -1); }).map(function (r) {
      var bk = BUCKETS.filter(function (x) { return x[0] === r.bk; })[0];
      var reapply = r.s.count === 0 ? '<span class="ptad-muted">0회</span>' : r.s.count + '회';
      var act = r.s.count === 0 ? '첫 영업' : (r.s.since > 30 ? '이탈위험·재영업' : (r.s.since > 14 ? '재영업' : '유지'));
      var actColor = r.s.count === 0 ? '#185fa5' : (r.s.since > 30 ? '#c0392b' : (r.s.since > 14 ? '#185fa5' : '#8a94a6'));
      return '<tr class="ptad-click ptad-adv-open ptad-re-row" data-company="' + esc(r.m.company) + '">' +
        '<td><b>' + esc(r.m.company) + '</b> <span class="ptad-muted" style="font-size:11px">#' + esc(r.m.memberNo || '') + '</span></td>' +
        '<td>' + (r.m.salesRep ? esc(r.m.salesRep) : '<span class="ptad-muted">미배정</span>') + '</td>' +
        '<td class="ptad-muted">' + (r.s.last || '<span class="ptad-muted">캠페인 없음</span>') + '</td>' +
        '<td class="r" style="color:' + bk[2] + '">' + (r.s.count ? (r.s.since + '일') : '—') + '</td>' +
        '<td class="c">' + reapply + '</td>' +
        '<td class="c"><span style="font-size:11px;padding:2px 8px;border-radius:20px;background:' + bk[2] + '1f;color:' + bk[2] + '">' + bk[1] + '</span></td>' +
        '<td class="c" style="color:' + actColor + '">' + act + '</td></tr>';
    }).join('');
    return chips + '<div class="ptad-card"><h3>재신청 관리 <span class="ptad-muted" style="font-weight:400;font-size:12px">— 마지막 캠페인 신청일 경과 기준 · 기준일 ' + todayStr() + '</span></h3>' +
      '<div style="overflow:auto"><table class="ptad-tbl"><thead><tr><th>법인명</th><th>담당자</th><th>마지막 신청</th><th class="r">경과</th><th class="c">재신청</th><th class="c">구간</th><th class="c">액션</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div style="text-align:center;margin:10px 0"><button id="ptad-re-more" class="ptad-btn ptad-p" style="padding:8px 18px">더보기</button></div></div>';
  }

  // ── 모달 ──
  function openAdv(company) {
    var m = members().filter(function (x) { return x.company === company; })[0]; if (!m) return;
    var s = advStats(m);
    var kpis = '<div class="ptad-cards">' +
      kpi('총 캠페인', s.count + '건', s.active + '건 진행중') +
      kpi('가입→첫캠페인', s.leadTime != null ? s.leadTime + '일' : '—', '리드타임') +
      kpi('최근 캠페인', s.last || '—', s.since != null ? (s.since + '일 경과') : '') + '</div>' +
      '<div class="ptad-cards">' +
      kpi('(계약) 전체', won(s.cSale)) + kpi('(계약) 서비스', won(s.cSvc)) +
      kpi('(실행) 전체', won(s.eSale)) + kpi('(실행) 서비스', won(s.eSvc)) + '</div>';
    var hist = s.cs.length ? '<div style="overflow:auto"><table class="ptad-tbl"><thead><tr><th>번호</th><th>제목</th><th>유형</th><th>신청일</th><th>상태</th><th>결제</th><th class="r">계약 전체</th><th class="r">계약 서비스</th><th class="r">실행 전체</th><th class="r">실행 서비스</th></tr></thead><tbody>' +
      s.cs.slice().sort(function (a, b) { return d(b.createdAt).localeCompare(d(a.createdAt)); }).map(function (c) {
        return '<tr><td>' + esc(c.campaignNoText || c.campaignNo || '') + '</td><td><b>' + esc(c.campaignTitle || '') + '</b></td><td>' + stChip(c.campaignType || '') + '</td><td class="ptad-muted">' + esc(d(c.createdAt)) + '</td>' +
          '<td>' + stChip(c.campaignStatus || '') + '</td><td>' + esc(c.payStatus || '—') + '</td>' +
          '<td class="r"><b>' + f(c.contractFinal) + '</b></td><td class="r ptad-muted">' + f(c.contractMktCost) + '</td><td class="r">' + f(c.execTotalAmount) + '</td><td class="r ptad-muted">' + f(c.execNetAmount) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<div class="ptad-muted" style="padding:12px 0">아직 진행한 캠페인이 없습니다. (가입만 완료 — 후속 영업 대상)</div>';
    var timeline = '<div class="ptad-tl"><div class="ptad-tl-i"><b>회원가입</b> · ' + esc(m.joinDate || '') + '</div>' +
      s.cs.slice().sort(function (a, b) { return d(a.createdAt).localeCompare(d(b.createdAt)); }).map(function (c) {
        return '<div class="ptad-tl-i">' + esc(d(c.createdAt)) + ' · ' + esc(c.campaignTitle || '') + ' ' + stChip(c.campaignStatus || '') + ' <b>' + won(c.contractFinal) + '</b></div>';
      }).join('') + '</div>';
    var html = '<div class="ptad-mh"><div><div style="font-size:18px;font-weight:800">' + esc(m.company) + ' <span style="font-size:13px;color:#98a2b3">#' + esc(m.memberNo || '') + '</span> ' + typeBadge(m.joinType) + '</div>' +
      '<div class="ptad-meta"><span>가입일 <b>' + esc(m.joinDate || '') + '</b></span><span>영업담당 <b>' + esc(m.salesRep || '미배정') + '</b></span><span>연락처 <b>' + esc(m.phone || '') + '</b></span><span>아이디 <b>' + esc(m.userId || '') + '</b></span><span>상태 <b>' + esc(m.accountStatus || '') + '</b></span><span>마케팅수신 <b>' + esc(m.marketingConsent || '') + '</b></span><span>소통 ' + contactChips(m.company) + ' <button class="ptad-btn ptad-ct-edit" data-company="' + esc(m.company) + '" style="padding:1px 7px;font-size:11px">설정</button></span></div></div>' +
      '<button class="ptad-x" data-close="1">×</button></div>' +
      '<div class="ptad-mb">' + kpis + '<h3 style="font-size:14px;margin:6px 0 8px">캠페인 진행 내역</h3>' + hist +
      '<h3 style="font-size:14px;margin:16px 0 6px">타임라인</h3>' + timeline + '</div>';
    showModal(html);
  }

  function openRep(rep) {
    var advs = members().filter(function (m) { return m.salesRep === rep; }).map(function (m) { return { m: m, s: advStats(m) }; }).sort(function (a, b) { return b.s.cSale - a.s.cSale; });
    var cSale = 0, cSvc = 0, eSale = 0, eSvc = 0, camps2 = 0, contracted = 0;
    advs.forEach(function (r) { cSale += r.s.cSale; cSvc += r.s.cSvc; eSale += r.s.eSale; eSvc += r.s.eSvc; camps2 += r.s.count; if (r.s.count > 0) contracted++; });
    var kpis = '<div class="ptad-cards">' + kpi('담당 광고주', advs.length + '개', contracted + '개 진행중') + kpi('총 캠페인', camps2 + '건') + '</div>' +
      '<div class="ptad-cards">' + kpi('(계약) 전체', won(cSale)) + kpi('(계약) 서비스', won(cSvc)) + kpi('(실행) 전체', won(eSale)) + kpi('(실행) 서비스', won(eSvc)) + '</div>';
    var rows = advs.map(function (r) {
      return '<tr class="ptad-click ptad-adv-open" data-company="' + esc(r.m.company) + '">' +
        '<td><b>' + esc(r.m.company) + '</b> <span class="ptad-muted" style="font-size:11px">#' + esc(r.m.memberNo || '') + '</span> ' + typeBadge(r.m.joinType) + '</td>' +
        '<td class="ptad-muted">' + esc(r.m.joinDate || '') + '</td><td class="c">' + r.s.count + '</td>' +
        '<td class="ptad-muted">' + (r.s.last || '—') + '</td><td class="r"><b>' + f(r.s.cSale) + '</b></td><td class="r">' + f(r.s.eSale) + '</td>' +
        '<td>' + statusBadge(r.m.accountStatus) + '</td></tr>';
    }).join('');
    var html = '<div class="ptad-mh"><div><div style="font-size:18px;font-weight:800"><span class="ptad-avatar">' + esc(rep.charAt(0)) + '</span>' + esc(rep) + ' 담당 히스토리</div>' +
      '<div class="ptad-meta"><span>담당 광고주 <b>' + advs.length + '개</b></span><span>진행 <b>' + contracted + '개</b></span><span>계약 전체 <b>' + won(cSale) + '</b></span></div></div>' +
      '<button class="ptad-x" data-close="1">×</button></div>' +
      '<div class="ptad-mb">' + kpis + '<h3 style="font-size:14px;margin:6px 0 8px">담당 광고주 (매출순) · 클릭 시 개별 상세</h3>' +
      '<div style="overflow:auto"><table class="ptad-tbl"><thead><tr><th>법인명</th><th>가입일</th><th class="c">캠페인</th><th>최근</th><th class="r">계약 전체</th><th class="r">실행 전체</th><th>상태</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    showModal(html);
  }

  function openContact(company) {
    var c = CONTACTS[company] || { ch: [], etc: '' };
    var checks = CH_LIST.map(function (x) {
      var on = (c.ch || []).indexOf(x) >= 0;
      var hint = x === '단톡방' ? '카카오/라인 등 그룹채팅' : x === '이메일' ? '메일 소통' : '직접 기록';
      return '<label style="display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid #e5e9f0;border-radius:9px;cursor:pointer;font-size:14px;margin-bottom:8px"><input type="checkbox" class="ptad-ck" value="' + esc(x) + '"' + (on ? ' checked' : '') + ' style="width:16px;height:16px"> ' + esc(x) + ' <span class="ptad-muted" style="font-size:11px">' + hint + '</span></label>';
    }).join('');
    var etcOn = (c.ch || []).indexOf('기타') >= 0;
    var html = '<div class="ptad-mh"><div><div style="font-size:17px;font-weight:800">소통방식 설정</div><div class="ptad-meta"><span>' + esc(company) + '</span></div></div><button class="ptad-x" data-close="1">×</button></div>' +
      '<div class="ptad-mb"><div style="font-size:13px;color:#556;margin-bottom:10px">중복 선택 가능합니다.</div>' + checks +
      '<div id="ptad-etc-wrap" style="margin:2px 0 4px;' + (etcOn ? '' : 'display:none') + '"><input id="ptad-etc" placeholder="기타 소통방식 메모 (예: 전화 010-..., 라인 @id, 담당자)" value="' + esc(c.etc || '') + '" style="width:100%;padding:9px 10px;border:1px solid #ccc;border-radius:8px"></div>' +
      '<div style="display:flex;gap:8px;margin-top:16px"><button class="ptad-btn ptad-p" id="ptad-ct-save" data-company="' + esc(company) + '" style="padding:8px 16px">저장 (모든 컴퓨터 적용)</button><button class="ptad-btn" data-close="1" style="padding:8px 14px">취소</button></div>' +
      '<div style="font-size:11px;color:#98a2b3;margin-top:10px">저장하면 공유 저장소(Cloudflare KV)에 반영돼 다른 컴퓨터에도 즉시 적용됩니다.</div></div>';
    showModal(html);
    document.querySelectorAll('.ptad-ck').forEach(function (ck) { ck.addEventListener('change', function () { if (ck.value === '기타') { var w = document.getElementById('ptad-etc-wrap'); if (w) w.style.display = ck.checked ? '' : 'none'; } }); });
    document.getElementById('ptad-ct-save').onclick = function () {
      var ch = []; document.querySelectorAll('.ptad-ck').forEach(function (x) { if (x.checked) ch.push(x.value); });
      var etcEl = document.getElementById('ptad-etc'); var etc = etcEl ? (etcEl.value || '').trim() : '';
      closeModal(); saveContact(company, { ch: ch, etc: ch.indexOf('기타') >= 0 ? etc : '' });
    };
  }

  function showModal(html) { document.getElementById('ptad-modal').innerHTML = html; document.getElementById('ptad-overlay').classList.add('open'); wireModal(); }
  function closeModal() { document.getElementById('ptad-overlay').classList.remove('open'); }
  function wireModal() {
    document.querySelectorAll('#ptad-modal [data-close]').forEach(function (b) { b.onclick = closeModal; });
    document.querySelectorAll('#ptad-modal .ptad-ct-edit').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); openContact(b.getAttribute('data-company')); }; });
    document.querySelectorAll('#ptad-modal .ptad-adv-open').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); openAdv(b.getAttribute('data-company')); }; });
    document.querySelectorAll('#ptad-modal table').forEach(function (t) { makeSortable(t, null); });
  }

  function reApplyPag() {
    var rows = document.querySelectorAll('#ptad-view .ptad-re-row');
    rows.forEach(function (tr, i) { tr.style.display = i < reLimit ? '' : 'none'; });
    var rmb = document.getElementById('ptad-re-more');
    if (rmb) { var remain = rows.length - Math.min(reLimit, rows.length); rmb.style.display = remain > 0 ? '' : 'none'; rmb.textContent = '더보기 (+' + Math.min(20, remain) + ') · 남은 ' + remain + '개'; }
  }

  // ── 컬럼 머리글 클릭 정렬(⇅ ▲ ▼) ──
  function cellSortVal(td) {
    var raw = (td ? td.textContent : '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return { num: null, str: raw };               // 날짜 → 연대순(문자열)
    var txt = raw.replace(/[,\s원일개회%#★]/g, '');
    if (txt !== '' && /^[-+]?\d/.test(txt) && !isNaN(parseFloat(txt))) return { num: parseFloat(txt), str: raw.toLowerCase() };
    return { num: null, str: raw.toLowerCase() };
  }
  function makeSortable(table, afterSort) {
    if (!table) return;
    var ths = table.querySelectorAll('thead th');
    ths.forEach(function (th, idx) {
      if (th.__sortable || !th.textContent.trim()) return; th.__sortable = true;
      th.style.cursor = 'pointer'; th.style.userSelect = 'none';
      var ind = document.createElement('span'); ind.className = 'ptad-si'; ind.style.cssText = 'margin-left:3px;color:#b0b7c3;font-size:10px'; ind.textContent = '⇅'; th.appendChild(ind);
      th.addEventListener('click', function () {
        var tbody = table.querySelector('tbody'); if (!tbody) return;
        var rows = [].slice.call(tbody.children).filter(function (r) { return r.tagName === 'TR' && r.children.length > idx; });
        var dir = th.__dir === 'asc' ? 'desc' : 'asc'; th.__dir = dir;
        ths.forEach(function (o) { if (o !== th) { o.__dir = null; var oi = o.querySelector('.ptad-si'); if (oi) { oi.textContent = '⇅'; oi.style.color = '#b0b7c3'; } } });
        ind.textContent = dir === 'asc' ? '▲' : '▼'; ind.style.color = '#2563eb';
        rows.sort(function (a, b) {
          var va = cellSortVal(a.children[idx]), vb = cellSortVal(b.children[idx]), r;
          if (va.num !== null && vb.num !== null) r = va.num - vb.num;
          else r = va.str < vb.str ? -1 : (va.str > vb.str ? 1 : 0);
          return dir === 'asc' ? r : -r;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
        if (afterSort) afterSort();
      });
    });
  }

  function applyFilter() {
    var q = (document.getElementById('ptad-q').value || '').trim().toLowerCase();
    var ft = document.getElementById('ptad-ftype').value, fr = document.getElementById('ptad-frep').value, fc = document.getElementById('ptad-fcamp').value;
    var passed = 0, shown = 0;
    document.querySelectorAll('#ptad-body .ptad-adv-row').forEach(function (tr) {
      var comp = tr.getAttribute('data-company').toLowerCase(), rep = (tr.getAttribute('data-rep') || '').toLowerCase(), mno = (tr.getAttribute('data-mno') || '').toLowerCase();
      var ok = true;
      if (q && comp.indexOf(q) < 0 && rep.indexOf(q) < 0 && mno.indexOf(q) < 0) ok = false;
      if (ft && tr.getAttribute('data-type') !== ft) ok = false;
      if (fr && fr !== '(전체)' && (tr.getAttribute('data-rep') || '') !== fr) ok = false;
      if (fc === 'y' && tr.getAttribute('data-has') !== 'y') ok = false;
      if (fc === 'n' && tr.getAttribute('data-has') !== 'n') ok = false;
      if (ok) { passed++; if (passed <= advLimit) { tr.style.display = ''; shown++; } else tr.style.display = 'none'; }
      else tr.style.display = 'none';
    });
    var cnt = document.getElementById('ptad-cnt'); if (cnt) cnt.textContent = passed + '개 중 ' + shown + '개 표시';
    var mb = document.getElementById('ptad-more');
    if (mb) { var remain = passed - shown; mb.style.display = remain > 0 ? '' : 'none'; mb.textContent = '더보기 (+' + Math.min(20, remain) + ') · 남은 ' + remain + '개'; }
  }

  function wire() {
    var host = document.getElementById('ptad-view'); if (!host) return;
    host.querySelectorAll('.ptad-ct-edit').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); openContact(b.getAttribute('data-company')); }; });
    host.querySelectorAll('.ptad-adv-open').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); openAdv(b.getAttribute('data-company')); }; });
    host.querySelectorAll('.ptad-adv-row').forEach(function (tr) { tr.onclick = function () { openAdv(tr.getAttribute('data-company')); }; });
    host.querySelectorAll('.ptad-rep-row, .ptad-rep-open').forEach(function (el) { el.onclick = function (e) { e.stopPropagation(); openRep(el.getAttribute('data-rep')); }; });
    ['ptad-q', 'ptad-ftype', 'ptad-frep', 'ptad-fcamp'].forEach(function (id) { var el = document.getElementById(id); if (el) el.addEventListener('input', function () { advLimit = 15; applyFilter(); }); });
    var mb = document.getElementById('ptad-more'); if (mb) mb.onclick = function () { advLimit += 20; applyFilter(); };
    if (document.getElementById('ptad-cnt')) applyFilter();
    // 재신청 관리 더보기
    var rmb = document.getElementById('ptad-re-more');
    if (rmb) { rmb.onclick = function () { reLimit += 20; reApplyPag(); }; reApplyPag(); }
    // 컬럼 머리글 클릭 정렬(⇅) — 현재 뷰의 모든 표
    var sortCb = view === 'adv' ? function () { advLimit = 15; applyFilter(); } : (view === 'reapply' ? function () { reLimit = 15; reApplyPag(); } : null);
    host.querySelectorAll('table').forEach(function (t) { makeSortable(t, sortCb); });
  }

  // ── 스타일 ──
  function ensureStyle() {
    if (document.getElementById('ptad-style')) return;
    var s = document.createElement('style'); s.id = 'ptad-style';
    s.textContent = '.ptad-subnav{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 14px}.ptad-subtab{border:none;background:#eef1f5;color:#48505c;padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600}.ptad-subtab.active{background:#0ea5a4;color:#fff}' +
      '.ptad-cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.ptad-kpi{flex:1;min-width:140px;background:#fff;border:1px solid #eef0f3;border-radius:10px;padding:11px 13px}.ptad-l{font-size:12px;color:#8a94a6}.ptad-v{font-size:20px;font-weight:800;margin-top:2px}.ptad-s{font-size:11px;color:#aab;margin-top:2px}' +
      '.ptad-card{background:#fff;border:1px solid #eef0f3;border-radius:12px;padding:14px;margin-bottom:16px}.ptad-card h3{font-size:14px;margin:0 0 10px}' +
      '.ptad-tbl{width:100%;border-collapse:collapse;font-size:13px}.ptad-tbl th{background:#f7f8fa;color:#556;text-align:left;padding:9px 10px;font-weight:600;white-space:nowrap;position:sticky;top:0}.ptad-tbl td{padding:9px 10px;border-bottom:1px solid #f2f4f7}.ptad-tbl .r{text-align:right}.ptad-tbl .c{text-align:center}' +
      '.ptad-click{cursor:pointer}.ptad-click:hover td{background:#f5f9ff}.ptad-muted{color:#98a2b3}' +
      '.ptad-badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:10px;font-weight:600}' +
      '.ptad-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.ptad-toolbar input,.ptad-toolbar select{font-size:13px;padding:7px 9px;border:1px solid #ccc;border-radius:7px;background:#fff}' +
      '.ptad-btn{border:1px solid #d0d5dd;background:#fff;border-radius:7px;padding:6px 11px;font-size:12px;cursor:pointer}.ptad-btn.ptad-p{background:#2563eb;color:#fff;border-color:#2563eb}' +
      '.ptad-avatar{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#e0e7ff;color:#4338ca;font-weight:700;font-size:12px;margin-right:8px}' +
      '.ptad-overlay{position:fixed;inset:0;background:rgba(15,20,30,.45);display:none;align-items:flex-start;justify-content:center;padding:32px 16px;z-index:1500;overflow:auto}.ptad-overlay.open{display:flex}' +
      '.ptad-modal{background:#fff;border-radius:14px;max-width:940px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)}.ptad-mh{padding:16px 20px;border-bottom:1px solid #eef0f3;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.ptad-mb{padding:16px 20px}' +
      '.ptad-x{border:none;background:#f1f3f5;border-radius:8px;width:32px;height:32px;font-size:18px;cursor:pointer;color:#667}.ptad-meta{display:flex;flex-wrap:wrap;gap:5px 16px;font-size:12.5px;color:#556;margin-top:6px}.ptad-meta b{color:#1a1f29}' +
      '.ptad-tl{border-left:2px solid #e5e9f0;margin:6px 0 0 8px;padding-left:14px}.ptad-tl-i{padding:5px 0;font-size:12.5px;color:#667}';
    document.head.appendChild(s);
  }

  // ── 탭 주입 ──
  function ensureTab() {
    ensureStyle();
    if (!document.getElementById('ptad-overlay')) { var ov = document.createElement('div'); ov.id = 'ptad-overlay'; ov.className = 'ptad-overlay'; ov.innerHTML = '<div class="ptad-modal" id="ptad-modal"></div>'; document.body.appendChild(ov); ov.addEventListener('click', function (e) { if (e.target === ov) closeModal(); }); }
    if (!document.getElementById('tab-advmgr')) {
      var ref = document.getElementById('tab-dashboard') || document.querySelector('.panel');
      if (ref && ref.parentNode) { var p = document.createElement('div'); p.id = 'tab-advmgr'; p.className = 'panel'; p.style.cssText = 'padding:4px 2px'; ref.parentNode.appendChild(p); }
    }
    if (!document.getElementById('tab-btn-advmgr')) {
      var after = document.getElementById('tab-btn-meta') || document.getElementById('tab-btn-sales-perf');
      var b = document.createElement('button');
      b.id = 'tab-btn-advmgr'; b.className = after ? after.className : 'tab'; b.textContent = '🏢 광고주 관리'; b.onclick = show;
      if (after && after.parentNode) after.parentNode.insertBefore(b, after.nextSibling);
      else { var nav = document.getElementById('main-tabs'); if (nav) nav.appendChild(b); }
    }
  }
  function renderShell() {
    var host = document.getElementById('tab-advmgr'); if (!host) return;
    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:2px">' +
        '<h2 style="margin:0;font-size:18px">🏢 광고주 관리 <span style="font-size:12px;font-weight:400;color:#889">— 회원가입DB × 캠페인 이력</span></h2>' +
        '<button id="ptad-refresh" class="ptad-btn" style="font-size:12px">↻ 새로고침</button></div>' +
      '<div class="ptad-subnav" id="ptad-subnav">' +
        '<button class="ptad-subtab' + (view === 'adv' ? ' active' : '') + '" data-v="adv">👥 광고주 목록</button>' +
        '<button class="ptad-subtab' + (view === 'rep' ? ' active' : '') + '" data-v="rep">🧑‍💼 영업담당자</button>' +
        '<button class="ptad-subtab' + (view === 'reapply' ? ' active' : '') + '" data-v="reapply">🔁 재신청 관리</button></div>' +
      '<div id="ptad-view"></div>';
    document.getElementById('ptad-subnav').addEventListener('click', function (e) { var b = e.target.closest('.ptad-subtab'); if (!b) return; view = b.getAttribute('data-v'); [].forEach.call(document.querySelectorAll('#ptad-subnav .ptad-subtab'), function (x) { x.classList.toggle('active', x === b); }); renderInner(); });
    document.getElementById('ptad-refresh').onclick = function () { pullContacts(function () { renderInner(); toast('↻ 최신 소통방식으로 새로고침'); }); };
    renderInner();
  }
  function show() {
    ensureTab();
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (t) { t.classList.remove('active'); });
    var p = document.getElementById('tab-advmgr'); if (p) p.classList.add('active');
    var b = document.getElementById('tab-btn-advmgr'); if (b) b.classList.add('active');
    renderShell();
  }
  if (typeof window.showTab === 'function' && !window.showTab.__advWrapped) {
    var _st = window.showTab; window.showTab = function () { var b = document.getElementById('tab-btn-advmgr'); if (b) b.classList.remove('active'); return _st.apply(this, arguments); }; window.showTab.__advWrapped = true;
  }
  window.PTADV = { show: show };

  function init() { ensureTab(); pullContacts(function () { var p = document.getElementById('tab-advmgr'); if (p && p.classList.contains('active')) renderShell(); }); }
  var tries = 0;
  var iv = setInterval(function () { tries++; if (document.getElementById('main-tabs') || tries > 100) { clearInterval(iv); init(); } }, 300);
})();
