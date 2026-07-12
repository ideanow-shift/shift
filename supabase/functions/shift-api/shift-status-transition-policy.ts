export type ShiftScheduleStatus = "draft" | "confirmed" | "published" | "archived";

export type ShiftStatusTransitionDecision = {
  kind: "transition" | "noop" | "reject";
  code?: string;
  message?: string;
  status?: number;
};

const ALLOWED_TRANSITIONS = new Set([
  "draft:confirmed",
  "confirmed:draft",
  "confirmed:published",
  "published:archived",
]);

export function evaluateShiftStatusTransition(currentStatus: ShiftScheduleStatus, nextStatus: ShiftScheduleStatus): ShiftStatusTransitionDecision {
  if (currentStatus === nextStatus) return { kind: "noop" };

  const transitionKey = `${currentStatus}:${nextStatus}`;
  if (ALLOWED_TRANSITIONS.has(transitionKey)) return { kind: "transition" };

  if (transitionKey === "published:draft") {
    return {
      kind: "reject",
      code: "PUBLISHED_REOPEN_REQUIRES_RPC",
      message: "Published shift reopen requires the approved transactional RPC.",
      status: 409,
    };
  }

  return {
    kind: "reject",
    code: "INVALID_STATUS_TRANSITION",
    message: "The requested shift status transition is not allowed.",
    status: 409,
  };
}

export function buildShiftStatusCasFilters(id: string, currentStatus: ShiftScheduleStatus, updatedAt: string) {
  if (!id || !updatedAt) return null;
  return {
    id: `eq.${id}`,
    status: `eq.${currentStatus}`,
    updated_at: `eq.${updatedAt}`,
  };
}

export function isSingleShiftStatusUpdate(rows: unknown[]) {
  return rows.length === 1;
}
