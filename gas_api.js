/**
 * イディア・ノブ シフト管理ダッシュボード用 GAS Web API
 * ---------------------------------------------------------------
 * 使い方:
 *   1. https://script.google.com で新しいプロジェクトを作成
 *   2. このファイルの中身を「コード.gs」に丸ごと貼り付ける
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      - 次のユーザーとして実行: 自分
 *      - アクセスできるユーザー : 全員  ← shift_demo.html から fetch するため
 *   4. 発行された URL を shift_demo.html の GAS_API_URL に貼る
 *
 * レスポンス形式（成功）:
 *   { ok: true, store: [[ヘッダー], [行...], ...], staff: [[ヘッダー], [行...], ...] }
 * レスポンス形式（失敗）:
 *   { ok: false, error: "メッセージ" }
 *
 * Date 型セルは "YYYY/MM/DD" 文字列に変換して返す。
 */

const STORE_SHEET_ID   = '1Ozyzi3WqYh7HkYYKBObZr8Mvsm941BQh4XL4w_qp-90';
const STAFF_SHEET_ID   = '1UnBwhX8AjBY_sGXNpiYg--3BB2hgh99eu18oL1uOOts';
const STORE_SHEET_NAME = 'シート1';
const STAFF_SHEET_NAME = 'Sheet1';

function doGet(e) {
  let payload;
  try {
    payload = {
      ok: true,
      store: readSheet_(STORE_SHEET_ID, STORE_SHEET_NAME),
      staff: readSheet_(STAFF_SHEET_ID, STAFF_SHEET_NAME),
    };
  } catch (err) {
    payload = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function readSheet_(ssId, sheetName) {
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(`シート「${sheetName}」が見つかりません (spreadsheetId=${ssId})`);
  }
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const tz = Session.getScriptTimeZone();
  return values.map(function (row) {
    return row.map(function (cell) {
      if (cell instanceof Date) {
        return Utilities.formatDate(cell, tz, 'yyyy/MM/dd');
      }
      return cell == null ? '' : String(cell);
    });
  });
}

/**
 * GAS エディタから手動で叩いて疎通確認するためのテスト関数
 * 実行 → ログで件数とヘッダーを確認
 */
function testRead() {
  const store = readSheet_(STORE_SHEET_ID, STORE_SHEET_NAME);
  const staff = readSheet_(STAFF_SHEET_ID, STAFF_SHEET_NAME);
  Logger.log('store rows = ' + store.length + ', header = ' + JSON.stringify(store[0]));
  Logger.log('staff rows = ' + staff.length + ', header = ' + JSON.stringify(staff[0]));
}
