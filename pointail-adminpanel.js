/**
 * ─────────────────────────────────────────────────────────────
 *  ⚙️ 대시보드 관리 패널 (포인테일 · 퍼그제로 공용 모듈) v1
 * ─────────────────────────────────────────────────────────────
 *  사용자 관리(초대·역할·활성) + 사용 통계 + 활동 로그.
 *  데이터는 공용 Worker(/admin/*) — 어느 대시보드에서 수정해도 양쪽 적용.
 *  ADMIN 이상에게만 UI 노출(서버에서도 강제).
 *
 *  · 퍼그제로: pugzero.html이 PTADMIN.mount(el, {wfetch}) 호출
 *  · 포인테일: 이 모듈이 자동으로 ⚙️ 관리 그룹에 「👥 사용자·통계」 탭 생성
 */
(function () {
  'use strict';
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var ROLE_LV = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1 };
  var ROLE_BADGE = { OWNER: 'pta-vio', ADMIN: 'pta-blu', MEMBER: 'pta-gry', VIEWER: 'pta-gry' };
  var ACT_BADGE = { login: ['로그인', 'pta-blu'], write: ['쓰기', 'pta-amb'], sync: ['동기화', 'pta-grn'], admin: ['관리', 'pta-vio'] };

  function decodeTok(tok) {
    try {
      var p = tok.slice(0, tok.lastIndexOf('.')).replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(atob(p).split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')));
    } catch (e) { return null; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fdt(t) { if (!t) return '–'; var d = new Date(t); return (d.getMonth() + 1 + '').padStart ? String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : d.toLocaleString(); }
  function f(n) { return (Math.round(n) || 0).toLocaleString('ko-KR'); }

  function css() {
    if (document.getElementById('pta-style')) return;
    var st = document.createElement('style'); st.id = 'pta-style';
    st.textContent =
      '.pta{font-size:13.5px;line-height:1.55;color:#1a1f29;text-align:left}' +
      '.pta *{box-sizing:border-box}' +
      '.pta-tabs{display:flex;gap:6px;margin-bottom:14px}' +
      '.pta-tab{border:1px solid #e6e8ee;background:#fff;border-radius:99px;padding:6px 15px;font:inherit;font-size:12.5px;font-weight:700;color:#5b6472;cursor:pointer}' +
      '.pta-tab.on{background:#1a1f29;border-color:#1a1f29;color:#fff}' +
      '.pta-card{background:#fff;border:1px solid #e6e8ee;border-radius:13px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 3px rgba(16,24,40,.05)}' +
      '.pta-card h4{margin:0 0 2px;font-size:14.5px}' +
      '.pta-td{font-size:11.5px;color:#8a94a6;margin-bottom:12px}' +
      '.pta table{width:100%;border-collapse:collapse;font-size:12.5px}' +
      '.pta th{font-size:11px;color:#8a94a6;text-align:left;padding:7px 8px;border-bottom:1px solid #e6e8ee;font-weight:600;white-space:nowrap}' +
      '.pta td{padding:8px;border-bottom:1px solid #f0f2f6;white-space:nowrap}' +
      '.pta-b{display:inline-block;font-size:10.5px;font-weight:700;border-radius:99px;padding:2px 8px}' +
      '.pta-grn{background:#eefaf3;color:#12805c}.pta-gry{background:#eef0f4;color:#5b6472}' +
      '.pta-red{background:#fdf0ee;color:#c0392b}.pta-amb{background:#fdf3e4;color:#b45309}' +
      '.pta-blu{background:#eaf1fe;color:#1d4ed8}.pta-vio{background:#f1ebfd;color:#6b46c1}' +
      '.pta select,.pta input[type=text],.pta input[type=email]{border:1px solid #e6e8ee;border-radius:7px;padding:6px 9px;font:inherit;font-size:12px;background:#fff;color:#1a1f29}' +
      '.pta-btn{border:none;border-radius:8px;background:#2563eb;color:#fff;font:inherit;font-weight:700;font-size:12px;padding:7px 13px;cursor:pointer}' +
      '.pta-btn.gh{background:#fff;color:#5b6472;border:1px solid #e6e8ee}' +
      '.pta-btn.dn{background:#fff;color:#c0392b;border:1px solid #eecfc9}' +
      '.pta-invite{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;background:#fafbfd;border:1px solid #e6e8ee;border-radius:11px;padding:12px 14px;margin-bottom:14px}' +
      '.pta-invite label{display:block;font-size:10.5px;color:#8a94a6;font-weight:600;margin-bottom:3px}' +
      '.pta-mut{color:#8a94a6}' +
      '.pta-msg{font-size:12px;margin-left:10px;font-weight:600}' +
      '.pta-hrow{display:flex;align-items:center;gap:10px;margin:7px 0}' +
      '.pta-hrow .nm{width:150px;font-size:12px;font-weight:600;color:#5b6472;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.pta-trk{flex:1;height:11px;background:#eef0f4;border-radius:6px;overflow:hidden}' +
      '.pta-fill{height:100%;border-radius:6px;background:#2563eb}' +
      '.pta-val{width:170px;text-align:right;font-size:12px;font-weight:700;white-space:nowrap}' +
      '.pta-log{display:flex;gap:9px;align-items:baseline;padding:7px 4px;border-bottom:1px solid #f0f2f6;font-size:12px}' +
      '.pta-log .t{color:#8a94a6;font-size:11px;width:88px;flex-shrink:0}' +
      '.pta-log .w{font-weight:700;width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis}' +
      '.pta-pol{display:flex;align-items:center;gap:10px;background:#fafbfd;border:1px solid #e6e8ee;border-radius:11px;padding:10px 14px;margin-bottom:14px;font-size:12.5px}';
    document.head.appendChild(st);
  }

  function mount(el, opts) {
    css();
    var WF = opts && opts.wfetch ? opts.wfetch : function (p, o) { return fetch(WORKER + p, o); };
    var DASH = (opts && opts.dash) === 'pz' ? 'pz' : 'pt';
    var DASH_NM = DASH === 'pz' ? '🐶 퍼그제로' : '🐕 포인테일';
    var S = { tab: 'users', doc: null, logs: null, stats: null, msg: '' };

    function api(p, o) { return WF(p, o).then(function (r) { return r.json().then(function (j) { if (!r.ok && j && j.error) throw new Error(j.error); return j; }); }); }
    function setMsg(m, err) { S.msg = m; S.msgErr = !!err; render(); if (m) setTimeout(function () { if (S.msg === m) { S.msg = ''; render(); } }, 4000); }

    function loadUsers() { return api('admin/users').then(function (j) { S.doc = j; }); }
    function loadLogs() { return api('admin/logs').then(function (j) {
      // 대시보드 분리 이전(dh 없음) 기록은 소속 불명 → 제외 (양쪽에 중복 노출 방지)
      S.logs = (j.logs || []).filter(function (l) { return !!l.dh; });
      S.logsLegacy = (j.logs || []).length - S.logs.length;
    }); }
    function loadStats() { return api('admin/stats?days=30').then(function (j) { S.stats = j.days || {}; }); }

    /* ── 사용자 탭 ── */
    function usersHTML() {
      var d = S.doc; if (!d) return '<div class="pta-mut">불러오는 중…</div>';
      var my = d.myRole, myLv = ROLE_LV[my] || 0;
      var users = d.users.slice().sort(function (a, b) { return (ROLE_LV[b.role] || 0) - (ROLE_LV[a.role] || 0) || (b.lastLogin || 0) - (a.lastLogin || 0); });
      var act = users.filter(function (u) { return u.active; });
      var week = Date.now() - 7 * 86400000, month = Date.now() - 30 * 86400000;
      var h = '<div class="pta-pol">🔒 <b>접근 정책</b>' +
        '<label><input type="radio" name="ptapol" value="domain" ' + (d.policy === 'domain' ? 'checked' : '') + '> @storelink.io 전원 허용</label>' +
        '<label><input type="radio" name="ptapol" value="invite" ' + (d.policy === 'invite' ? 'checked' : '') + '> 초대된 사용자만</label>' +
        '<span class="pta-mut" style="font-size:11px">전환 즉시 적용 · 서버 강제</span></div>';
      h += '<div class="pta-invite">' +
        '<div><label>이메일 (@storelink.io)</label><input type="email" id="ptaInvEmail" placeholder="name@storelink.io" style="width:190px"></div>' +
        '<div><label>이름</label><input type="text" id="ptaInvName" placeholder="홍길동" style="width:100px"></div>' +
        '<div><label>역할</label><select id="ptaInvRole"><option>MEMBER</option><option>VIEWER</option><option>ADMIN</option></select></div>' +
        '<button class="pta-btn" data-act="invite">＋ 초대 (사전 등록)</button>' +
        '<span class="pta-mut" style="font-size:11px;align-self:center">' + DASH_NM + ' 대시보드에 초대 · 즉시 로그인 가능</span></div>';
      h += '<table><tr><th>이름</th><th>이메일</th><th>역할</th><th>상태</th><th>최근 로그인</th><th>동작</th></tr>';
      var inact = users.filter(function (u) { return !u.active; });
      var shown = users.filter(function (u) { return u.active || S.showInactive; });
      shown.forEach(function (u) {
        var isMe = u.email === d.me, isOwner = u.role === 'OWNER';
        var canEdit = myLv >= 3 && (!isOwner || my === 'OWNER');
        var roleCell;
        if (canEdit && !isMe) {
          roleCell = '<select data-role="' + esc(u.email) + '">' + ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].filter(function (r) { return r !== 'OWNER' || my === 'OWNER'; })
            .map(function (r) { return '<option' + (u.role === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>';
        } else roleCell = '<span class="pta-b ' + (ROLE_BADGE[u.role] || 'pta-gry') + '">' + esc(u.role) + '</span>';
        var state = !u.active ? '<span class="pta-b pta-gry">비활성</span>' : (!u.lastLogin ? '<span class="pta-b pta-amb">초대됨 · 미로그인</span>' : '<span class="pta-b pta-grn">활성</span>');
        var actBtn = '';
        if (canEdit && !isMe) {
          if (!u.lastLogin && u.active) actBtn = '<button class="pta-btn dn" data-del="' + esc(u.email) + '">삭제</button>';
          else if (u.active) actBtn = '<button class="pta-btn dn" data-off="' + esc(u.email) + '">비활성</button>';
          else actBtn = '<button class="pta-btn gh" data-on="' + esc(u.email) + '">활성</button>';
        }
        h += '<tr' + (!u.active ? ' style="opacity:.55"' : '') + '><td><b>' + esc(u.name || '-') + '</b>' + (isMe ? ' <span class="pta-mut" style="font-size:10px">(나)</span>' : '') + '</td>' +
          '<td class="pta-mut">' + esc(u.email) + '</td><td>' + roleCell + '</td><td>' + state + '</td>' +
          '<td class="pta-mut">' + fdt(u.lastLogin) + '</td><td>' + actBtn + '</td></tr>';
      });
      h += '</table>';
      if (inact.length && !S.showInactive) h += '<div style="margin-top:8px"><button class="pta-btn gh" data-showinact="1">💤 비활성 사용자 ' + f(inact.length) + '명 보기</button></div>';
      else if (inact.length && S.showInactive) h += '<div style="margin-top:8px"><button class="pta-btn gh" data-showinact="0">비활성 숨기기</button></div>';
      h += '<div class="pta-td" style="margin-top:10px">등록 ' + f(users.length) + '명 · 활성 ' + f(act.length) + ' · 최근 7일 로그인 ' + f(act.filter(function (u) { return u.lastLogin > week; }).length) + ' · 30일+ 미로그인 ' + f(act.filter(function (u) { return u.lastLogin && u.lastLogin < month; }).length) + '</div>';
      h += '<div class="pta-card" style="margin:12px 0 0;background:#fafbfd"><h4>🗂️ 역할별 권한 (서버 강제)</h4><div class="pta-td"></div>' +
        '<table style="text-align:center"><tr><th style="text-align:left">기능</th><th>OWNER</th><th>ADMIN</th><th>MEMBER</th><th>VIEWER</th></tr>' +
        [['대시보드 조회 · CSV', 1, 1, 1, 1], ['비용·입력값 저장 (쓰기)', 1, 1, 1, 0], ['⚡ 강제 동기화 (30분 쿨다운)', 1, 1, 0, 0], ['사용자 초대·역할·비활성 / 통계·로그', 1, 1, 0, 0], ['OWNER 역할 부여·변경', 1, 0, 0, 0]]
          .map(function (r) { return '<tr><td style="text-align:left">' + r[0] + '</td>' + r.slice(1).map(function (x) { return '<td>' + (x ? '✅' : '<span class="pta-mut">–</span>') + '</td>'; }).join('') + '</tr>'; }).join('') +
        '</table></div>';
      return h;
    }

    /* ── 통계 탭 ── */
    function statsHTML() {
      if (!S.stats || !S.doc) return '<div class="pta-mut">불러오는 중…</div>';
      var per = {}, feat = { r: 0, w: 0, s: 0 }, dashPer = {};
      Object.keys(S.stats).forEach(function (day) {
        var byUser = S.stats[day];
        Object.keys(byUser).forEach(function (em) {
          var p = (per[em] = per[em] || { days: 0, r: 0, w: 0, s: 0, pt: 0, pz: 0 });
          p.days++;
          ['pt', 'pz', 'adm'].forEach(function (cat) {
            var c = byUser[em][cat]; if (!c) return;
            p.r += c.r || 0; p.w += c.w || 0; p.s += c.s || 0;
            feat.r += c.r || 0; feat.w += c.w || 0; feat.s += c.s || 0;
            if (cat === 'pt') p.pt += (c.r || 0) + (c.w || 0); if (cat === 'pz') p.pz += (c.r || 0) + (c.w || 0);
          });
        });
      });
      var arr = Object.keys(per).map(function (em) { return { em: em, v: per[em] }; }).sort(function (a, b) { return b.v.days - a.v.days || b.v.r - a.v.r; });
      var nameOf = {}; (S.doc.users || []).forEach(function (u) { nameOf[u.email] = u.name || u.email.split('@')[0]; });
      var maxD = arr.length ? arr[0].v.days : 1;
      var h = '<div class="pta-card" style="margin-bottom:14px"><h4>👤 사용자별 사용량 (최근 30일)</h4><div class="pta-td">접속일수 = API를 호출한 날 수 · 주 대시보드 = 호출 비중</div>';
      if (!arr.length) h += '<div class="pta-mut">아직 수집된 사용 데이터가 없습니다 — 보안 배포 시점부터 쌓입니다.</div>';
      arr.slice(0, 20).forEach(function (x) {
        var dash = '';
        h += '<div class="pta-hrow"><span class="nm" title="' + esc(x.em) + '">' + esc(nameOf[x.em] || x.em) + '</span>' +
          '<div class="pta-trk"><div class="pta-fill" style="width:' + Math.max(3, Math.round(x.v.days / maxD * 100)) + '%"></div></div>' +
          '<span class="pta-val">' + x.v.days + '일 <span class="pta-mut" style="font-weight:500">· 조회 ' + f(x.v.r) + ' · 쓰기 ' + f(x.v.w) + '' + '</span></span></div>';
      });
      h += '</div>';
      var idle = (S.doc.users || []).filter(function (u) { return u.active && !per[u.email]; });
      h += '<div class="pta-card"><h4>🧩 전체 활동 요약</h4><div class="pta-td">최근 30일</div>' +
        '<div>📖 데이터 조회 <b>' + f(feat.r) + '회</b> · ✏️ 쓰기(저장) <b>' + f(feat.w) + '회</b> · ⚡ 동기화 <b>' + f(feat.s) + '회</b> · 사용자 <b>' + f(arr.length) + '명</b></div>' +
        (idle.length ? '<div style="margin-top:10px">💤 <b>30일간 미사용:</b> ' + idle.map(function (u) { return esc(u.name || u.email); }).join(' · ') + '</div>' : '') +
        '</div>';
      return h;
    }

    /* ── 로그 탭 ── */
    function logsHTML() {
      if (!S.logs) return '<div class="pta-mut">불러오는 중…</div>';
      var users = {}; S.logs.forEach(function (l) { users[l.e] = 1; });
      var list = S.logs.filter(function (l) { return (!S.logU || l.e === S.logU) && (!S.logA || l.a === S.logA); });
      var h = '<div style="display:flex;gap:8px;margin-bottom:12px">' +
        '<select id="ptaLogU"><option value="">전체 사용자</option>' + Object.keys(users).map(function (e) { return '<option' + (S.logU === e ? ' selected' : '') + '>' + esc(e) + '</option>'; }).join('') + '</select>' +
        '<select id="ptaLogA"><option value="">전체 동작</option>' + Object.keys(ACT_BADGE).map(function (a) { return '<option value="' + a + '"' + (S.logA === a ? ' selected' : '') + '>' + ACT_BADGE[a][0] + '</option>'; }).join('') + '</select>' +
        '<span class="pta-mut" style="align-self:center;font-size:11.5px">' + f(list.length) + '건 · 최근 400건 보관' + (S.logsLegacy ? ' · 분리 이전 기록 ' + f(S.logsLegacy) + '건 제외' : '') + '</span></div>';
      list.slice(0, 120).forEach(function (l) {
        var b = ACT_BADGE[l.a] || [l.a, 'pta-gry'];
        h += '<div class="pta-log"><span class="t">' + fdt(l.t) + '</span><span class="w">' + esc(l.e) + '</span><span class="pta-b ' + b[1] + '">' + b[0] + '</span><span class="pta-mut">' + esc(l.d || '') + '</span></div>';
      });
      if (!list.length) h += '<div class="pta-mut">기록이 없습니다.</div>';
      return h;
    }

    function render() {
      el.innerHTML = '<div class="pta">' +
        '<div class="pta-tabs">' +
        [['users', '👥 사용자 관리'], ['stats', '📊 사용 통계'], ['logs', '📜 활동 로그']].map(function (t) {
          return '<button class="pta-tab' + (S.tab === t[0] ? ' on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</button>';
        }).join('') +
        (S.msg ? '<span class="pta-msg" style="color:' + (S.msgErr ? '#c0392b' : '#12805c') + '">' + esc(S.msg) + '</span>' : '') +
        '</div>' +
        '<div class="pta-card">' + (S.tab === 'users' ? usersHTML() : S.tab === 'stats' ? statsHTML() : logsHTML()) + '</div>' +
        '<div class="pta-td">' + DASH_NM + ' <b>전용</b> — 사용자·역할·정책이 대시보드별로 분리되어 있습니다 (다른 대시보드에는 영향 없음) · 모든 권한은 서버(Worker)에서 강제</div></div>';
    }

    el.addEventListener('click', function (e) {
      var t = e.target.closest('[data-t]'); if (t) { S.tab = t.getAttribute('data-t'); render();
        if (S.tab === 'stats' && !S.stats) loadStats().then(render).catch(function (er) { setMsg('통계 로드 실패: ' + er.message, 1); });
        if (S.tab === 'logs' && !S.logs) loadLogs().then(render).catch(function (er) { setMsg('로그 로드 실패: ' + er.message, 1); });
        return; }
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-showinact')) { S.showInactive = b.getAttribute('data-showinact') === '1'; render(); return; }
      function userPut(body, okMsg) {
        api('admin/users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(function () { return loadUsers(); }).then(function () { setMsg(okMsg); })
          .catch(function (er) { loadUsers().then(function(){ setMsg('⚠️ ' + er.message, 1); }); });
      }
      if (b.getAttribute('data-act') === 'invite') {
        var em = (document.getElementById('ptaInvEmail').value || '').trim();
        var nm = (document.getElementById('ptaInvName').value || '').trim();
        var rl = document.getElementById('ptaInvRole').value;
        if (!em) return setMsg('이메일을 입력하세요', 1);
        userPut({ action: 'invite', email: em, name: nm, role: rl }, '✅ 초대 완료 — 바로 로그인할 수 있습니다');
      }
      if (b.getAttribute('data-off')) { if (confirm(b.getAttribute('data-off') + ' 계정을 비활성할까요? 즉시 접근이 차단됩니다.')) userPut({ action: 'update', email: b.getAttribute('data-off'), active: false }, '비활성 처리됨'); }
      if (b.getAttribute('data-on')) userPut({ action: 'update', email: b.getAttribute('data-on'), active: true }, '활성 처리됨');
      if (b.getAttribute('data-del')) { if (confirm('초대를 삭제할까요?')) userPut({ action: 'remove', email: b.getAttribute('data-del') }, '초대 삭제됨'); }
    });
    el.addEventListener('change', function (e) {
      var s = e.target;
      if (s.name === 'ptapol') {
        api('admin/policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: s.value }) })
          .then(function () { return loadUsers(); }).then(function () { setMsg('접근 정책 변경됨'); })
          .catch(function (er) { loadUsers().then(function(){ setMsg('⚠️ ' + er.message, 1); }); });
      }
      if (s.getAttribute('data-role')) {
        api('admin/users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', email: s.getAttribute('data-role'), role: s.value }) })
          .then(function () { return loadUsers(); }).then(function () { setMsg('역할 변경됨 — 대상자는 재로그인 시 적용'); })
          .catch(function (er) { loadUsers().then(function(){ setMsg('⚠️ ' + er.message, 1); }); });
      }
      if (s.id === 'ptaLogU') { S.logU = s.value; render(); }
      if (s.id === 'ptaLogA') { S.logA = s.value; render(); }
    });

    render();
    loadUsers().then(render).catch(function (er) { el.innerHTML = '<div class="pta"><div class="pta-card">⚠️ 관리 데이터 로드 실패: ' + esc(er.message) + '<br><span class="pta-mut" style="font-size:12px">ADMIN 이상만 접근할 수 있습니다. Worker가 최신 버전인지 확인하세요.</span></div></div>'; });
  }

  window.PTADMIN = { mount: mount, decodeTok: decodeTok, ROLE_LV: ROLE_LV };

  /* ── 포인테일 자동 통합: ⚙️ 관리 그룹에 「👥 사용자·통계」 탭 ── */
  function ptRole() {
    try { var s = JSON.parse(localStorage.getItem('pt_auth_user') || 'null'); if (!s || !s.tk) return 0;
      var p = decodeTok(s.tk); return p ? (ROLE_LV[p.r] || 0) : 0; } catch (e) { return 0; }
  }
  function ensurePt() {
    var nav = document.getElementById('main-tabs'); if (!nav) return;      // 포인테일이 아니면 무시
    hookShowTab();
    if (ptRole() < 3) return;                                              // ADMIN 미만은 탭 자체를 만들지 않음
    if (!document.getElementById('tab-admusr')) {
      var ref = document.querySelector('.panel');
      if (ref && ref.parentNode) { var p = document.createElement('div'); p.id = 'tab-admusr'; p.className = 'panel'; ref.parentNode.appendChild(p); }
    }
    var b = document.getElementById('tab-btn-admusr');
    if (!b) {
      var anyTab = nav.querySelector('.tab');
      b = document.createElement('button');
      b.id = 'tab-btn-admusr'; b.className = anyTab ? anyTab.className.replace(' active', '') : 'tab';
      b.textContent = '👥 사용자·통계'; b.type = 'button';
      b.addEventListener('click', function () {
        // 원본 showTab을 그대로 사용 → 패널 전환·그룹 정리 등 기존 로직에 위임
        var ok = false;
        if (typeof window.showTab === 'function') { try { window.showTab('admusr'); ok = true; } catch (e) {} }
        if (!ok) {
          document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('active'); });
          var p2 = document.getElementById('tab-admusr'); if (p2) p2.classList.add('active');
        }
        document.querySelectorAll('#main-tabs .tab, #main-tabs .subtab').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        if (!b.__mounted) { b.__mounted = true; mount(document.getElementById('tab-admusr'), { dash: 'pt' }); }
      });
    }
    var row = document.getElementById('ptnavrow-admin');
    if (row) { if (b.parentElement !== row || row.firstElementChild !== b) row.insertBefore(b, row.firstChild); }
    else if (!b.parentElement) nav.appendChild(b);
  }
  function hookShowTab() {
    if (typeof window.showTab !== 'function' || window.showTab.__ptAdm) return;
    var _st = window.showTab;
    window.showTab = function (n) {
      if (n !== 'admusr') { var b = document.getElementById('tab-btn-admusr'); if (b) b.classList.remove('active'); }
      return _st.apply(this, arguments);
    };
    window.showTab.__ptAdm = true;
  }
  var t = null;
  function sched() { clearTimeout(t); t = setTimeout(function () { try { ensurePt(); } catch (e) {} }, 300); }
  function start() {
    if (!document.getElementById('main-tabs')) return;                     // 퍼그제로에서는 mount() 호출만 사용
    try { new MutationObserver(sched).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    setInterval(function () { try { ensurePt(); } catch (e) {} }, 2000);
    ensurePt();
  }
  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
