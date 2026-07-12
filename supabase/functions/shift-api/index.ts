import { applyVerifiedActor, authenticateShiftRequest, authorizeShiftAction, ShiftApiError, type ShiftAuthContext } from "./shift-hub-session-auth.ts";
import { buildShiftStatusCasFilters, evaluateShiftStatusTransition, isSingleShiftStatusUpdate, type ShiftScheduleStatus } from "./shift-status-transition-policy.ts";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://ideanow-shift.github.io",
  "https://idea-nov.com",
  "https://www.idea-nov.com",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": DEFAULT_ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type Query = Record<string, string | number | boolean | undefined | null>;
type JsonRecord = Record<string, unknown>;

const SHIFT_DEFAULT_TIMEZONE = "Asia/Tokyo";
const WORK_SHIFT_STAMPS = new Set([
  "work",
  "required_work",
  "short_time",
  "training",
  "meeting",
  "half_day",
  "outside",
]);
const SHIFT_SAVE_MAX_CELLS = 2000;
const SHIFT_SAVE_MAX_JSON_BYTES = 1000000;
const SHIFT_SAVE_GLOBAL_WRITE_ROLES = new Set(["super_admin", "backoffice"]);
const SHIFT_SAVE_ASSIGNMENT_WRITE_ROLES = new Set(["store_manager", "area_manager", "fc_owner"]);

Deno.serve(async (req: Request) => {
  const requestCorsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: requestCorsHeaders });
  }

  try {
    const url = new URL(req.url);
    const auth = await authenticateShiftRequest(req, supabaseRequest);
    if (req.method === "GET") {
      const action = String(url.searchParams.get("action") || "loadMasters");
      await authorizeShiftAction(auth, "GET", action, url.searchParams.get("storeId"));
      if (action === "loadShift") {
        return jsonResponse(await loadShift(url.searchParams), 200, requestCorsHeaders);
      }
      if (action === "loadSettings") {
        return jsonResponse(await loadSettings(url.searchParams), 200, requestCorsHeaders);
      }
      return jsonResponse(await loadMasters(), 200, requestCorsHeaders);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = String(body.action || "");
      if (action === "saveShift") {
        await authorizeSaveShiftByAssignment(auth, body.storeId);
        applyVerifiedActor(body, auth);
        return jsonResponse(await saveShiftViaTransactionalRpc(body, auth), 200, requestCorsHeaders);
      }
      await authorizeShiftAction(auth, "POST", action, body.storeId);
      applyVerifiedActor(body, auth);
      if (action === "saveSettings") return jsonResponse(await saveSettings(body), 200, requestCorsHeaders);
      if (action === "updateScheduleStatus") return jsonResponse(await updateScheduleStatus(body), 200, requestCorsHeaders);
      if (action === "aiAdjust") return jsonResponse(await adjustShiftWithAI(body), 200, requestCorsHeaders);
      return jsonResponse({ ok: false, error: `未対応のactionです: ${action}` }, 400);
    }

    return jsonResponse({ ok: false, code: "METHOD_NOT_ALLOWED", error: "Method is not supported." }, 405, requestCorsHeaders);
  } catch (err) {
    if (err instanceof ShiftApiError) {
      return jsonResponse({ ok: false, code: err.code, error: err.message }, err.status, requestCorsHeaders);
    }
    console.warn("[shift-api] request failed: INTERNAL_ERROR");
    return jsonResponse({ ok: false, code: "INTERNAL_ERROR", error: "Shift API request failed." }, 500, requestCorsHeaders);
  }
});

function jsonResponse(payload: unknown, status = 200, headers = corsHeaders): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function buildCorsHeaders(req: Request) {
  const configured = text(Deno.env.get("SHIFT_ALLOWED_ORIGINS"))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    ...corsHeaders,
    "Access-Control-Allow-Origin": allowedOrigin,
  };
}

async function loadMasters() {
  const stores = await supabaseRequest("stores", {
    select: "id,store_no,store_id,store_name,area,store_type,is_active,updated_at",
    order: "store_no.asc",
    limit: "500",
  });
  const employees = await loadEmployeesForShift();
  const positions = await supabaseRequest("positions", {
    select: "id,position_name",
    order: "position_no.asc",
    limit: "500",
  });
  const jobTypes = await loadJobTypesForShift();

  return {
    ok: true,
    source: "supabase-edge",
    jobTypeSource: jobTypes.length > 0 ? "job_types" : "core-db-pending",
    store: toShiftStoreRows(stores),
    staff: toShiftStaffRows(employees, indexById(stores), indexById(positions), indexById(jobTypes)),
  };
}

async function loadEmployeesForShift() {
  const common = {
    order: "employee_id.asc",
    limit: "2000",
  };
  try {
    return await supabaseRequest("employees", {
      ...common,
      select: "id,employee_id,full_name,employment_status,employment_type,store_id,position_id,job_type_id,is_active,retired_on",
    });
  } catch (err) {
    console.warn("[employees.job_type_id] pending Core DB setup");
    return await supabaseRequest("employees", {
      ...common,
      select: "id,employee_id,full_name,employment_status,employment_type,store_id,position_id,is_active,retired_on",
    });
  }
}

async function loadJobTypesForShift() {
  let lastError: unknown = null;
  for (const select of ["id,job_type_key,job_type_name", "id,job_type_name", "id,name", "id"]) {
    try {
      return await supabaseRequest("job_types", {
        select,
        limit: "500",
      });
    } catch (err) {
      lastError = err;
    }
  }
  console.warn("[job_types] pending Core DB setup");
  return [];
}

function toShiftStoreRows(stores: JsonRecord[]) {
  const header = [
    "\u5e97\u8217\u756a\u53f7",
    "\u5e97\u8217\u540d",
    "\u5b9a\u4f11\u65e5\u30eb\u30fc\u30eb",
    "\u5e73\u65e5\u55b6\u696d\u958b\u59cb\u6642\u9593",
    "\u571f\u66dc\u65e5\u55b6\u696d\u958b\u59cb\u6642\u9593",
    "\u65e5\u66dc\u65e5\u55b6\u696d\u958b\u59cb\u6642\u9593",
    "\u795d\u65e5\u55b6\u696d\u958b\u59cb\u6642\u9593",
    "\u6240\u5c5e",
    "\u72b6\u6cc1",
    "\u7279\u5fb4",
    "core_store_id",
    "store_id",
  ];

  const rows = stores
    .filter((store) => store && store.is_active !== false)
    .map((store) => [
      text(store.store_no || store.store_id || store.id),
      text(store.store_name),
      "",
      "",
      "",
      "",
      "",
      text(store.area),
      store.is_active === false ? "inactive" : "active",
      text(store.store_type),
      text(store.id),
      text(store.store_id),
    ]);

  return [header, ...rows];
}

function toShiftStaffRows(employees: JsonRecord[], storesById: Record<string, JsonRecord>, positionsById: Record<string, JsonRecord>, jobTypesById: Record<string, JsonRecord>) {
  const header = [
    "\u793e\u54e1\u756a\u53f7",
    "\u6240\u5c5e\u4f1a\u793e",
    "\u6240\u5c5e\u5e97\u8217",
    "job_type_key",
    "\u8077\u7a2e",
    "\u5f79\u8077",
    "\u96c7\u7528\u5f62\u614b",
    "\u73fe\u8077",
    "\u7f8e\u5bb9\u5e2b\u514d\u8a31\u53d6\u5f97\u8005",
    "\u6c0f\u540d",
    "core_employee_id",
  ];

  const rows = employees
    .filter((employee) => isShiftStaffMasterActive(employee))
    .map((employee) => {
      const store = storesById[text(employee.store_id)] || {};
      const position = positionsById[text(employee.position_id)] || {};
      const jobType = jobTypesById[text(employee.job_type_id)] || {};
      const jobTypeKey = text(jobType.job_type_key);
      const jobTypeName = text(jobType.job_type_name || jobType.name);
      const normalizedJobTypeKey = normalizeClassText(jobTypeKey);
      const normalizedJobTypeName = normalizeClassText(jobTypeName);
      const defaultLicense = normalizedJobTypeKey === "reception"
        || normalizedJobTypeKey === "head_office"
        || normalizedJobTypeKey === "headoffice"
        || normalizedJobTypeName.includes("reception")
        || normalizedJobTypeName.includes("backoffice")
        ? "\u00d7"
        : "\u25cb";
      return [
        text(employee.employee_id),
        "",
        text(store.store_name),
        jobTypeKey,
        jobTypeName,
        text(position.position_name),
        text(employee.employment_type),
        text(employee.employment_status),
        defaultLicense,
        text(employee.full_name),
        text(employee.id),
      ];
    });

  return [header, ...rows];
}

function isShiftStaffMasterActive(employee: JsonRecord) {
  if (!employee || employee.is_active !== true) return false;
  if (isPastOrTodayDate(employee.retired_on)) return false;
  return !hasInactiveEmploymentStatus(employee.employment_status);
}

function hasInactiveEmploymentStatus(value: unknown) {
  const status = normalizeClassText(text(value));
  const inactiveStatuses = [
    "retired",
    "inactive",
    "leave",
    "suspended",
    "\u9000\u8077",
    "\u4f11\u8077",
    "\u7523\u4f11",
    "\u80b2\u4f11",
    "\u7523\u4f11\u30fb\u80b2\u4f11",
  ];
  return inactiveStatuses.some((inactiveStatus) => status.includes(inactiveStatus));
}

function isPastOrTodayDate(value: unknown) {
  const dateText = text(value).trim();
  if (!dateText) return false;
  const date = new Date(`${dateText.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return true;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return date.getTime() <= today.getTime();
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

function toStaffRows(employees: JsonRecord[], storesById: Record<string, JsonRecord>, positionsById: Record<string, JsonRecord>, jobTypesById: Record<string, JsonRecord>) {
  const header = [
    "社員番号",
    "所属会社",
    "所属店舗",
    "job_type_key",
    "職種",
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
      const jobType = jobTypesById[text(employee.job_type_id)] || {};
      const jobTypeKey = text(jobType.job_type_key || source.job_type_key);
      const jobTypeName = text(jobType.job_type_name || jobType.name || source.job_type_name || source.job_type || source["職種"]);
      const normalizedJobTypeKey = normalizeClassText(jobTypeKey);
      const normalizedJobTypeName = normalizeClassText(jobTypeName);
      const defaultLicense = normalizedJobTypeKey === "reception"
        || normalizedJobTypeKey === "head_office"
        || normalizedJobTypeKey === "headoffice"
        || normalizedJobTypeName.includes("レセプション")
        || normalizedJobTypeName.includes("受付")
        || normalizedJobTypeName.includes("reception")
        || normalizedJobTypeName.includes("本部")
        || normalizedJobTypeName.includes("backoffice")
        ? "×"
        : "○";
      const licenseSourceValue = source.has_beautician_license ?? source.license;
      const licenseText = licenseSourceValue == null || text(licenseSourceValue).trim() === ""
        ? defaultLicense
        : text(licenseSourceValue);
      return [
        text(employee.employee_id),
        text(source.company_name || source.corporation_name),
        text(store.store_name || source.assigned_location),
        jobTypeKey,
        jobTypeName,
        text(position.position_name || source.position_name),
        text(employee.employment_type || source.employment_type),
        text(employee.employment_status || source.employment_status || "現職"),
        licenseText,
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

async function authorizeSaveShiftByAssignment(auth: ShiftAuthContext, storeIdValue: unknown) {
  const storeId = requireText(storeIdValue, "storeId");
  if (auth.roles.some((role) => SHIFT_SAVE_GLOBAL_WRITE_ROLES.has(role.roleKey))) return;
  if (!auth.roles.some((role) => SHIFT_SAVE_ASSIGNMENT_WRITE_ROLES.has(role.roleKey))) {
    throw new ShiftApiError("ACCESS_DENIED", "This role cannot save the requested shift.", 403);
  }
  const rows = await supabaseRequest("employee_store_assignments", {
    select: "id",
    employee_id: `eq.${auth.employeeId}`,
    store_id: `eq.${storeId}`,
    is_active: "eq.true",
    limit: "1",
  });
  if (!rows.length) {
    throw new ShiftApiError("ACCESS_DENIED", "This employee is not assigned to the requested store.", 403);
  }
}

async function saveShiftViaTransactionalRpc(request: JsonRecord, auth: ShiftAuthContext) {
  const storeId = requireText(request.storeId, "storeId");
  const year = requireNumber(request.year, "year");
  const month = requireNumber(request.month, "month");
  const requestId = requireText(request.requestId || request.idempotencyKey, "requestId");
  const requestedStatus = normalizeScheduleStatus(request.status) || "draft";
  if (requestedStatus !== "draft") {
    throw new ShiftApiError("INVALID_REQUEST", "Only draft save is supported by this write gate.", 400);
  }

  const cells = asRecord(request.cells);
  const rpcCells = normalizeSaveShiftCellsForRpc(cells, year, month);
  validateSaveShiftRpcPayload(rpcCells);

  const resultRows = await supabaseRpc("shift_save_draft_transactional", {
    p_actor_employee_id: auth.employeeId,
    p_store_id: storeId,
    p_year: year,
    p_month: month,
    p_request_id: requestId,
    p_cells: rpcCells,
  });
  const result = Array.isArray(resultRows) ? asRecord(resultRows[0]) : asRecord(resultRows);
  return {
    ok: result.ok === true,
    source: "supabase-rpc",
    duplicate: result.duplicate === true,
    status: text(result.status || "draft"),
    cellCount: Number(result.cellCount || result.cell_count || rpcCells.length),
  };
}

function normalizeSaveShiftCellsForRpc(cells: JsonRecord, year: number, month: number) {
  const rows: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(cells)) {
    const parsed = parseShiftCellKey(key);
    if (!parsed) continue;
    const stamp = encodeShiftStamp(cells[key]);
    if (!stamp) continue;
    const workDate = formatShiftDate(year, month, parsed.day);
    const dedupeKey = `${parsed.employeeId}:${workDate}`;
    if (seen.has(dedupeKey)) {
      throw new ShiftApiError("DUPLICATE_CELL_PAIR", "Duplicate employee/date shift cell.", 400);
    }
    seen.add(dedupeKey);
    rows.push({
      employee_id: parsed.employeeId,
      work_date: workDate,
      stamp,
      start_time: null,
      end_time: null,
    });
  }
  return rows;
}

function validateSaveShiftRpcPayload(rpcCells: JsonRecord[]) {
  if (!rpcCells.length || rpcCells.length > SHIFT_SAVE_MAX_CELLS) {
    throw new ShiftApiError("CELL_COUNT_OUT_OF_RANGE", "Shift cell count is outside the allowed range.", 400);
  }
  const encoded = JSON.stringify(rpcCells);
  if (new TextEncoder().encode(encoded).length > SHIFT_SAVE_MAX_JSON_BYTES) {
    throw new ShiftApiError("CELLS_JSON_TOO_LARGE", "Shift cell payload is too large.", 400);
  }
}

async function supabaseRpc(functionName: string, payload: JsonRecord) {
  const baseUrl = text(Deno.env.get("SUPABASE_URL")).replace(/\/+$/, "");
  const serviceRoleKey = text(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!baseUrl || !serviceRoleKey) throw new ShiftApiError("SETUP_MISSING", "Supabase service is not configured.", 500);
  const res = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw mapSupabaseRpcError(res.status, await parseSupabaseRpcSafeErrorCode(res));
  }
  return await res.json().catch(() => []);
}

async function parseSupabaseRpcSafeErrorCode(res: Response) {
  try {
    const data = await res.json();
    const message = text(asRecord(data).message).trim();
    return message && /^[A-Z0-9_]+$/.test(message) ? message : "";
  } catch (_err) {
    return "";
  }
}

function mapSupabaseRpcError(status: number, code: string) {
  const safeCode = code || (status >= 500 ? "SHIFT_SAVE_RPC_UNAVAILABLE" : "SHIFT_SAVE_RPC_REJECTED");
  const rejectCodes = new Set([
    "ACTOR_REQUIRED",
    "STORE_REQUIRED",
    "INVALID_YEAR",
    "INVALID_MONTH",
    "INVALID_REQUEST_ID",
    "CELLS_ARRAY_REQUIRED",
    "CELLS_JSON_TOO_LARGE",
    "CELL_COUNT_OUT_OF_RANGE",
    "STORE_NOT_AVAILABLE",
    "ACTOR_INACTIVE",
    "LOGIN_DISABLED",
    "STORE_WRITE_DENIED",
    "SCHEDULE_NOT_DRAFT",
    "CELL_OBJECT_REQUIRED",
    "INVALID_CELL_EMPLOYEE",
    "INVALID_CELL_DATE",
    "INVALID_CELL_STAMP",
    "CELL_DATE_OUT_OF_MONTH",
    "INVALID_START_TIME",
    "INVALID_END_TIME",
    "INVALID_TIME_RANGE",
    "DUPLICATE_CELL_PAIR",
    "CELL_EMPLOYEE_NOT_ASSIGNED",
  ]);
  const httpStatus = rejectCodes.has(safeCode) ? 400 : status >= 500 ? 503 : 400;
  return new ShiftApiError(safeCode, "Shift save was rejected.", httpStatus);
}

async function saveShift(request: JsonRecord) {
  const storeId = requireText(request.storeId, "storeId");
  const year = requireNumber(request.year, "year");
  const month = requireNumber(request.month, "month");
  const cells = asRecord(request.cells);
  const actorEmployeeId = extractActorEmployeeId(request);
  const requestedStatus = normalizeScheduleStatus(request.status) || "draft";
  const staffRulesByEmployee = await loadActiveStaffRulesByEmployee(storeId);
  const existingScheduleRows = await supabaseRequest("shift_schedules", {
    select: "id,status",
    store_id: `eq.${storeId}`,
    year: `eq.${year}`,
    month: `eq.${month}`,
    limit: "1",
  });
  const existingScheduleStatus = normalizeScheduleStatus(existingScheduleRows[0]?.status);
  if (existingScheduleStatus && existingScheduleStatus !== "draft") {
    return {
      ok: false,
      error: `${scheduleStatusName(existingScheduleStatus)}のため保存できません。先に下書きに戻してください。`,
    };
  }

  const scheduleRows = await supabaseUpsert("shift_schedules", { on_conflict: "store_id,year,month" }, [{
    store_id: storeId,
    year,
    month,
    status: requestedStatus,
    source: "manual",
    metadata: {
      store_name: text(request.storeName),
      saved_from: "supabase_edge_function",
      timezone: SHIFT_DEFAULT_TIMEZONE,
    },
  }]);
  const schedule = scheduleRows[0];
  if (!schedule || !schedule.id) throw new Error("Supabase shift_schedules upsert returned no id.");

  await supabaseDelete("shift_schedule_cells", { schedule_id: `eq.${schedule.id}` });

  const cellRows = Object.keys(cells).map((key) => {
    const parsed = parseShiftCellKey(key);
    const stamp = encodeShiftStamp(cells[key]);
    if (!parsed || !stamp) return null;
    const timeFields = resolveShiftCellTimes(stamp, parsed.employeeId, staffRulesByEmployee);
    return {
      schedule_id: schedule.id,
      employee_id: parsed.employeeId,
      work_date: formatShiftDate(year, month, parsed.day),
      stamp,
      start_time: timeFields.start_time,
      end_time: timeFields.end_time,
      source: "manual",
      metadata: { ui_key: key, ui_stamp: text(cells[key]), timezone: SHIFT_DEFAULT_TIMEZONE },
    };
  }).filter(Boolean);

  if (cellRows.length) {
    await supabaseUpsert("shift_schedule_cells", { on_conflict: "schedule_id,employee_id,work_date" }, cellRows);
  }

  const auditLogged = await writeAuditLog({
    store_id: storeId,
    schedule_id: text(schedule.id),
    actor_employee_id: actorEmployeeId,
    action: "save_shift",
    target_table: "shift_schedules",
    target_id: text(schedule.id),
    metadata: {
      year,
      month,
      store_name: text(request.storeName),
      cell_count: cellRows.length,
      hub_context_present: Object.keys(asRecord(request.hubContext)).length > 0,
      saved_from: "supabase_edge_function",
    },
  });

  return {
    ok: true,
    source: "supabase-edge",
    status: text(schedule.status || requestedStatus),
    updatedAt: text(schedule.updated_at || new Date().toISOString()),
    auditLogged,
  };
}

async function loadShift(params: URLSearchParams) {
  const storeId = requireText(params.get("storeId"), "storeId");
  const year = requireNumber(params.get("year"), "year");
  const month = requireNumber(params.get("month"), "month");

  const scheduleRows = await supabaseRequest("shift_schedules", {
    select: "id,status,updated_at,confirmed_at,published_at,confirmed_by,published_by",
    store_id: `eq.${storeId}`,
    year: `eq.${year}`,
    month: `eq.${month}`,
    limit: "1",
  });
  const schedule = scheduleRows[0];
  if (!schedule || !schedule.id) {
    return { ok: true, source: "supabase-edge", cells: {}, status: "draft", updatedAt: "" };
  }

  const cellRows = await supabaseRequest("shift_schedule_cells", {
    select: "employee_id,work_date,stamp,metadata",
    schedule_id: `eq.${schedule.id}`,
    limit: "5000",
  });
  const cells: Record<string, string> = {};
  cellRows.forEach((row: JsonRecord) => {
    const day = dayFromDateString(row.work_date);
    const stamp = decodeShiftStamp(row.stamp);
    if (!row.employee_id || !day || !stamp) return;
    cells[`${row.employee_id}-${day}`] = stamp;
  });

  return {
    ok: true,
    source: "supabase-edge",
    cells,
    status: text(schedule.status || "draft"),
    updatedAt: text(schedule.updated_at),
    confirmedAt: text(schedule.confirmed_at),
    publishedAt: text(schedule.published_at),
    confirmedBy: text(schedule.confirmed_by),
    publishedBy: text(schedule.published_by),
  };
}

function normalizeScheduleStatus(value: unknown) {
  const status = text(value).trim().toLowerCase();
  return ["draft", "confirmed", "published", "archived"].includes(status) ? status : "";
}

function scheduleStatusName(status: unknown) {
  const labels: Record<string, string> = {
    draft: "下書き",
    confirmed: "店長確定済み",
    published: "公開済み",
    archived: "アーカイブ済み",
  };
  return labels[text(status)] || "確定済み";
}

async function updateScheduleStatus(request: JsonRecord) {
  const storeId = requireText(request.storeId, "storeId");
  const year = requireNumber(request.year, "year");
  const month = requireNumber(request.month, "month");
  const status = normalizeScheduleStatus(request.status);
  if (!status) throw new Error("status must be draft / confirmed / published / archived");

  const scheduleRows = await supabaseRequest("shift_schedules", {
    select: "id,status,updated_at,confirmed_at,published_at",
    store_id: `eq.${storeId}`,
    year: `eq.${year}`,
    month: `eq.${month}`,
    limit: "1",
  });
  const schedule = scheduleRows[0];
  if (!schedule || !schedule.id) {
    return {
      ok: false,
      error: "先にシフトを保存してください。保存後に確定・公開できます。",
    };
  }

  const actorEmployeeId = extractActorEmployeeId(request);
  const currentStatus = (normalizeScheduleStatus(schedule.status) || "draft") as ShiftScheduleStatus;
  const transition = evaluateShiftStatusTransition(currentStatus, status as ShiftScheduleStatus);
  if (transition.kind === "reject") {
    throw new ShiftApiError(
      transition.code || "INVALID_STATUS_TRANSITION",
      transition.message || "The requested shift status transition is not allowed.",
      transition.status || 409,
    );
  }
  if (transition.kind === "noop") {
    return {
      ok: true,
      source: "supabase-edge",
      status: currentStatus,
      unchanged: true,
      updatedAt: text(schedule.updated_at),
      confirmedAt: text(schedule.confirmed_at),
      publishedAt: text(schedule.published_at),
      auditLogged: false,
    };
  }
  if (status === "published" && !text(schedule.confirmed_at)) {
    throw new ShiftApiError("CONFIRMATION_REQUIRED", "Shift confirmation is required before publication.", 409);
  }

  const now = new Date().toISOString();
  const patch: JsonRecord = { status };
  if (status === "draft") {
    patch.confirmed_by = null;
    patch.confirmed_at = null;
    patch.published_by = null;
    patch.published_at = null;
  }
  if (status === "confirmed") {
    patch.confirmed_by = actorEmployeeId;
    patch.confirmed_at = now;
    patch.published_by = null;
    patch.published_at = null;
  }
  if (status === "published") {
    await assertScheduleCellTimesReadyForPublish(text(schedule.id));
    patch.published_by = actorEmployeeId;
    patch.published_at = now;
  }

  const casFilters = buildShiftStatusCasFilters(text(schedule.id), currentStatus, text(schedule.updated_at));
  if (!casFilters) {
    throw new ShiftApiError("CONCURRENT_STATUS_CHANGE", "Shift status changed. Reload and try again.", 409);
  }
  const updatedRows = await supabasePatch("shift_schedules", casFilters, patch);
  if (!isSingleShiftStatusUpdate(updatedRows)) {
    throw new ShiftApiError("CONCURRENT_STATUS_CHANGE", "Shift status changed. Reload and try again.", 409);
  }
  const updated = updatedRows[0] || {};
  const actionByStatus: Record<string, string> = {
    draft: "reopen_shift",
    confirmed: "confirm_shift",
    published: "publish_shift",
    archived: "archive_shift",
  };
  const auditLogged = await writeAuditLog({
    store_id: storeId,
    schedule_id: text(schedule.id),
    actor_employee_id: actorEmployeeId,
    action: actionByStatus[status] || "update_shift_status",
    target_table: "shift_schedules",
    target_id: text(schedule.id),
    metadata: {
      year,
      month,
      previous_status: text(schedule.status),
      next_status: status,
      hub_context_present: Object.keys(asRecord(request.hubContext)).length > 0,
      saved_from: "supabase_edge_function",
    },
  });

  return {
    ok: true,
    source: "supabase-edge",
    status,
    updatedAt: text(updated.updated_at || now),
    confirmedAt: text(updated.confirmed_at),
    publishedAt: text(updated.published_at),
    auditLogged,
  };
}

async function saveSettings(request: JsonRecord) {
  const storeId = requireText(request.storeId, "storeId");
  const actorEmployeeId = extractActorEmployeeId(request);
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

  const auditLogged = await writeAuditLog({
    store_id: storeId,
    actor_employee_id: actorEmployeeId,
    action: "save_settings",
    target_table: "shift_store_settings",
    target_id: text(storeRows[0]?.id) || null,
    metadata: {
      store_name: text(request.storeName),
      staff_rule_count: staffRows.length,
      min_staff: minStaff,
      hub_context_present: Object.keys(asRecord(request.hubContext)).length > 0,
      saved_from: "supabase_edge_function",
    },
  });

  return {
    ok: true,
    source: "supabase-edge",
    updatedAt: text(storeRows[0]?.updated_at || new Date().toISOString()),
    auditLogged,
  };
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
  staffRows.forEach((rule: JsonRecord) => {
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
  const actorEmployeeId = extractActorEmployeeId(request);
  const apiKey = text(request.apiKey || Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("GEMINI_API_KEY")).trim();
  if (!apiKey) {
    return {
      ok: false,
      needsApiKey: true,
      error: "AI APIキーが未設定です。画面でAPIキーを入力するか、Edge Function secretsに ANTHROPIC_API_KEY または GEMINI_API_KEY を設定してください。",
    };
  }
  const aiText = apiKey.startsWith("sk-ant-")
    ? await callAnthropic(apiKey, prompt)
    : await callGemini(apiKey, prompt);
  const result = parseAIJson(aiText);
  const generationLogged = await writeGenerationRun({
    store_id: text(request.storeId) || null,
    year: toInteger(request.year, new Date().getFullYear()),
    month: toInteger(request.month, new Date().getMonth() + 1),
    run_type: "ai_adjust",
    executed_by: actorEmployeeId,
    input_snapshot: {
      store_name: text(request.storeName),
      request_text: text(request.requestText),
      prompt_chars: prompt.length,
      provider: apiKey.startsWith("sk-ant-") ? "anthropic" : "gemini",
      hub_context_present: Object.keys(asRecord(request.hubContext)).length > 0,
    },
    result_summary: {
      summary: result.summary,
      change_count: result.changes.length,
      alert_count: result.alerts.length,
    },
    warnings: result.alerts,
  });
  return { ok: true, source: "supabase-edge", result, generationLogged };
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
  const model = text(Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest").trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
  });
  const data = await parseHttpJson(res, `Gemini API (${model})`);
  return text(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function listEmployeeIdsForStore(storeId: string) {
  const rows = await supabaseRequest("employees", {
    select: "id",
    store_id: `eq.${storeId}`,
    is_active: "eq.true",
    limit: "2000",
  });
  return new Set(rows.map((employee: JsonRecord) => text(employee.id)).filter(Boolean));
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
    return true;
  } catch (err) {
    console.warn("[shift_audit_logs] skipped:", errorMessage(err));
    return false;
  }
}

async function writeGenerationRun(entry: JsonRecord) {
  try {
    if (!entry.store_id) return false;
    await supabaseInsert("shift_generation_runs", [entry]);
    return true;
  } catch (err) {
    console.warn("[shift_generation_runs] skipped:", errorMessage(err));
    return false;
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
  if (valueText.includes("受付") || valueText.includes("レセプション") || valueText.toLowerCase().includes("reception")) return "reception_part";
  if (valueText.includes("通常")) return "regular";
  return valueText ? "custom" : "regular";
}

function decodeWorkType(value: unknown) {
  if (value === "short_time") return "時短";
  if (value === "reception_part") return "レセプション";
  return "通常";
}

async function loadActiveStaffRulesByEmployee(storeId: string) {
  const rows = await supabaseRequest("shift_staff_rules", {
    select: "employee_id,start_time,end_time",
    store_id: `eq.${storeId}`,
    is_active: "eq.true",
    limit: "2000",
  });
  const index = new Map<string, JsonRecord>();
  for (const row of rows as JsonRecord[]) {
    const employeeId = text(row.employee_id);
    if (employeeId) index.set(employeeId, row);
  }
  return index;
}

function isWorkShiftStamp(stamp: unknown) {
  return WORK_SHIFT_STAMPS.has(text(stamp));
}

function resolveShiftCellTimes(stamp: string, employeeId: string, staffRulesByEmployee: Map<string, JsonRecord>) {
  if (!isWorkShiftStamp(stamp)) {
    return { start_time: null, end_time: null };
  }
  const rule = staffRulesByEmployee.get(employeeId);
  const startTime = normalizeTimeValue(rule?.start_time);
  const endTime = normalizeTimeValue(rule?.end_time);
  if (!startTime || !endTime) {
    throw new Error(`勤務時刻が未設定です。店舗設定を保存してからシフトを保存してください。employee_id=${employeeId}`);
  }
  if (!isValidTimeRange(startTime, endTime)) {
    throw new Error(`勤務終了時刻は勤務開始時刻より後にしてください。employee_id=${employeeId}`);
  }
  return { start_time: startTime, end_time: endTime };
}

async function assertScheduleCellTimesReadyForPublish(scheduleId: string) {
  const rows = await supabaseRequest("shift_schedule_cells", {
    select: "employee_id,work_date,stamp,start_time,end_time",
    schedule_id: `eq.${scheduleId}`,
    limit: "5000",
  });
  for (const row of rows as JsonRecord[]) {
    const stamp = text(row.stamp);
    const startTime = normalizeTimeValue(row.start_time);
    const endTime = normalizeTimeValue(row.end_time);
    if (isWorkShiftStamp(stamp)) {
      if (!startTime || !endTime || !isValidTimeRange(startTime, endTime)) {
        throw new Error("勤務時刻が未設定または不正なセルがあるため公開できません。シフトを再保存してください。");
      }
    } else if (startTime || endTime) {
      throw new Error("休み系セルに勤務時刻が残っているため公開できません。シフトを再保存してください。");
    }
  }
}

function normalizeTimeValue(value: unknown) {
  const match = text(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] == null ? 0 : Number(match[3]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function isValidTimeRange(startTime: unknown, endTime: unknown) {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function timeToMinutes(value: unknown) {
  const normalized = normalizeTimeValue(value);
  if (!normalized) return NaN;
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
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

function normalizeClassText(value: unknown) {
  return text(value).replace(/[\s　/／・･_-]/g, "").toLowerCase();
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

function extractActorEmployeeId(request: JsonRecord) {
  const hubContext = asRecord(request.hubContext);
  const candidates = [
    request.actorEmployeeId,
    request.employeeId,
    request.supabaseEmployeeId,
    request.employee_id,
    request.supabase_employee_id,
    hubContext.actorEmployeeId,
    hubContext.employeeId,
    hubContext.supabaseEmployeeId,
    hubContext.employee_id,
    hubContext.supabase_employee_id,
    hubContext.coreEmployeeId,
    hubContext.core_employee_id,
  ];
  const value = candidates.map(text).find(isUuid);
  return value || null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
