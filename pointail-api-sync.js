/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – API 직접 동기화 모듈 (캠페인 + 회원 통합)
 *  ⚡ API 동기화 버튼 한 번으로 어드민 연동 DB를 모두 최신화한다.
 *    · 캠페인DB(DB.camp)   ← Worker 루트(/) : /pug/jp/campaigns/search
 *    · 회원가입DB(DB.member) ← Worker /members : /pug/jp/advertiser/search
 *  기존 제외규칙(shouldExcludeRow) + 금액규칙(applyRulesToRow)을 그대로 적용.
 *  회원 엔드포인트(/members) 미배포 시엔 회원만 건너뛰고 캠페인은 정상 동기화.
 * ──────────────────────────────────────────────────────────── */
(function () {
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  var MONEY = ['pointRevenue', 'contractSaleSum', 'contractMktCost', 'contractVat',
    'contractFinal', 'contractSalePrice', 'execMktAmount', 'execDiscount',
    'execNetAmount', 'execTotalAmount'];

  function pad(n) { return String(n).padStart(2, '0'); }
  function nowTs() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  window.syncFromApi = function syncFromApi() {
    var btn = document.getElementById('api-sync-btn');
    var orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ API 동기화 중...'; }

    Promise.all([
      // 캠페인
      fetch(WORKER + '?pageSize=200&t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('캠페인 HTTP ' + r.status); return r.json(); }),
      // 회원 (미배포면 조용히 건너뜀)
      fetch(WORKER + 'members?pageSize=200&t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; })
    ]).then(function (res) {
      var jc = res[0] || {}, jm = res[1] || {};
      if (jc.error) throw new Error(jc.error);

      // ── 캠페인DB ──
      var rows = (jc.campaigns || []).map(function (c) {
        var o = {}; for (var k in c) o[k] = c[k];
        MONEY.forEach(function (m) { if (typeof o[m] === 'number') o[m] = String(o[m]); });
        return o;
      });
      DB.camp = rows
        .filter(function (o) { return !shouldExcludeRow('camp', o); })
        .map(function (o) { return applyRulesToRow('camp', o); });

      // ── 회원가입DB (/members 응답에 members 배열이 있을 때만) ──
      var memberCount = -1; // -1 = 회원 동기화 안 함(미배포)
      if (jm && Object.prototype.hasOwnProperty.call(jm, 'members') && Array.isArray(jm.members)) {
        DB.member = jm.members
          .map(function (o) { try { return applyRulesToRow('member', o); } catch (e) { return o; } })
          .filter(function (o) { try { return !shouldExcludeRow('member', o); } catch (e) { return true; } });
        memberCount = DB.member.length;
      }

      if (typeof saveState === 'function') { saveState(); }
      else {
        try { var pd = JSON.parse(localStorage.getItem('pt_db') || '{}'); pd.camp = DB.camp; if (memberCount >= 0) pd.member = DB.member; localStorage.setItem('pt_db', JSON.stringify(pd)); } catch (e) {}
      }
      if (typeof renderAll === 'function') { renderAll(); }

      var ts = nowTs();
      try { localStorage.setItem('pt_api_last_sync', ts); } catch (e) {}
      var el = document.getElementById('api-sync-time'); if (el) el.textContent = 'API ' + ts;

      alert('✅ API 동기화 완료\n\n' +
        '캠페인 ' + DB.camp.length.toLocaleString('ko-KR') + '건' +
        (memberCount >= 0
          ? '\n회원 ' + memberCount.toLocaleString('ko-KR') + '건'
          : '\n(회원 동기화는 Worker /members 배포 후 활성화됩니다)') +
        '\n수집 시각: ' + ts);
    }).catch(function (e) {
      alert('⚠️ API 동기화 실패: ' + (e.message || e) +
        '\n\n① 어드민 로그인 정보(Cloudflare ADMIN_ID/PW) 확인\n' +
        '② 잠시 후 다시 [⚡ API 동기화] 클릭');
    }).then(function () { if (btn) { btn.disabled = false; btn.innerHTML = orig; } });
  };

  // ── 헤더의 '구글시트 동기화' 옆에 '⚡ API 동기화' 버튼 추가 ──
  function addBtn() {
    if (document.getElementById('api-sync-btn')) return true;
    var ref = document.getElementById('gs-sync-btn');
    if (!ref) return false;
    var b = document.createElement('button');
    b.id = 'api-sync-btn';
    b.className = ref.className || 'btn btn-sm';
    b.textContent = '⚡ API 동기화';
    b.title = '어드민 API에서 캠페인 + 회원 데이터를 한 번에 불러옵니다';
    b.style.marginLeft = '6px';
    b.onclick = window.syncFromApi;
    ref.parentNode.insertBefore(b, ref.nextSibling);
    return true;
  }

  var tries = 0;
  var iv = setInterval(function () { tries++; if (addBtn() || tries > 80) clearInterval(iv); }, 400);
  if (document.readyState !== 'loading') addBtn();
  else document.addEventListener('DOMContentLoaded', addBtn);
})();
