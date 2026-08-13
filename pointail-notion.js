/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 📝 노션 광고주 DB 연결 (pointail-notion.js) v2
 *
 *  영업 › 🏢 광고주 관리 › 광고주 목록의 각 행(및 상세 모달 헤더)에서
 *  해당 업체의 노션 광고주 DB 페이지로 **바로 이동**한다.
 *
 *  ── 연결 상태를 색으로 구분 ──
 *   · 🟣 보라(채움) 「📝 노션」 = 연결됨 → 클릭 시 해당 업체 노션 페이지 새 탭
 *     (옆의 ✎ 버튼으로 연결 수정·해제)
 *   · ⬜ 회색(점선) 「＋ 노션 연결」 = 미연결 → 클릭 시 노션 URL 입력창
 *   · 표 제목 옆에 「노션 연결 N · 미연결 M」 요약 배지
 *
 *  ── 매핑 데이터 ──
 *   Cloudflare KV(`/contacts`)의 예약 키 `__notion__` 에 { 법인명: 노션페이지ID } 로 공유 저장.
 *   → 한 사람이 연결하면 모든 컴퓨터에 즉시 반영. Worker 재배포 불필요.
 *   → 저장소가 Public 이라 매핑표를 GitHub 에 두지 않는다(고객사 명단 노출 방지).
 *   ※ `/contacts` 의 소통방식 데이터와 같은 객체를 공유하지만, 소통방식 로직은
 *     `CONTACTS[법인명]` 으로만 접근하므로 `__notion__` 키와 충돌하지 않는다.
 *     저장은 항상 read→merge→write 로 상대 데이터를 보존한다.
 *
 *  1차 매칭은 Claude 가 노션 (국내) 광고주 DB 2,158행과 대조해 자동 시드(142곳).
 *  정규화 규칙: 주식회사·(주)·㈜·株式会社·合同会社 등 법인격, (일본)·(대행사) 꼬리표,
 *  공백·구두점 제거 후 비교. 노션 제목이 「A_B」처럼 브랜드 병기면 조각별로도 대조.
 *  나머지는 화면에서 수동 연결한다.
 *
 *  원본 index.html·pointail-advertiser.js 는 수정하지 않는다(주입형 오버라이드).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var EP = WORKER + 'contacts';
  var NKEY = '__notion__';
  var PAGE = 'https://app.notion.com/p/';
  var DB_URL = 'https://app.notion.com/p/storelink/9e431ed83ebb4a6cb4ef64e7265ad355' +
               '?v=26267743f1c24cbdaaa2787cd274f4bf';
  var DB_ID = '9e431ed83ebb4a6cb4ef64e7265ad355';      // DB 자체 ID(페이지 ID로 오인 방지)
  var VIEW_ID = '26267743f1c24cbdaaa2787cd274f4bf';    // 뷰 ID(동일)

  var MAP = null;          // { 법인명: 노션페이지ID }
  var LOADED = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }
  function attr(s) { return esc(String(s == null ? '' : s).replace(/'/g, '')); }

  /* 노션 URL(또는 32자리 ID) → 페이지 ID. 대시 포함 UUID 형식도 허용. */
  function parseId(u) {
    var m = String(u || '').trim().replace(/-/g, '').match(/[0-9a-fA-F]{32}/);
    if (!m) return '';
    var id = m[0].toLowerCase();
    return (id === DB_ID || id === VIEW_ID) ? '' : id;   // DB/뷰 URL은 업체 페이지가 아님
  }

  /* ── KV 입출력 (소통방식 데이터 보존) ── */
  function readAll() {
    return fetch(EP + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (o) {
        return (o && typeof o === 'object' && !('campaigns' in o) && !('source' in o)) ? o : {};
      })
      .catch(function () { return {}; });
  }
  function load() {
    return readAll().then(function (o) {
      MAP = (o[NKEY] && typeof o[NKEY] === 'object') ? o[NKEY] : {};
      LOADED = true;
      redecorate();
      return MAP;
    });
  }
  function save(company, pageId) {
    return readAll().then(function (o) {
      var m = (o[NKEY] && typeof o[NKEY] === 'object') ? o[NKEY] : {};
      if (pageId) m[company] = pageId; else delete m[company];
      o[NKEY] = m;
      return fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })
        .then(function (r) {
          if (!r.ok) throw new Error('save failed');
          MAP = m; redecorate();
          toast(pageId ? '✅ 노션 연결 저장됨 · 모든 컴퓨터 적용' : '✅ 노션 연결 해제됨');
        });
    }).catch(function () { toast('⚠️ 저장 실패 — 네트워크를 확인해주세요'); });
  }

  function toast(msg) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#111827;color:#fff;font-size:13px;padding:10px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2600);
  }

  /* ── 버튼 ── */
  var BASE = 'display:inline-block;font-size:11px;font-weight:700;line-height:1.6;padding:2px 8px;' +
             'border-radius:7px;text-decoration:none;white-space:nowrap;margin-right:3px;cursor:pointer';
  var ON = BASE + ';background:#efe9fb;border:1px solid #cdbdf0;color:#5b45a8';
  var OFF = BASE + ';background:#fff;border:1px dashed #cfd6e0;color:#98a2b3';
  var EDIT = 'display:inline-block;font-size:10px;line-height:1.6;padding:2px 5px;border-radius:6px;' +
             'background:#f6f4fc;border:1px solid #e2dbf5;color:#8b7bc4;cursor:pointer;margin-right:3px';

  function btnHTML(company) {
    var id = MAP ? MAP[company] : null;
    if (id) {
      return '<a href="' + PAGE + id + '" target="_blank" rel="noopener" class="ptntn-b"' +
        ' title="노션 광고주 페이지 열기 (연결됨)" onclick="event.stopPropagation()" style="' + ON + '">📝 노션</a>' +
        '<button class="ptntn-e" data-company="' + attr(company) + '" title="노션 연결 수정·해제" style="' + EDIT + '">✎</button>';
    }
    return '<button class="ptntn-e" data-company="' + attr(company) + '"' +
      ' title="노션 페이지가 아직 연결되지 않았습니다. 클릭해서 연결하세요." style="' + OFF + '">＋ 노션 연결</button>';
  }

  function summaryHTML() {
    var rows = document.querySelectorAll('tr.ptad-adv-row');
    var on = 0, off = 0;
    for (var i = 0; i < rows.length; i++) {
      if (MAP && MAP[rows[i].getAttribute('data-company')]) on++; else off++;
    }
    return '<span class="ptntn-sum" style="font-weight:400;font-size:11.5px;margin-left:8px">' +
      '<span style="display:inline-block;padding:1px 8px;border-radius:20px;background:#efe9fb;color:#5b45a8;font-weight:700">📝 연결 ' + on + '</span> ' +
      '<span style="display:inline-block;padding:1px 8px;border-radius:20px;background:#f3f5f8;color:#8a94a6">미연결 ' + off + '</span></span>';
  }

  /* ── 주입 ── */
  function decorate() {
    if (!LOADED) return;
    var rows = document.querySelectorAll('tr.ptad-adv-row:not([data-ptntn])');
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      tr.setAttribute('data-ptntn', '1');
      var cell = tr.lastElementChild;
      if (cell) cell.insertAdjacentHTML('afterbegin', btnHTML(tr.getAttribute('data-company') || ''));
    }
    /* 상세 모달 헤더 */
    var meta = document.querySelector('#ptad-modal .ptad-meta:not([data-ptntn])');
    if (meta) {
      meta.setAttribute('data-ptntn', '1');
      var t = document.querySelector('#ptad-modal .ptad-mh div[style*="font-weight:800"]');
      var comp = t ? String(t.textContent || '').split('#')[0].trim() : '';
      if (comp) meta.insertAdjacentHTML('beforeend', '<span>' + btnHTML(comp) + '</span>');
    }
    /* 요약 배지 */
    var h3s = document.querySelectorAll('#tab-advmgr h3, .ptad-card h3');
    for (var k = 0; k < h3s.length; k++) {
      if (h3s[k].textContent.indexOf('광고주 목록') >= 0) {
        var old = h3s[k].querySelector('.ptntn-sum');
        if (old) old.parentNode.removeChild(old);
        h3s[k].insertAdjacentHTML('beforeend', summaryHTML());
        break;
      }
    }
    wire();
  }
  function redecorate() {
    var d = document.querySelectorAll('[data-ptntn]');
    for (var i = 0; i < d.length; i++) d[i].removeAttribute('data-ptntn');
    var b = document.querySelectorAll('.ptntn-b, .ptntn-e');
    for (var j = 0; j < b.length; j++) if (b[j].parentNode) b[j].parentNode.removeChild(b[j]);
    decorate();
  }
  function wire() {
    var es = document.querySelectorAll('.ptntn-e:not([data-w])');
    for (var i = 0; i < es.length; i++) {
      es[i].setAttribute('data-w', '1');
      es[i].onclick = function (e) {
        e.stopPropagation(); e.preventDefault();
        openEditor(this.getAttribute('data-company'));
      };
    }
  }

  /* ── 수동 연결 입력창 ── */
  function openEditor(company) {
    closeEditor();
    var cur = (MAP && MAP[company]) || '';
    var ov = document.createElement('div');
    ov.id = 'ptntn-ov';
    ov.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:rgba(17,24,39,.45);' +
      'z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:560px;width:100%;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
        '<div style="font-size:16px;font-weight:800;color:#111827">📝 노션 페이지 연결</div>' +
        '<div style="font-size:13px;color:#48505c;margin-top:6px">' + esc(company) + '</div>' +
        (cur ? '<div style="font-size:11.5px;color:#5b45a8;margin-top:8px">현재 연결됨 · <a href="' + PAGE + cur + '" target="_blank" rel="noopener" style="color:#5b45a8">' + cur.slice(0, 8) + '…' + cur.slice(-4) + ' 열기 ↗</a></div>' : '') +
        '<div style="font-size:11.5px;color:#8a94a6;margin-top:12px;line-height:1.6">' +
          '노션에서 해당 업체 페이지를 연 뒤 <b>우측 상단 ••• → 링크 복사</b> 로 주소를 복사해 아래에 붙여넣으세요.<br>' +
          '<a href="' + DB_URL + '" target="_blank" rel="noopener" style="color:#3778c2">노션 광고주 DB 열기 ↗</a></div>' +
        '<input id="ptntn-in" placeholder="https://app.notion.com/p/storelink/395c0064…" ' +
          'style="width:100%;box-sizing:border-box;margin-top:10px;padding:10px 12px;border:1.5px solid #d8dee6;border-radius:9px;font-size:13px">' +
        '<div id="ptntn-msg" style="font-size:11.5px;color:#c0392b;margin-top:6px;min-height:16px"></div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;align-items:center">' +
          '<button id="ptntn-save" style="border:0;background:#5b45a8;color:#fff;border-radius:9px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer">저장</button>' +
          (cur ? '<button id="ptntn-del" style="border:1px solid #e5e8ee;background:#fff;color:#c0392b;border-radius:9px;padding:9px 14px;font-size:12.5px;cursor:pointer">연결 해제</button>' : '') +
          '<div style="flex:1"></div>' +
          '<button id="ptntn-cancel" style="border:1px solid #e5e8ee;background:#fff;color:#48505c;border-radius:9px;padding:9px 14px;font-size:12.5px;cursor:pointer">취소</button>' +
        '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeEditor(); });

    var input = document.getElementById('ptntn-in');
    if (input) input.focus();
    document.getElementById('ptntn-cancel').onclick = closeEditor;
    var del = document.getElementById('ptntn-del');
    if (del) del.onclick = function () { closeEditor(); save(company, null); };
    document.getElementById('ptntn-save').onclick = function () {
      var id = parseId(input.value);
      if (!id) {
        document.getElementById('ptntn-msg').textContent =
          '노션 업체 페이지 주소가 아닙니다. 목록(DB) 주소가 아니라 업체 페이지를 열고 링크를 복사해주세요.';
        return;
      }
      closeEditor(); save(company, id);
    };
    input.onkeydown = function (e) { if (e.key === 'Enter') document.getElementById('ptntn-save').click(); };
  }
  function closeEditor() {
    var o = document.getElementById('ptntn-ov');
    if (o && o.parentNode) o.parentNode.removeChild(o);
  }

  function boot() {
    load();
    try {
      new MutationObserver(function () { decorate(); })
        .observe(document.body, { childList: true, subtree: true });
    } catch (e) { }
    setInterval(decorate, 1500);   // 원본 재렌더(필터·정렬·더보기) 대비
  }

  window.PTNTN = {
    reload: load,
    map: function () { return MAP; },
    stats: function () {
      var rows = document.querySelectorAll('tr.ptad-adv-row'), on = 0, miss = [];
      for (var i = 0; i < rows.length; i++) {
        var c = rows[i].getAttribute('data-company');
        if (MAP && MAP[c]) on++; else miss.push(c);
      }
      return { linked: on, unlinked: miss.length, unlinkedList: miss };
    },
    /* 자동 매칭 시드 일괄 적용(관리용). obj = { 법인명: 노션페이지ID } */
    seed: function (obj) {
      return readAll().then(function (o) {
        var m = (o[NKEY] && typeof o[NKEY] === 'object') ? o[NKEY] : {};
        var added = 0;
        Object.keys(obj || {}).forEach(function (k) { if (!m[k]) { m[k] = obj[k]; added++; } });
        o[NKEY] = m;
        return fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })
          .then(function (r) { if (!r.ok) throw new Error('seed failed'); MAP = m; redecorate(); return { added: added, total: Object.keys(m).length }; });
      });
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
