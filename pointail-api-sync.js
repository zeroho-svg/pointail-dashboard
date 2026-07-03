/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – API 직접 동기화 모듈
 *  Cloudflare Worker(pointail-api) → 어드민 API에서 캠페인 전량 수집
 *  → 기존 제외 규칙(shouldExcludeRow) + 금액 규칙(applyRulesToRow, VAT ×1.1 / 일본 ×10)
 *    을 그대로 적용 → DB.camp 교체 → saveState + renderAll.
 *  구글시트 동기화는 그대로 두고, '⚡ API 동기화' 버튼을 추가한다(반자동).
 *  토큰 만료(약 12h) 시: 어드민 콘솔에서 토큰 재복사 → Cloudflare API_TOKEN Rotate 교체.
 * ──────────────────────────────────────────────────────────── */
(function () {
  var WORKER = 'https://pointail-api.zeroho.workers.dev/';
  // 시트와 동일하게 원본(콤마 없는) 값으로 담고, applyRulesToRow가 VAT/환율을 처리
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

    fetch(WORKER + '?pageSize=200&t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error);
        var rows = (j.campaigns || []).map(function (c) {
          var o = {}; for (var k in c) o[k] = c[k];
          MONEY.forEach(function (m) { if (typeof o[m] === 'number') o[m] = String(o[m]); });
          return o;
        });
        // 기존 파이프라인과 동일: 제외 필터 → 금액/환율 규칙 적용
        DB.camp = rows
          .filter(function (o) { return !shouldExcludeRow('camp', o); })
          .map(function (o) { return applyRulesToRow('camp', o); });

        if (typeof saveState === 'function') { saveState(); }
        else {
          try { var pd = JSON.parse(localStorage.getItem('pt_db') || '{}'); pd.camp = DB.camp; localStorage.setItem('pt_db', JSON.stringify(pd)); } catch (e) {}
        }
        if (typeof renderAll === 'function') { renderAll(); }

        var ts = nowTs();
        try { localStorage.setItem('pt_api_last_sync', ts); } catch (e) {}
        var el = document.getElementById('api-sync-time'); if (el) el.textContent = 'API ' + ts;

        alert('✅ API 동기화 완료\n\n적용: ' + DB.camp.length.toLocaleString('ko-KR') +
          '건  (원본 ' + (j.count || 0).toLocaleString('ko-KR') + '건, 제외 규칙 반영)\n' +
          '수집 시각: ' + ts);
      })
      .catch(function (e) {
        alert('⚠️ API 동기화 실패: ' + (e.message || e) +
          '\n\n토큰이 만료됐을 수 있어요(유효 약 12시간).\n' +
          '① 어드민 탭 콘솔에서 토큰 다시 복사\n' +
          '② Cloudflare pointail-api → Settings → API_TOKEN → Rotate 로 교체\n' +
          '③ 다시 [⚡ API 동기화] 클릭');
      })
      .then(function () { if (btn) { btn.disabled = false; btn.innerHTML = orig; } });
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
    b.title = '어드민 API에서 캠페인 데이터를 직접 불러옵니다 (구글시트 불필요 · 반자동)';
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
