/** ─────────────────────────────────────────────────────────────
 *  (포인테일) 대행사관리 + 수출바우처 — 시트 양방향 API (Code.gs)
 *  v2 · 2026-08-18 · 기존 대행사 API에 「수출바우처」 탭 추가 확장판
 *
 *  ⚠ 설치: 기존 Apps Script 프로젝트(대행사관리 API)의 Code.gs 를
 *     이 파일 전체로 교체 → 배포 → 배포 관리 → ✏️ 수정 → 버전 「새 버전」 → 배포.
 *     (새 배포를 만들지 말 것 — URL이 바뀌면 대시보드 모듈 수정 필요)
 *     교체 전 기존 코드는 복사해 백업해 둘 것.
 *
 *  API (기존과 100% 호환 + 수출바우처 추가)
 *   GET  ?action=list
 *        → { ok:true, data:{ 한국:[...], 일본:[...], 수출바우처:[...] }, at }
 *          각 행 객체에 _row(시트 행 번호) 포함
 *   POST { action:'update', sheet:'한국'|'일본'|'수출바우처', row:N, name:'검증용 이름', set:{컬럼:값,...} }
 *        → 행 번호 + 이름(대행사=업체명, 수출바우처=광고주명) 이중 검증 후 해당 셀만 기록
 *   POST { action:'append', sheet:'수출바우처', set:{컬럼:값,...} }
 *        → 마지막 행 아래에 새 건 추가 (No 자동 채번, 잔액 수식 자동)
 *  ───────────────────────────────────────────────────────────── */

var SS_ID = '1O9vJquD9xSMm2Mii0JCzqZQ5S4Ic0-WSjki808JTIxk';

/* sheet 키 → 실제 탭 이름 / 이름 검증 컬럼 */
var TABS = {
  '한국':     { tab: '대행사관리_한국', nameCol: '업체명' },
  '일본':     { tab: '대행사관리_일본', nameCol: '업체명' },
  '수출바우처': { tab: '수출바우처',     nameCol: '광고주명' }
};

/* 수출바우처에서 시트 수식 보호(대시보드가 덮어쓰지 않는 컬럼) */
var PROTECTED = { '수출바우처': { '잔액': 1, 'No': 1 } };

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function _readTab(name) {
  var sh = SpreadsheetApp.openById(SS_ID).getSheetByName(TABS[name].tab);
  if (!sh) return [];
  var vals = sh.getDataRange().getDisplayValues();
  if (vals.length < 2) return [];
  var head = vals[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r], empty = true, o = { _row: r + 1 };
    for (var c = 0; c < head.length; c++) {
      if (!head[c]) continue;
      var v = String(row[c] == null ? '' : row[c]).trim();
      o[head[c]] = v;
      if (v) empty = false;
    }
    if (!empty) out.push(o);
  }
  return out;
}

function doGet(e) {
  try {
    var action = e && e.parameter && e.parameter.action;
    if (action === 'list') {
      var data = {};
      Object.keys(TABS).forEach(function (k) { data[k] = _readTab(k); });
      return _json({ ok: true, data: data, at: new Date().toISOString() });
    }
    return _json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    var b = JSON.parse(e.postData.contents || '{}');
    var cfg = TABS[b.sheet];
    if (!cfg) return _json({ ok: false, error: 'unknown sheet: ' + b.sheet });
    var sh = SpreadsheetApp.openById(SS_ID).getSheetByName(cfg.tab);
    if (!sh) return _json({ ok: false, error: 'tab not found: ' + cfg.tab });
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    var prot = PROTECTED[b.sheet] || {};

    if (b.action === 'update') {
      var row = parseInt(b.row, 10);
      if (!row || row < 2 || row > sh.getLastRow()) return _json({ ok: false, error: 'bad row: ' + b.row });
      /* 이름 이중 검증 — 행이 밀렸을 때 엉뚱한 행을 덮어쓰는 사고 방지 */
      var nameIdx = head.indexOf(cfg.nameCol);
      if (nameIdx >= 0 && b.name != null) {
        var cur = String(sh.getRange(row, nameIdx + 1).getValue()).trim();
        if (cur !== String(b.name).trim()) {
          return _json({ ok: false, error: '행 검증 실패: 시트의 ' + cfg.nameCol + '(' + cur + ') ≠ ' + b.name + ' — 새로고침 후 다시 시도' });
        }
      }
      var set = b.set || {}, applied = 0;
      Object.keys(set).forEach(function (k) {
        if (prot[k]) return;
        var idx = head.indexOf(k);
        if (idx < 0) return;
        sh.getRange(row, idx + 1).setValue(set[k]);
        applied++;
      });
      return _json({ ok: true, applied: applied, row: row });
    }

    if (b.action === 'append') {
      var set2 = b.set || {};
      var newRow = sh.getLastRow() + 1;
      var vals = head.map(function (h) {
        if (h === 'No') return newRow - 1;
        if (h === '잔액' && b.sheet === '수출바우처')
          return '=IFERROR(F' + newRow + '-G' + newRow + ',"")';
        return set2[h] != null ? set2[h] : '';
      });
      sh.getRange(newRow, 1, 1, head.length).setValues([vals]);
      return _json({ ok: true, row: newRow });
    }

    return _json({ ok: false, error: 'unknown action' });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
