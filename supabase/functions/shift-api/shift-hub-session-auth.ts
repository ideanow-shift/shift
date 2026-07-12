type Query = Record<string, string | number | boolean | undefined | null>;
type JsonRecord = Record<string, unknown>;

export type SupabaseRequest = (resource: string, query?: Query) => Promise<JsonRecord[]>;

export type ShiftAuthContext = {
  employeeId: string;
  authType: "hub_session";
  employee: JsonRecord;
  roles: ShiftRoleAssignment[];
};

type ShiftRoleAssignment = {
  roleKey: string;
  scopeType: string;
  scopeId: string;
};

const HUB_APP_SESSION_SIGNING_SECRET = Deno.env.get("HUB_APP_SESSION_SIGNING_SECRET") || "";
const HUB_SESSION_AUDIENCE = "nov_hub";
const SHIFT_READ_ACTIONS = new Set(["loadMasters", "loadShift", "loadSettings"]);
const SHIFT_WRITE_ACTIONS = new Set(["saveShift", "saveSettings", "updateScheduleStatus", "aiAdjust"]);
const SHIFT_GLOBAL_READ_ROLES = new Set(["super_admin", "backoffice", "executive"]);
const SHIFT_GLOBAL_WRITE_ROLES = new Set(["super_admin", "backoffice"]);
const SHIFT_SCOPED_READ_ROLES = new Set(["area_manager", "store_manager", "fc_owner"]);
const SHIFT_SCOPED_WRITE_ROLES = new Set(["area_manager", "store_manager", "fc_owner"]);

export class ShiftApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ShiftApiError";
    this.code = code;
    this.status = status;
  }
}

export async function authenticateShiftRequest(req: Request, supabaseRequest: SupabaseRequest): Promise<ShiftAuthContext> {
  const token = extractBearerToken(req);
  if (!token) throw new ShiftApiError("AUTH_REQUIRED", "Authentication is required.", 401);
  const session = await verifyHubAppSession(token);
  const employee = await getShiftAuthEmployee(session.employeeId, supabaseRequest);
  if (!isEmployeeActive(employee)) throw new ShiftApiError("ACCESS_DENIED", "Employee is not active.", 403);
  await assertShiftLoginEnabled(session.employeeId, supabaseRequest);
  const roles = await getShiftRoleAssignments(session.employeeId, supabaseRequest);
  return { employeeId: session.employeeId, authType: "hub_session", employee, roles };
}

export async function authorizeShiftAction(auth: ShiftAuthContext, method: "GET" | "POST", action: string, storeIdValue: unknown) {
  const actionSet = method === "GET" ? SHIFT_READ_ACTIONS : SHIFT_WRITE_ACTIONS;
  if (!actionSet.has(action)) throw new ShiftApiError("INVALID_ACTION", "Action is not supported.", 400);

  if (method === "GET" && action === "loadMasters") {
    if (auth.roles.some((role) => SHIFT_GLOBAL_READ_ROLES.has(role.roleKey))) return;
    throw new ShiftApiError("ACCESS_DENIED", "Full master read requires a global read role.", 403);
  }

  const storeId = text(storeIdValue).trim();
  if (!storeId) throw new ShiftApiError("INVALID_REQUEST", "storeId is required.", 400);

  if (method === "GET" && canAccessScopedStore(auth, storeId, SHIFT_SCOPED_READ_ROLES, SHIFT_GLOBAL_READ_ROLES)) return;
  if (method === "POST" && canAccessScopedStore(auth, storeId, SHIFT_SCOPED_WRITE_ROLES, SHIFT_GLOBAL_WRITE_ROLES)) return;

  throw new ShiftApiError("ACCESS_DENIED", "This role cannot access the requested store.", 403);
}

export function applyVerifiedActor(body: JsonRecord, auth: ShiftAuthContext) {
  body.actorEmployeeId = auth.employeeId;
}

function canAccessScopedStore(auth: ShiftAuthContext, storeId: string, scopedRoles: Set<string>, globalRoles: Set<string>) {
  if (auth.roles.some((role) => globalRoles.has(role.roleKey))) return true;
  return auth.roles.some((role) => {
    if (!scopedRoles.has(role.roleKey)) return false;
    return ["store", "stores", "shop"].includes(role.scopeType) && role.scopeId === storeId;
  });
}

function extractBearerToken(req: Request) {
  const header = req.headers.get("Authorization") || req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function verifyHubAppSession(token: string) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new ShiftApiError("TOKEN_VERIFICATION_FAILED", "Session token is invalid.", 401);
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    await importHubAppSessionSigningKey(),
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!signatureValid) throw new ShiftApiError("TOKEN_VERIFICATION_FAILED", "Session token is invalid.", 401);
  const payload = decodeJsonBase64Url(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (String(payload.aud || "") !== HUB_SESSION_AUDIENCE) throw new ShiftApiError("TOKEN_AUDIENCE_INVALID", "Session audience is invalid.", 401);
  if (!isUuid(String(payload.sub || "")) || Number(payload.exp || 0) <= now || Number(payload.iat || 0) > now + 30) {
    throw new ShiftApiError("TOKEN_VERIFICATION_FAILED", "Session token has expired or is invalid.", 401);
  }
  return { employeeId: String(payload.sub || "") };
}

async function importHubAppSessionSigningKey() {
  const signingSecret = HUB_APP_SESSION_SIGNING_SECRET.trim();
  if (signingSecret.length < 32) throw new ShiftApiError("SETUP_MISSING", "Hub session signing is not configured.", 500);
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function decodeJsonBase64Url(value: string): JsonRecord {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
  } catch (_err) {
    throw new ShiftApiError("TOKEN_VERIFICATION_FAILED", "Session token is invalid.", 401);
  }
}

function base64UrlToBytes(value: string) {
  try {
    const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch (_err) {
    throw new ShiftApiError("TOKEN_VERIFICATION_FAILED", "Session token is invalid.", 401);
  }
}

async function getShiftAuthEmployee(employeeId: string, supabaseRequest: SupabaseRequest) {
  const rows = await supabaseRequest("employees", {
    select: "id,employee_id,full_name,employment_status,employment_type,store_id,position_id,job_type_id,is_active,retired_on",
    id: `eq.${employeeId}`,
    limit: "1",
  });
  return rows[0] || {};
}

function isEmployeeActive(employee: JsonRecord | null) {
  if (!employee || employee.is_active === false) return false;
  if (isPastOrTodayDate(employee.retired_on)) return false;
  const status = text(employee.employment_status).trim().toLowerCase();
  const inactiveStatuses = new Set([
    "retired",
    "inactive",
    "leave",
    "suspended",
    "\u9000\u8077",
    "\u4f11\u8077",
    "\u7523\u4f11",
    "\u80b2\u4f11",
    "\u7523\u4f11\u30fb\u80b2\u4f11",
  ]);
  return ![...inactiveStatuses].some((inactiveStatus) => status.includes(inactiveStatus));
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

async function assertShiftLoginEnabled(employeeId: string, supabaseRequest: SupabaseRequest) {
  const rows = await supabaseRequest("employee_login_credentials", {
    select: "id,employee_id,login_enabled",
    employee_id: `eq.${employeeId}`,
    limit: "1",
  });
  const credential = rows[0] || null;
  if (!credential || credential.login_enabled === false) throw new ShiftApiError("ACCESS_DENIED", "Login is disabled.", 403);
}

async function getShiftRoleAssignments(employeeId: string, supabaseRequest: SupabaseRequest): Promise<ShiftRoleAssignment[]> {
  const employeeRoles = await supabaseRequest("employee_roles", {
    select: "role_id,scope_type,scope_id,is_active",
    employee_id: `eq.${employeeId}`,
    is_active: "eq.true",
    limit: "100",
  });
  const roleIds = [...new Set(employeeRoles.map((row) => text(row.role_id)).filter(Boolean))];
  if (!roleIds.length) return [];
  const roles = await supabaseRequest("roles", {
    select: "id,role_key,role_name,is_active",
    id: `in.(${roleIds.join(",")})`,
    is_active: "eq.true",
    limit: "100",
  });
  const rolesById = new Map(roles.filter((role) => role.is_active === true).map((role) => [text(role.id), role]));
  return employeeRoles
    .map((row) => {
      const role = rolesById.get(text(row.role_id)) || {};
      return {
        roleKey: text(role.role_key).trim(),
        scopeType: text(row.scope_type).trim().toLowerCase(),
        scopeId: text(row.scope_id).trim(),
      };
    })
    .filter((role) => role.roleKey);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function text(value: unknown) {
  return value == null ? "" : String(value);
}
