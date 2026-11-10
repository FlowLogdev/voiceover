/**
 * Mirrors the `BotJoinStatus` Prisma enum. Kept as a plain string union here
 * so this package stays free of any database dependency.
 */
export type BotStatus =
  | "SCHEDULED"
  | "JOINING"
  | "WAITING_ROOM"
  | "IN_CALL"
  | "ADMISSION_REJECTED"
  | "LEFT"
  | "FAILED";

export const TERMINAL_BOT_STATUSES: ReadonlySet<BotStatus> = new Set(["ADMISSION_REJECTED", "LEFT", "FAILED"]);

export function isTerminalBotStatus(status: BotStatus): boolean {
  return TERMINAL_BOT_STATUSES.has(status);
}

/**
 * Allowed forward transitions. Anything not listed is rejected, which is what
 * lets the session manager safely ignore out-of-order or duplicated provider
 * webhooks (e.g. a late "joining" arriving after "in_call") instead of
 * regressing the visible status.
 *
 * ADMISSION_REJECTED / FAILED are only terminal once the retry policy gives
 * up; while a retry is pending the session goes back to SCHEDULED instead of
 * passing through them, so they have no outgoing edges.
 */
const ALLOWED_TRANSITIONS: Record<BotStatus, readonly BotStatus[]> = {
  SCHEDULED: ["JOINING", "LEFT", "FAILED"],
  JOINING: ["WAITING_ROOM", "IN_CALL", "SCHEDULED", "ADMISSION_REJECTED", "LEFT", "FAILED"],
  WAITING_ROOM: ["IN_CALL", "SCHEDULED", "ADMISSION_REJECTED", "LEFT", "FAILED"],
  IN_CALL: ["LEFT", "FAILED"],
  ADMISSION_REJECTED: [],
  LEFT: [],
  FAILED: [],
};

export function canTransition(from: BotStatus, to: BotStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
