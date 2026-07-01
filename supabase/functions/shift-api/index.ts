const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type Query = Record<string, string | number | boolean | undefined | null>;
type JsonRecord = Record<string, unknown>;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse({ ok: true }, 200);
  }

  try {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const action = String(url.searchParams.get("action") || "");
      if (action === "loadShift") {
        return jsonResponse(await loadShift(url.searchParams));
      }
      if (action === "loadSettings") {
        return jsonResponse(await loadSettings(url.searchParams));
      }
      return jsonResponse(await loadMasters());
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = String(body.action || "");
      if (action === "saveShift") return jsonResponse(await saveShift(body));
      if (action === "saveSettings") return jsonResponse(await saveSettings(body));
      if (action === "aiAdjust") return jsonResponse(await adjustShiftWithAI(body));
      return jsonResponse({ ok: false, error: `未対応のactionです: ${action}` }, 400);
    }

    return jsonResponse({ ok: false, error: `Unsupported method: ${req.method}` }, 405);
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function loadMasters() {
  const stores = await supabaseRequest("stores", {
    select: "id,store_no,store_id,store_name,area,store_type,is_active,updated_at",
    order: "store_no.asc",
    limit: "500",
  });
  const employees = await supabaseRequest("employees", {
    select: "id,employee_id,full_name,email,birth_date,employment_status,employment_type,store_id,position_id,joined_on,retired_on,is_active,source_row",
    order: "employee_id.asc",
    limit: "2000",
  });
  const positions = await supabaseRequest("positions", {
    select: "id,position_name",
    order: "position_no.asc",
    limit: "500",
  });

  return {
    ok: true,
    source: "supabase-edge",
    store: toStoreRows(stores),
    staff: toStaffRows(employees, indexById(stores), indexById(positions)),
  };
}

function toStoreRows(stores: JsonRecord[]) {
  const header = [
    "店舗番号",
    "店舗名",
    "定休日ルール",
    "平日営業開始時間",
    "土曜日営業開始時間",
    "日曜日営業開始時間",
    "祝日営業開始時間",
    "オープン日",
    "坪数",
    "m2",
    "家賃(共益費など込)",
    "坪単価",
    "セット面",
    "シャンプー台",
    "席単価",
    "所属",
    "状況",
    "特徴",
    "閉店日",
    "core_store_id",
    "store_id",
  ];

  const rows = stores
    .filter((store) => store && store.is_active !== false)
    .map((store) => {
      const source = asRecord(store.source_row);
      return [
        text(store.store_no || store.store_id || store.id),
        text(store.store_name),
        text(source.closed_rule || source.regular_holiday || "年中無休"),
        text(source.weekday_open || "8:40～17:40"),
        text(source.saturday_open || "8:40～17:40"),
        text(source.sunday_open || "8:40～17:40"),
        text(source.holiday_open || "8:40～17:40"),
        formatDateValue(source.opened_on),
        text(source.tsubo),
        text(source.square_meter),
        text(source.rent),
        text(source.unit_price_per_tsubo),
        text(source.seats),
        text(source.shampoo_stands),
        text(source.sales_per_seat),
        text(source.company_name),
        store.is_active === false ? "閉店" : "現行",
        text(source.feature),
        formatDateValue(source.closed_on),
        text(store.id),
        text(store.store_id),
      ];
    });

  return [header, ...rows];
}

function toStaffRows(employees: JsonRecord[], storesById: Record<string, JsonRecord>, positionsById: Record<string, JsonRecord>) {
  const header = [
    "社員番号",
    "所属会社",
    "所属店舗",
    "役職",
    "雇用形態",
    "現職",
    "美容師免許取得者",
    "氏名",
    "フリガナ・姓",
    "フリガナ・名",
    "性別",
    "生年月日",
    "出身",
    "美容学校",
    "入社年月日",
    "中途入社",
    "退職日",
    "core_employee_id",
  ];

  const rows = employees
    .filter((employee) => employee && employee.is_active !== false)
    .map((employee) => {
      const source = asRecord(employee.source_row);
      const store = storesById[text(employee.store_id)] || {};
      const position = positionsById[text(employee.position_id)] || {};
      return [
        text(employee.employee_id),
        text(source.company_name || source.corporation_name),
        text(store.store_name || source.assigned_location),
        text(position.position_name || source.position_name),
        text(employee.employment_type || source.employment_type),
        text(employee.employment_status || source.employment_status || "現職"),
        text(source.has_beautician_license || source.license || "○"),
        text(employee.full_name),
        text(source.kana_last_name),
        text(source.kana_first_name),
        text(source.gender),
        formatDateValue(source.birth_date || employee.birth_date),
        text(source.birthplace),
        text(source.beauty_school),
        formatDateValue(employee.joined_on || source.joined_on),
        text(source.mid_career),
        formatDateValue(employee.retired_on || source.retired_on),
        text(employee.id),
      ];
    });

  return [header, ...rows];
}

async function saveShift(request: JsonRecord) {
  const storeId = requireText(request.storeId, "storeId");
  const year = requireNumber(request.year, "year");
  const month = requireNumber(request.month, "month");
  const cells = asRecord(request.cells);

  const scheduleRows = await supabaseUpsert("shift_schedules", { on_conflict: "store_id,year,month" }, [{
    store_id: storeId,
    year,
    month,
    status: "draft",
    source: "manual",
    metadata: {
      store_name: text(request.storeName),
      saved_from: "supabase_edge_function",
    },
  }]);
  const schedule = scheduleRows[0];
  if (!schedule || !schedule.id) throw new Error("Supabase shift_schedules upsert returned no id.");

  await supabaseDelete("shift_schedule_cells", { schedule_id: `eq.${schedule.id}` });

  const cellRows = Object.keys(cells).map((key) => {
    const parsed = parseShiftCellKey(key);
    const stamp = encodeShiftStamp(cells[key]);
    if (!parsed || !stamp) return null;
    return {
      schedule_id: schedule.id,
      employee_id: parsed.employeeId,
      work_date: formatShiftDate(year, month, parsed.day),
      stamp,
      source: "manual",
      metadata: { ui_key: key, ui_stamp: text(cells[key]) },
    };
  }).filter(Boolean);

  if (cellRows.length) {
    await supabaseUpsert("shift_schedule_cells", { on_conflict: "schedule_id,employee_id,work_date" }, cellRows);
  }

  await writeAuditLog({
    store_id: storeId,
    schedule_id: text(schedule.id),
    action: "save_shift",
    target_table: "shift_schedules",
    target_id: text(schedule.id),
    metadata: {
      year,
      month,
      store_name: text(request.storeName),
      cell_count: cellRows.length,
      saved_from: "supabase_edge_function",
    },
  });

  return { ok: true, source: "supabase-edge", updatedAt: text(schedule.updated_at || new Date().toISOString()) };
}

async function loadShift(params: URLSearchParams) {
  const storeId = requireText(params.get("storeId"), "storeId");
  const year = requireNumber(params.get("year"), "year");
  const month = requireNumber(params.get("month"), "month");

  const scheduleRows = await supabaseRequest("shift_schedules", {
    select: "id,updated_at",
    store_id: `eq.${storeId}`,
    year: `eq.${year}`,
    month: `eq.${month}`,
    limit: "1",
  });
  const schedule = scheduleRows[0];
  if (!schedule || !schedule.id) {
    return { ok: true, source: "supabase-edge", cells: {}, updatedAt: "" };
  }

  const cellRows = await supabaseRequest("shift_schedule_cells", {
    select: "employee_id,work_date,stamp,metadata",
    schedule_id: `eq.${schedule.id}`,
    limit: "5000",
  });
  const cells: Record<string, string> = {};
  cellRows.forEach((row) => {
    const day = dayFromDateString(row.work_date);
    const stamp = decodeShiftStamp(row.stamp);
    if (!row.employee_id || !day || !stamp) return;
    cells[`${row.employee_id}-${day}`] = stamp;
  });

  return { ok: true, source: "supabase-edge", cells, updatedAt: text(schedule.updated_at) };
}

async function saveSettings(request: JsonRecord) {
  const storeId = requireText(request.storeId, "storeId");
  const minStaff = asRecord(request.minStaff);
  const storeSettings = asRecord(request.storeSettings);
  const extraRules = asRecord(request.extraRules);

  const enabledExtraStamps = {
    half: Boolean(extraRules.stampHalf ?? storeSettings.stampHalf),
    out: Boolean(extraRules.stampOut ?? storeSettings.stampOut),
    bereave: Boolean(extraRules.stampBereave ?? storeSettings.stampBereave),
    special: Boolean(extraRules.stampSpecial ?? storeSettings.stampSpecial),
    groupView: Boolean(extraRules.groupView),
    managerRule: Boolean(extraRules.managerRule),
  };

  const storeRows = await supabaseUpsert("shift_store_settings", { on_conflict: "store_id" }, [{
    store_id: storeId,
    weekday_min_staff: toInteger(minStaff.weekday, 0),
    saturday_min_staff: toInteger(minStaff.saturday, 0),
    sunday_min_staff: toInteger(minStaff.sunday, 0),
    holiday_min_staff: toInteger(minStaff.holiday, 0),
    max_requested_days: toInteger(storeSettings.maxKibou, 2),
    no_holiday_on_saturday: (extraRules.noHolidayOnSat ?? storeSettings.noHolidayOnSat) !== false,
    no_holiday_on_sunday: (extraRules.noHolidayOnSun ?? storeSettings.noHolidayOnSun) !== false,
    no_holiday_on_holiday: (extraRules.noHolidayOnHol ?? storeSettings.noHolidayOnHol) !== false,
    enable_requested_off_as_off: Boolean(extraRules.kibouAsOff ?? storeSettings.kibouAsOff),
    enable_remarks_column: Boolean(extraRules.remarksCol ?? storeSettings.remarksCol),
    enable_consecutive_holiday_limit: Boolean(storeSettings.consecLimit),
    consecutive_holiday_limit_count: toInteger(storeSettings.consecLimitCount, 1),
    enabled_extra_stamps: enabledExtraStamps,
    custom_rule: text(extraRules.customRule || storeSettings.customRule),
  }]);

  await supabasePatch("shift_staff_rules", { store_id: `eq.${storeId}` }, { is_active: false });

  const employeeIdsForStore = await listEmployeeIdsForStore(storeId);
  const staffConfig = asRecord(request.staffConfig);
  const staffRows = Object.keys(staffConfig).map((employeeId) => {
    const cfg = asRecord(staffConfig[employeeId]);
    return {
      employee_id: employeeId,
      store_id: storeId,
      holiday_type: encodeHolidayType(cfg.holidayType),
      work_type: encodeWorkType(cfg.workType),
      start_time: normalizeTimeValue(cfg.startTime),
      end_time: normalizeTimeValue(cfg.endTime),
      max_requested_days: toInteger(cfg.maxHoliday, 2),
      fixed_weekdays: Array.isArray(cfg.fixedWeekdays) ? cfg.fixedWeekdays.map(Number) : [],
      sunday_unavailable: Boolean(cfg.noSunday),
      note: text(cfg.note),
      irregular_rules: asRecord(cfg.irregular),
      is_active: true,
    };
  }).filter((row) => row.employee_id && row.store_id && (!employeeIdsForStore.size || employeeIdsForStore.has(row.employee_id)));

  if (staffRows.length) {
    await supabaseUpsert("shift_staff_rules", { on_conflict: "employee_id,store_id" }, staffRows);
  }

  await writeAuditLog({
    store_id: storeId,
    action: "save_settings",
    target_table: "shift_store_settings",
    target_id: text(storeRows[0]?.id) || null,
    metadata: {
      store_name: text(request.storeName),
      staff_rule_count: staffRows.length,
      min_staff: minStaff,
      saved_from: "supabase_edge_function",
    },
  });

  return { ok: true, source: "supabase-edge", updatedAt: text(storeRows[0]?.updated_at || new Date().toISOString()) };
}

async function loadSettings(params: URLSearchParams) {
  const storeId = requireText(params.get("storeId"), "storeId");
  const storeRows = await supabaseRequest("shift_store_settings", {
    select: "*",
    store_id: `eq.${storeId}`,
    limit: "1",
  });
  const staffRows = await supabaseRequest("shift_staff_rules", {
    select: "*",
    store_id: `eq.${storeId}`,
    is_active: "eq.true",
    limit: "2000",
  });

  if (!storeRows.length && !staffRows.length) {
    return { ok: true, source: "supabase-edge", settings: null };
  }

  const row = storeRows[0] || {};
  const extraStamps = asRecord(row.enabled_extra_stamps);
  const staffConfig: Record<string, unknown> = {};
  staffRows.forEach((rule) => {
    staffConfig[text(rule.employee_id)] = {
      holidayType: decodeHolidayType(rule.holiday_type),
      workType: decodeWorkType(rule.work_type),
      startTime: stripSeconds(rule.start_time) || "8:40",
      endTime: stripSeconds(rule.end_time) || "17:40",
      maxHoliday: rule.max_requested_days == null ? 2 : Number(rule.max_requested_days),
      note: text(rule.note),
      noSunday: Boolean(rule.sunday_unavailable),
      fixedWeekdays: Array.isArray(rule.fixed_weekdays) ? rule.fixed_weekdays.map(Number) : [],
      irregular: asRecord(rule.irregular_rules),
    };
  });

  return {
    ok: true,
    source: "supabase-edge",
    settings: {
      storeId,
      minStaff: {
        weekday: row.weekday_min_staff == null ? "" : Number(row.weekday_min_staff),
        saturday: row.saturday_min_staff == null ? "" : Number(row.saturday_min_staff),
        sunday: row.sunday_min_staff == null ? "" : Number(row.sunday_min_staff),
        holiday: row.holiday_min_staff == null ? "" : Number(row.holiday_min_staff),
      },
      storeSettings: {
        maxKibou: row.max_requested_days == null ? 2 : Number(row.max_requested_days),
        noHolidayOnSat: row.no_holiday_on_saturday !== false,
        noHolidayOnSun: row.no_holiday_on_sunday !== false,
        noHolidayOnHol: row.no_holiday_on_holiday !== false,
        customRule: text(row.custom_rule),
        kibouAsOff: Boolean(row.enable_requested_off_as_off),
        remarksCol: Boolean(row.enable_remarks_column),
        consecLimit: Boolean(row.enable_consecutive_holiday_limit),
        consecLimitCount: row.consecutive_holiday_limit_count == null ? 1 : Number(row.consecutive_holiday_limit_count),
        stampHalf: Boolean(extraStamps.half),
        stampOut: Boolean(extraStamps.out),
        stampBereave: Boolean(extraStamps.bereave),
        stampSpecial: Boolean(extraStamps.special),
      },
      staffConfig,
      extraRules: {
        groupView: Boolean(extraStamps.groupView),
        managerRule: Boolean(extraStamps.managerRule),
      },
      updatedAt: text(row.updated_at),
    },
  };
}

async function adjustShiftWithAI(request: JsonRecord) {
  const prompt = requireText(request.prompt, "prompt");
  const apiKey = text(request.apiKey || Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("GEMINI_API_KEY")).trim();
  if (!apiKey) {
    return { ok: false, error: "AI APIキーが未設定です。画面でAPIキーを入力するか、Edge Function secretsに ANTHROPIC_API_KEY または GEMINI_API_KEY を設定してください。" };
  }
  const aiText = apiKey.startsWith("sk-ant-")
    ? await callAnthropic(apiKey, prompt)
    : await callGemini(apiKey, prompt);
  return { ok: true, source: "supabase-edge", result: parseAIJson(aiText) };
}

async function callAnthropic(apiKey: string, prompt: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await parseHttpJson(res, "Anthropic API");
  return text(data.content?.[0]?.text);
}

async function callGemini(apiKey: string, prompt: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
  });
  const data = await parseHttpJson(res, "Gemini API");
  return text(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function listEmployeeIdsForStore(storeId: string) {
  const rows = await supabaseRequest("employees", {
    select: "id",
    store_id: `eq.${storeId}`,
    is_active: "eq.true",
    limit: "2000",
  });
  return new Set(rows.map((employee) => text(employee.id)).filter(Boolean));
}

async function supabaseRequest(resource: string, query: Query = {}) {
  return supabaseFetch(resource, { method: "GET", query });
}

async function supabaseUpsert(resource: string, query: Query, payload: unknown) {
  return supabaseFetch(resource, {
    method: "POST",
    query,
    payload,
    prefer: "resolution=merge-duplicates,return=representation",
  });
}

async function supabasePatch(resource: string, query: Query, payload: unknown) {
  return supabaseFetch(resource, {
    method: "PATCH",
    query,
    payload,
    prefer: "return=representation",
  });
}

async function supabaseInsert(resource: string, payload: unknown) {
  return supabaseFetch(resource, {
    method: "POST",
    payload,
    prefer: "return=representation",
  });
}

async function writeAuditLog(entry: JsonRecord) {
  try {
    const metadata = asRecord(entry.metadata);
    await supabaseInsert("shift_audit_logs", [{
      ...entry,
      metadata: {
        ...metadata,
        logged_from: "shift-api",
      },
    }]);
  } catch (err) {
    console.warn("[shift_audit_logs] skipped:", errorMessage(err));
  }
}

async function supabaseDelete(resource: string, query: Query) {
  return supabaseFetch(resource, {
    method: "DELETE",
    query,
    prefer: "return=representation",
  });
}

async function supabaseFetch(resource: string, options: { method: string; query?: Query; payload?: unknown; prefer?: string }) {
  const baseUrl = text(Deno.env.get("SUPABASE_URL")).replace(/\/+$/, "");
  const serviceRoleKey = text(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!baseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not configured.");

  const params = buildQueryString(options.query || {});
  const url = `${baseUrl}/rest/v1/${encodeURIComponent(resource)}${params ? `?${params}` : ""}`;
  const headers: HeadersInit = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
  };
  if (options.payload !== undefined) headers["Content-Type"] = "application/json";
  if (options.prefer) headers.Prefer = options.prefer;

  const res = await fetch(url, {
    method: options.method,
    headers,
    body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${resource} HTTP ${res.status}: ${bodyText.slice(0, 240)}`);
  }
  return bodyText ? JSON.parse(bodyText) : [];
}

async function parseHttpJson(res: Response, label: string) {
  const bodyText = await res.text();
  const data = bodyText ? JSON.parse(bodyText) : {};
  if (!res.ok) {
    const message = data?.error?.message || bodyText;
    throw new Error(`${label} error: ${message}`);
  }
  return data;
}

function buildQueryString(query: Query) {
  return Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== null)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`)
    .join("&");
}

function parseShiftCellKey(key: string) {
  const dash = String(key || "").lastIndexOf("-");
  if (dash <= 0) return null;
  const employeeId = key.slice(0, dash);
  const day = Number(key.slice(dash + 1));
  if (!employeeId || !Number.isFinite(day) || day < 1 || day > 31) return null;
  return { employeeId, day };
}

function formatShiftDate(year: number, month: number, day: number) {
  return [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

function dayFromDateString(value: unknown) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? Number(match[3]) : 0;
}

function encodeShiftStamp(stamp: unknown) {
  const map: Record<string, string> = {
    "出": "work",
    "必": "required_work",
    "公": "manual_off",
    "希": "requested_off",
    "有": "paid_leave",
    "時": "short_time",
    "研": "training",
    "会": "meeting",
    "半": "half_day",
    "外": "outside",
    "忌": "bereavement",
    "特": "special_leave",
    "定": "closed",
  };
  return map[text(stamp).trim()] || "";
}

function decodeShiftStamp(stamp: unknown) {
  const map: Record<string, string> = {
    work: "出",
    required_work: "必",
    off: "公",
    manual_off: "公",
    requested_off: "希",
    paid_leave: "有",
    ng_work: "公",
    short_time: "時",
    training: "研",
    meeting: "会",
    half_day: "半",
    outside: "外",
    bereavement: "忌",
    special_leave: "特",
    closed: "定",
  };
  return map[text(stamp)] || "";
}

function encodeHolidayType(value: unknown) {
  const valueText = text(value);
  if (valueText.includes("隔")) return "alternate_two_days";
  if (valueText.includes("完全")) return "full_two_days";
  return valueText ? "custom" : "full_two_days";
}

function decodeHolidayType(value: unknown) {
  if (value === "alternate_two_days") return "隔週休2日";
  if (value === "full_two_days") return "完全週休2日";
  return "完全週休2日";
}

function encodeWorkType(value: unknown) {
  const valueText = text(value);
  if (valueText.includes("時短")) return "short_time";
  if (valueText.includes("受付") || valueText.toLowerCase().includes("reception")) return "reception_part";
  if (valueText.includes("通常")) return "regular";
  return valueText ? "custom" : "regular";
}

function decodeWorkType(value: unknown) {
  if (value === "short_time") return "時短";
  if (value === "reception_part") return "受付パート";
  return "通常";
}

function normalizeTimeValue(value: unknown) {
  const match = text(value).trim().match(/^(\d{1,2}):(\d{2})/);
  return match ? `${String(Number(match[1])).padStart(2, "0")}:${match[2]}:00` : null;
}

function stripSeconds(value: unknown) {
  const match = text(value).trim().match(/^(\d{1,2}):(\d{2})/);
  return match ? `${Number(match[1])}:${match[2]}` : "";
}

function parseAIJson(value: string) {
  const cleaned = text(value).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("AIの返答からJSONを読み取れませんでした。");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  return {
    changes: Array.isArray(parsed.changes) ? parsed.changes : [],
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    summary: text(parsed.summary),
  };
}

function indexById(rows: JsonRecord[]) {
  return rows.reduce<Record<string, JsonRecord>>((index, row) => {
    if (row && row.id) index[text(row.id)] = row;
    return index;
  }, {});
}

function formatDateValue(value: unknown) {
  if (!value) return "";
  return text(value).slice(0, 10).replace(/-/g, "/");
}

function toInteger(value: unknown, fallback: number) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : fallback;
}

function requireText(value: unknown, name: string) {
  const valueText = text(value).trim();
  if (!valueText) throw new Error(`${name} が未指定です`);
  return valueText;
}

function requireNumber(value: unknown, name: string) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`${name} が未指定です`);
  return num;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
