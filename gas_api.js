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
const STORE_SHEET_NAME = '';
const STAFF_SHEET_NAME = 'Sheet1';
const SHIFT_DATA_SHEET_NAME = 'ShiftData';
const SHIFT_SETTINGS_SHEET_NAME = 'ShiftSettings';

function doGet(e) {
  let payload;
  try {
    const action = String(e && e.parameter && e.parameter.action || '');
    if (action === 'loadShift') {
      payload = loadShift_(e.parameter);
      return jsonOutput_(payload);
    }
    if (action === 'loadSettings') {
      payload = loadSettings_(e.parameter);
      return jsonOutput_(payload);
    }

    payload = {
      ok: true,
      store: readSheet_(STORE_SHEET_ID, STORE_SHEET_NAME),
      staff: readSheet_(STAFF_SHEET_ID, STAFF_SHEET_NAME),
    };
  } catch (err) {
    payload = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return jsonOutput_(payload);
}

function doPost(e) {
  let payload;
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const request = JSON.parse(body || '{}');
    const action = String(request.action || '');

    if (action === 'saveShift') payload = saveShift_(request);
    else if (action === 'saveSettings') payload = saveSettings_(request);
    else if (action === 'aiAdjust') payload = adjustShiftWithAI_(request);
    else payload = { ok: false, error: '未対応のactionです: ' + action };
  } catch (err) {
    payload = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return jsonOutput_(payload);
}

function readSheet_(ssId, sheetName) {
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];
  if (!sheet) {
    throw new Error(`読み込み対象のシートが見つかりません (spreadsheetId=${ssId}, sheetName=${sheetName || '先頭シート'})`);
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

function saveShift_(request) {
  const storeId = requireValue_(request.storeId, 'storeId');
  const year = requireValue_(request.year, 'year');
  const month = requireValue_(request.month, 'month');
  const record = {
    storeId: String(storeId),
    storeName: String(request.storeName || ''),
    year: Number(year),
    month: Number(month),
    cells: request.cells || {},
    updatedAt: new Date().toISOString()
  };
  saveRecord_(SHIFT_DATA_SHEET_NAME, shiftKey_(storeId, year, month), record);
  return { ok: true, updatedAt: record.updatedAt };
}

function loadShift_(params) {
  const storeId = requireValue_(params.storeId, 'storeId');
  const year = requireValue_(params.year, 'year');
  const month = requireValue_(params.month, 'month');
  const record = loadRecord_(SHIFT_DATA_SHEET_NAME, shiftKey_(storeId, year, month));
  if (!record) return { ok: true, cells: {}, updatedAt: '' };
  return { ok: true, cells: record.cells || {}, updatedAt: record.updatedAt || '' };
}

function saveSettings_(request) {
  const storeId = requireValue_(request.storeId, 'storeId');
  const record = {
    storeId: String(storeId),
    storeName: String(request.storeName || ''),
    minStaff: request.minStaff || {},
    storeSettings: request.storeSettings || {},
    staffConfig: request.staffConfig || {},
    extraRules: request.extraRules || {},
    updatedAt: new Date().toISOString()
  };
  saveRecord_(SHIFT_SETTINGS_SHEET_NAME, settingsKey_(storeId), record);
  return { ok: true, updatedAt: record.updatedAt };
}

function loadSettings_(params) {
  const storeId = requireValue_(params.storeId, 'storeId');
  const record = loadRecord_(SHIFT_SETTINGS_SHEET_NAME, settingsKey_(storeId));
  if (!record) return { ok: true, settings: {} };
  return {
    ok: true,
    settings: {
      minStaff: record.minStaff || {},
      storeSettings: record.storeSettings || {},
      staffConfig: record.staffConfig || {},
      extraRules: record.extraRules || {},
      updatedAt: record.updatedAt || ''
    }
  };
}

function adjustShiftWithAI_(request) {
  const prompt = requireValue_(request.prompt, 'prompt');
  const apiKey = String(
    request.apiKey ||
    PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') ||
    PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') ||
    ''
  ).trim();
  if (!apiKey) {
    return {
      ok: false,
      error: 'AI APIキーが未設定です。画面でAPIキーを入力するか、GASのスクリプトプロパティに ANTHROPIC_API_KEY または GEMINI_API_KEY を設定してください。'
    };
  }

  const text = apiKey.indexOf('sk-ant-') === 0
    ? callAnthropic_(apiKey, prompt)
    : callGemini_(apiKey, prompt);
  return { ok: true, result: parseAIJson_(text) };
}

function callAnthropic_(apiKey, prompt) {
  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });
  const data = parseResponse_(response, 'Anthropic API');
  return data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
}

function callGemini_(apiKey, prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    }),
    muteHttpExceptions: true
  });
  const data = parseResponse_(response, 'Gemini API');
  return data.candidates && data.candidates[0] &&
    data.candidates[0].content && data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0]
    ? data.candidates[0].content.parts[0].text
    : '';
}

function parseResponse_(response, label) {
  const code = response.getResponseCode();
  const text = response.getContentText();
  const data = JSON.parse(text || '{}');
  if (code < 200 || code >= 300) {
    const message = data.error && data.error.message ? data.error.message : text;
    throw new Error(label + ' error: ' + message);
  }
  return data;
}

function parseAIJson_(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AIの返答からJSONを読み取れませんでした。');
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  return {
    changes: Array.isArray(parsed.changes) ? parsed.changes : [],
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    summary: String(parsed.summary || '')
  };
}

function shiftKey_(storeId, year, month) {
  return ['shift', storeId, year, month].map(String).join(':');
}

function settingsKey_(storeId) {
  return 'settings:' + String(storeId);
}

function saveRecord_(sheetName, key, record) {
  const sheet = getStorageSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(key)) {
      rowIndex = i + 1;
      break;
    }
  }
  const row = [String(key), JSON.stringify(record), record.updatedAt || new Date().toISOString()];
  if (rowIndex === -1) sheet.appendRow(row);
  else sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
}

function loadRecord_(sheetName, key) {
  const sheet = getStorageSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(key)) {
      return values[i][1] ? JSON.parse(String(values[i][1])) : null;
    }
  }
  return null;
}

function getStorageSheet_(sheetName) {
  const storageSpreadsheetId = PropertiesService.getScriptProperties().getProperty('SHIFT_DATA_SPREADSHEET_ID') || STORE_SHEET_ID;
  const ss = SpreadsheetApp.openById(storageSpreadsheetId);
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['key', 'json', 'updatedAt']);
    try {
      sheet.hideSheet();
    } catch (err) {
      Logger.log('Could not hide storage sheet: ' + err);
    }
  }
  return sheet;
}

function requireValue_(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(name + ' が未指定です');
  }
  return value;
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
