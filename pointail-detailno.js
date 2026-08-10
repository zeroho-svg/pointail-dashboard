/* ────────────────────────────────────────────────────────────
 *  포인테일 대시보드 – 상세 배너 캠페인 번호 열 추가 (pointail-detailno.js)
 *
 *  매출 대시보드에서 담당자·광고주 등 항목 클릭 시 뜨는 상세 배너(sd_showDetail
 *  계열 전체)에 매출 컬럼 앞에 「캠페인 번호」 열을 추가한다.
 *
 *  원본 구조:
 *   · 헤더/정렬 = SD_DETAIL_COLS 배열 기반  → 열 정의만 삽입하면 자동 반영
 *   · 본문(sd_renderDetailTable)·CSV(sd_exportDetail) = 하드코딩
 *     → 두 함수를 SD_DETAIL_COLS 데이터 기반으로 오버라이드(컬럼 추가에 자동 대응)
 *  ※ SD_DETAIL_COLS·_sdDetailState 는 스크립트 전역(const/let) → bare 식별자 접근.
 *  원본 index.html 은 수정하지 않는다(주입형).
 * ──────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function ready() {
    return typeof SD_DETAIL_COLS !== 'undefined' && Array.isArray(SD_DETAIL_COLS) &&
           typeof window.sd_renderDetailTable === 'function' &&
           typeof window.sd_exportDetail === 'function' &&
           typeof window.sd_fmtN === 'function';
  }

  function install() {
    if (!ready()) return false;
    if (window.__ptDetailNo) return true;
    window.__ptDetailNo = true;

    if (!SD_DETAIL_COLS.some(function (c) { return c.key === 'campaignNo'; })) {
      var idx = SD_DETAIL_COLS.findIndex(function (c) { return c.key === 'contractFinal'; });
      if (idx < 0) idx = SD_DETAIL_COLS.length;
      SD_DETAIL_COLS.splice(idx, 0, {
        key: 'campaignNo', label: '캠페인 번호', align: 'left', type: 'string',
        getValue: function (r) { return String(r.campaignNoText || r.campaignNo || ''); }
      });
    }

    var esc = function (s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); };

    window.sd_renderDetailTable = function (rows) {
      var wrap = document.getElementById('sd-detail-table-wrap');
      if (!wrap) return;
      var st = _sdDetailState;

      var sorted = rows.slice();
      if (st.sortCol) {
        var colDef = SD_DETAIL_COLS.find(function (c) { return c.key === st.sortCol; });
        if (colDef) {
          sorted.sort(function (a, b) {
            var va = colDef.getValue(a), vb = colDef.getValue(b);
            if (colDef.type === 'string') return String(va || '').localeCompare(String(vb || ''), 'ko') * st.sortDir;
            return (va > vb ? 1 : va < vb ? -1 : 0) * st.sortDir;
          });
        }
      }

      var sortArrow = function (col) { return st.sortCol === col ? (st.sortDir === -1 ? ' ▼' : ' ▲') : ' ⇅'; };
      var headerCells = SD_DETAIL_COLS.map(function (c) {
        var arrowColor = st.sortCol === c.key ? 'var(--lead-tx)' : 'var(--tx3)';
        return '<th onclick="sd_sortDetail(\'' + c.key + '\')" style="padding:8px 10px;font-size:11px;font-weight:600;color:var(--tx2);text-align:' + c.align + ';white-space:nowrap;background:var(--bg2);border-bottom:2px solid var(--bd);position:sticky;top:0;z-index:1;cursor:pointer;user-select:none" onmouseover="this.style.background=\'var(--bg3)\'" onmouseout="this.style.background=\'var(--bg2)\'">' + c.label + '<span style="color:' + arrowColor + '">' + sortArrow(c.key) + '</span></th>';
      }).join('');

      var tableRows = sorted.map(function (r, i) {
        var tds = SD_DETAIL_COLS.map(function (c) {
          if (c.key === 'companyType') {
            var ct = (r.companyType || '').trim();
            var isAgency = ct === '대행사';
            var bg = isAgency ? '#fef3c7' : (ct === '일반 광고주' ? '#dbeafe' : '#f3f4f6');
            var fg = isAgency ? '#92400e' : (ct === '일반 광고주' ? '#1e40af' : '#6b7280');
            return '<td style="padding:6px 10px;text-align:center;white-space:nowrap"><span style="display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:' + bg + ';color:' + fg + '">' + (esc(ct) || '미지정') + '</span></td>';
          }
          var v = c.getValue(r);
          var txt = (c.type === 'number') ? sd_fmtN(v) : (esc(v) || '-');
          return '<td style="padding:6px 10px;font-size:11px;text-align:' + (c.align || 'left') + ';white-space:nowrap;' + (c.color ? 'color:' + c.color + ';' : '') + '">' + txt + '</td>';
        }).join('');
        return '<tr style="' + (i % 2 === 0 ? '' : 'background:var(--bg2)') + '">' + tds + '</tr>';
      }).join('');

      wrap.innerHTML = '<table style="width:100%;border-collapse:collapse"><thead><tr>' + headerCells + '</tr></thead><tbody>' + tableRows + '</tbody></table>';
    };

    window.sd_exportDetail = function (sid, key) {
      var rows = (window.__sdGroupRows && window.__sdGroupRows[sid] && window.__sdGroupRows[sid][key]) || [];
      if (!rows.length) { alert('데이터가 없습니다.'); return; }
      var cs = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var lines = [SD_DETAIL_COLS.map(function (c) { return cs(c.label); }).join(',')];
      rows.forEach(function (r) {
        lines.push(SD_DETAIL_COLS.map(function (c) { return cs(c.getValue(r)); }).join(','));
      });
      var blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '상세_' + String(key).replace(/[\\/:*?"<>|]/g, '_') + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
    };

    return true;
  }

  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    try { if (install() || tries > 100) clearInterval(iv); } catch (e) { if (tries > 100) clearInterval(iv); }
  }, 400);
  if (document.readyState !== 'loading') { try { install(); } catch (e) {} }
  else document.addEventListener('DOMContentLoaded', function () { try { install(); } catch (e) {} });
})();
