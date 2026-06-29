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
const USE_SUPABASE_CORE_MASTERS_PROPERTY = 'SHIFT_USE_SUPABASE_CORE_MASTERS';
const USE_SUPABASE_SETTINGS_PROPERTY = 'SHIFT_USE_SUPABASE_SETTINGS';

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

    payload = loadMasters_();
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
function loadMasters_() {
  if (shouldUseSupabaseCoreMasters_()) {
    try {
      const masters = loadSupabaseCoreMasters_();
      return {
        ok: true,
        source: 'supabase',
        store: masters.store,
        staff: masters.staff
      };
    } catch (err) {
      Logger.log('Supabase core master load failed. Falling back to Sheets: ' + err);
    }
  }

  return {
    ok: true,
    source: 'sheets',
    store: readSheet_(STORE_SHEET_ID, STORE_SHEET_NAME),
    staff: readSheet_(STAFF_SHEET_ID, STAFF_SHEET_NAME)
  };
}

function shouldUseSupabaseCoreMasters_() {
  const props = PropertiesService.getScriptProperties();
  const flag = String(props.getProperty(USE_SUPABASE_CORE_MASTERS_PROPERTY) || 'true').toLowerCase();
  return flag !== 'false' &&
    Boolean(props.getProperty('SUPABASE_URL')) &&
    Boolean(props.getProperty('SUPABASE_SERVICE_ROLE_KEY'));
}

function loadSupabaseCoreMasters_() {
  const stores = supabaseRequest_('stores', {
    select: 'id,store_no,store_id,store_name,area,store_type,is_active,updated_at',
    order: 'store_no.asc',
    limit: '500'
  });
  const employees = supabaseRequest_('employees', {
    select: 'id,employee_id,full_name,email,birth_date,employment_status,employment_type,store_id,position_id,joined_on,retired_on,is_active,source_row',
    order: 'employee_id.asc',
    limit: '2000'
  });
  const positions = supabaseRequest_('positions', {
    select: 'id,position_name',
    order: 'position_no.asc',
    limit: '500'
  });

  const storesById = indexById_(stores);
  const positionsById = indexById_(positions);
  return {
    store: toStoreRows_(stores),
    staff: toStaffRows_(employees, storesById, positionsById)
  };
}

function toStoreRows_(stores) {
  const header = [
    '店舗番号',
    '店舗名',
    '定休日ルール',
    '平日営業開始時間',
    '土曜日営業開始時間',
    '日曜日営業開始時間',
    '祝日営業開始時間',
    'オープン日',
    '坪数',
    'm2',
    '家賃(共益費など込)',
    '坪単価',
    'セット面',
    'シャンプー台',
    '席単価',
    '所属',
    '状況',
    '特徴',
    '閉店日',
    'core_store_id',
    'store_id'
  ];
  const rows = stores
    .filter(function(store) { return store && store.is_active !== false; })
    .map(function(store) {
      const source = store.source_row || {};
      return [
        store.store_no || store.store_id || store.id || '',
        store.store_name || '',
        source.closed_rule || source.regular_holiday || '年中無休',
        source.weekday_open || '8:40～17:40',
        source.saturday_open || '8:40～17:40',
        source.sunday_open || '8:40～17:40',
        source.holiday_open || '8:40～17:40',
        source.opened_on || '',
        source.tsubo || '',
        source.square_meter || '',
        source.rent || '',
        source.unit_price_per_tsubo || '',
        source.seats || '',
        source.shampoo_stands || '',
        source.sales_per_seat || '',
        source.company_name || '',
        store.is_active === false ? '閉店' : '現行',
        source.feature || '',
        source.closed_on || '',
        store.id || '',
        store.store_id || ''
      ];
    });
  return [header].concat(rows);
}

function toStaffRows_(employees, storesById, positionsById) {
  const header = [
    '社員番号',
    '所属会社',
    '所属店舗',
    '役職',
    '雇用形態',
    '現職',
    '美容師免許取得者',
    '氏名',
    'フリガナ・姓',
    'フリガナ・名',
    '性別',
    '生年月日',
    '出身',
    '美容学校',
    '入社年月日',
    '中途入社',
    '退職日',
    'core_employee_id'
  ];
  const rows = employees
    .filter(function(employee) { return employee && employee.is_active !== false; })
    .map(function(employee) {
      const source = employee.source_row || {};
      const store = storesById[employee.store_id] || {};
      const position = positionsById[employee.position_id] || {};
      return [
        employee.employee_id || '',
        source.company_name || source.corporation_name || '',
        store.store_name || source.assigned_location || '',
        position.position_name || source.position_name || '',
        employee.employment_type || source.employment_type || '',
        employee.employment_status || source.employment_status || '現職',
        source.has_beautician_license || source.license || '○',
        employee.full_name || '',
        source.kana_last_name || '',
        source.kana_first_name || '',
        source.gender || '',
        formatDateValue_(source.birth_date || employee.birth_date || ''),
        source.birthplace || '',
        source.beauty_school || '',
        formatDateValue_(employee.joined_on || source.joined_on || ''),
        source.mid_career || '',
        formatDateValue_(employee.retired_on || source.retired_on || ''),
        employee.id || ''
      ];
    });
  return [header].concat(rows);
}

function supabaseRequest_(resource, query) {
  return supabaseFetch_(resource, {
    method: 'get',
    query: query
  });
}

function supabaseUpsert_(resource, query, payload) {
  return supabaseFetch_(resource, {
    method: 'post',
    query: query,
    payload: payload,
    prefer: 'resolution=merge-duplicates,return=representation'
  });
}

function supabasePatch_(resource, query, payload) {
  return supabaseFetch_(resource, {
    method: 'patch',
    query: query,
    payload: payload,
    prefer: 'return=representation'
  });
}

function supabaseFetch_(resource, options) {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = String(props.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  const serviceRoleKey = props.getProperty('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not configured.');

  const query = options && options.query ? options.query : {};
  const params = buildQueryString_(query);
  const url = baseUrl + '/rest/v1/' + encodeURIComponent(resource) + (params ? '?' + params : '');
  const headers = {
    apikey: serviceRoleKey,
    Authorization: 'Bearer ' + serviceRoleKey,
    Accept: 'application/json'
  };
  if (options && options.payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options && options.prefer) {
    headers.Prefer = options.prefer;
  }
  const response = UrlFetchApp.fetch(url, {
    method: options && options.method ? options.method : 'get',
    headers: headers,
    payload: options && options.payload !== undefined ? JSON.stringify(options.payload) : undefined,
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Supabase ' + resource + ' HTTP ' + code + ': ' + text.slice(0, 240));
  }
  return JSON.parse(text || '[]');
}

function buildQueryString_(query) {
  return Object.keys(query || {}).map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key]));
  }).join('&');
}

function indexById_(rows) {
  return (rows || []).reduce(function(index, row) {
    if (row && row.id) index[row.id] = row;
    return index;
  }, {});
}

function formatDateValue_(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy/MM/dd');
  }
  return String(value).slice(0, 10).replace(/-/g, '/');
}

function testRead() {
  const store = readSheet_(STORE_SHEET_ID, STORE_SHEET_NAME);
  const staff = readSheet_(STAFF_SHEET_ID, STAFF_SHEET_NAME);
  Logger.log('store rows = ' + store.length + ', header = ' + JSON.stringify(store[0]));
  Logger.log('staff rows = ' + staff.length + ', header = ' + JSON.stringify(staff[0]));
}

function testLoadMasters() {
  const payload = loadMasters_();
  Logger.log('source = ' + payload.source);
  Logger.log('store rows = ' + payload.store.length + ', header = ' + JSON.stringify(payload.store[0]));
  Logger.log('staff rows = ' + payload.staff.length + ', header = ' + JSON.stringify(payload.staff[0]));
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
  const record = buildSettingsRecord_(request);
  let supabaseError = '';
  if (shouldUseSupabaseSettings_()) {
    try {
      saveSettingsToSupabase_(record);
      saveRecord_(SHIFT_SETTINGS_SHEET_NAME, settingsKey_(storeId), record);
      return { ok: true, source: 'supabase', updatedAt: record.updatedAt };
    } catch (err) {
      supabaseError = String(err && err.message ? err.message : err);
      Logger.log('Supabase settings save failed. Falling back to Sheets: ' + supabaseError);
    }
  } else {
    supabaseError = getSupabaseSettingsDisabledReason_();
    Logger.log('Supabase settings save skipped. Falling back to Sheets: ' + supabaseError);
  }
  saveRecord_(SHIFT_SETTINGS_SHEET_NAME, settingsKey_(storeId), record);
  return { ok: true, source: 'sheets', updatedAt: record.updatedAt, fallbackReason: supabaseError };
}

function loadSettings_(params) {
  const storeId = requireValue_(params.storeId, 'storeId');
  if (shouldUseSupabaseSettings_()) {
    try {
      const record = loadSettingsFromSupabase_(String(storeId));
      if (record) return settingsPayload_(record, 'supabase');
    } catch (err) {
      Logger.log('Supabase settings load failed. Falling back to Sheets: ' + err);
    }
  }
  const record = loadRecord_(SHIFT_SETTINGS_SHEET_NAME, settingsKey_(storeId));
  if (!record) return { ok: true, settings: {} };
  return settingsPayload_(record, 'sheets');
}

function buildSettingsRecord_(request) {
  const storeId = requireValue_(request.storeId, 'storeId');
  return {
    storeId: String(storeId),
    storeName: String(request.storeName || ''),
    minStaff: request.minStaff || {},
    storeSettings: request.storeSettings || {},
    staffConfig: request.staffConfig || {},
    extraRules: request.extraRules || {},
    updatedAt: new Date().toISOString()
  };
}

function settingsPayload_(record, source) {
  return {
    ok: true,
    source: source || '',
    settings: {
      minStaff: record.minStaff || {},
      storeSettings: record.storeSettings || {},
      staffConfig: record.staffConfig || {},
      extraRules: record.extraRules || {},
      updatedAt: record.updatedAt || ''
    }
  };
}

function shouldUseSupabaseSettings_() {
  const props = PropertiesService.getScriptProperties();
  const flag = String(props.getProperty(USE_SUPABASE_SETTINGS_PROPERTY) || 'true').toLowerCase();
  return flag !== 'false' &&
    Boolean(props.getProperty('SUPABASE_URL')) &&
    Boolean(props.getProperty('SUPABASE_SERVICE_ROLE_KEY'));
}

function getSupabaseSettingsDisabledReason_() {
  const props = PropertiesService.getScriptProperties();
  const missing = [];
  const flag = String(props.getProperty(USE_SUPABASE_SETTINGS_PROPERTY) || 'true').toLowerCase();
  if (flag === 'false') missing.push(USE_SUPABASE_SETTINGS_PROPERTY + '=false');
  if (!props.getProperty('SUPABASE_URL')) missing.push('SUPABASE_URL missing');
  if (!props.getProperty('SUPABASE_SERVICE_ROLE_KEY')) missing.push('SUPABASE_SERVICE_ROLE_KEY missing');
  return missing.length ? missing.join(', ') : 'unknown reason';
}

function saveSettingsToSupabase_(record) {
  const storeId = String(record.storeId || '').trim();
  const minStaff = record.minStaff || {};
  const storeSettings = record.storeSettings || {};
  const extraRules = record.extraRules || {};
  const enabledExtraStamps = {
    half: Boolean(storeSettings.stampHalf),
    out: Boolean(storeSettings.stampOut),
    bereave: Boolean(storeSettings.stampBereave),
    special: Boolean(storeSettings.stampSpecial),
    groupView: Boolean(extraRules.groupView),
    managerRule: Boolean(extraRules.managerRule)
  };

  supabaseUpsert_('shift_store_settings', { on_conflict: 'store_id' }, [{
    store_id: storeId,
    weekday_min_staff: toInteger_(minStaff.weekday, 0),
    saturday_min_staff: toInteger_(minStaff.saturday, 0),
    sunday_min_staff: toInteger_(minStaff.sunday, 0),
    holiday_min_staff: toInteger_(minStaff.holiday, 0),
    max_requested_days: toInteger_(storeSettings.maxKibou, 2),
    no_holiday_on_saturday: storeSettings.noHolidayOnSat !== false,
    no_holiday_on_sunday: storeSettings.noHolidayOnSun !== false,
    no_holiday_on_holiday: storeSettings.noHolidayOnHol !== false,
    enable_requested_off_as_off: Boolean(storeSettings.kibouAsOff),
    enable_remarks_column: Boolean(storeSettings.remarksCol),
    enable_consecutive_holiday_limit: Boolean(storeSettings.consecLimit),
    consecutive_holiday_limit_count: toInteger_(storeSettings.consecLimitCount, 1),
    enabled_extra_stamps: enabledExtraStamps,
    custom_rule: String(storeSettings.customRule || '')
  }]);

  supabasePatch_('shift_staff_rules', { store_id: 'eq.' + storeId }, { is_active: false });

  const employeeIdsForStore = indexStringSet_(listEmployeeIdsForStore_(storeId));
  const staffRows = Object.keys(record.staffConfig || {}).map(function(employeeId) {
    const cfg = record.staffConfig[employeeId] || {};
    return {
      employee_id: employeeId,
      store_id: storeId,
      holiday_type: encodeHolidayType_(cfg.holidayType),
      work_type: encodeWorkType_(cfg.workType),
      start_time: normalizeTimeValue_(cfg.startTime),
      end_time: normalizeTimeValue_(cfg.endTime),
      max_requested_days: toInteger_(cfg.maxHoliday, 2),
      fixed_weekdays: Array.isArray(cfg.fixedWeekdays) ? cfg.fixedWeekdays.map(Number) : [],
      sunday_unavailable: Boolean(cfg.noSunday),
      note: String(cfg.note || ''),
      irregular_rules: cfg.irregular || {},
      is_active: true
    };
  }).filter(function(row) {
    return row.employee_id && row.store_id && (!Object.keys(employeeIdsForStore).length || employeeIdsForStore[row.employee_id]);
  });

  if (staffRows.length) {
    supabaseUpsert_('shift_staff_rules', { on_conflict: 'employee_id,store_id' }, staffRows);
  }
}

function listEmployeeIdsForStore_(storeId) {
  return supabaseRequest_('employees', {
    select: 'id',
    store_id: 'eq.' + storeId,
    is_active: 'eq.true',
    limit: '2000'
  }).map(function(employee) {
    return employee.id;
  }).filter(String);
}

function indexStringSet_(values) {
  return (values || []).reduce(function(index, value) {
    index[String(value)] = true;
    return index;
  }, {});
}

function loadSettingsFromSupabase_(storeId) {
  const storeRows = supabaseRequest_('shift_store_settings', {
    select: '*',
    store_id: 'eq.' + storeId,
    limit: '1'
  });
  const staffRows = supabaseRequest_('shift_staff_rules', {
    select: '*',
    store_id: 'eq.' + storeId,
    is_active: 'eq.true',
    limit: '2000'
  });
  if (!storeRows.length && !staffRows.length) return null;

  const row = storeRows[0] || {};
  const extraStamps = row.enabled_extra_stamps || {};
  const storeSettings = {
    maxKibou: row.max_requested_days == null ? 2 : Number(row.max_requested_days),
    noHolidayOnSat: row.no_holiday_on_saturday !== false,
    noHolidayOnSun: row.no_holiday_on_sunday !== false,
    noHolidayOnHol: row.no_holiday_on_holiday !== false,
    customRule: row.custom_rule || '',
    kibouAsOff: Boolean(row.enable_requested_off_as_off),
    remarksCol: Boolean(row.enable_remarks_column),
    consecLimit: Boolean(row.enable_consecutive_holiday_limit),
    consecLimitCount: row.consecutive_holiday_limit_count == null ? 1 : Number(row.consecutive_holiday_limit_count),
    stampHalf: Boolean(extraStamps.half),
    stampOut: Boolean(extraStamps.out),
    stampBereave: Boolean(extraStamps.bereave),
    stampSpecial: Boolean(extraStamps.special)
  };

  const staffConfig = {};
  staffRows.forEach(function(rule) {
    staffConfig[rule.employee_id] = {
      holidayType: decodeHolidayType_(rule.holiday_type),
      workType: decodeWorkType_(rule.work_type),
      startTime: stripSeconds_(rule.start_time) || '8:40',
      endTime: stripSeconds_(rule.end_time) || '17:40',
      maxHoliday: rule.max_requested_days == null ? 2 : Number(rule.max_requested_days),
      note: rule.note || '',
      noSunday: Boolean(rule.sunday_unavailable),
      fixedWeekdays: Array.isArray(rule.fixed_weekdays) ? rule.fixed_weekdays.map(Number) : [],
      irregular: rule.irregular_rules || {}
    };
  });

  return {
    storeId: storeId,
    minStaff: {
      weekday: row.weekday_min_staff == null ? '' : Number(row.weekday_min_staff),
      saturday: row.saturday_min_staff == null ? '' : Number(row.saturday_min_staff),
      sunday: row.sunday_min_staff == null ? '' : Number(row.sunday_min_staff),
      holiday: row.holiday_min_staff == null ? '' : Number(row.holiday_min_staff)
    },
    storeSettings: storeSettings,
    staffConfig: staffConfig,
    extraRules: {
      groupView: Boolean(extraStamps.groupView),
      managerRule: Boolean(extraStamps.managerRule)
    },
    updatedAt: row.updated_at || ''
  };
}

function encodeHolidayType_(value) {
  const text = String(value || '');
  if (text.indexOf('隔') !== -1) return 'alternate_two_days';
  if (text.indexOf('完全') !== -1) return 'full_two_days';
  return text ? 'custom' : 'full_two_days';
}

function decodeHolidayType_(value) {
  if (value === 'alternate_two_days') return '隔週休2日';
  if (value === 'full_two_days') return '完全週休2日';
  return '完全週休2日';
}

function encodeWorkType_(value) {
  const text = String(value || '');
  if (text.indexOf('時短') !== -1) return 'short_time';
  if (text.indexOf('受付') !== -1 || text.toLowerCase().indexOf('reception') !== -1) return 'reception_part';
  if (text.indexOf('通常') !== -1) return 'regular';
  return text ? 'custom' : 'regular';
}

function decodeWorkType_(value) {
  if (value === 'short_time') return '時短';
  if (value === 'reception_part') return '受付パート';
  return '通常';
}

function normalizeTimeValue_(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return ('0' + match[1]).slice(-2) + ':' + match[2] + ':00';
}

function stripSeconds_(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) + ':' + match[2] : '';
}

function toInteger_(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : fallback;
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
