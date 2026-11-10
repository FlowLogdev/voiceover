import { z } from "zod";

export const botStatusSchema = z.enum([
  "SCHEDULED",
  "JOINING",
  "WAITING_ROOM",
  "IN_CALL",
  "ADMISSION_REJECTED",
  "LEFT",
  "FAILED",
]);
export type BotStatusDTO = z.infer<typeof botStatusSchema>;

export const createBotSessionRequestSchema = z.object({
  meetingUrl: z.string().min(1).max(2048),
  botName: z.string().trim().min(1).max(100).optional(),
  /** Omit to join now. */
  joinAt: z.string().datetime().optional(),
});
export type CreateBotSessionRequest = z.infer<typeof createBotSessionRequestSchema>;

export const botSessionSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  recordingTrackId: z.string().uuid(),
  provider: z.string(),
  platform: z.enum(["zoom", "google_meet", "teams"]),
  meetingUrl: z.string(),
  botName: z.string(),
  status: botStatusSchema,
  scheduledJoinAt: z.string().datetime().nullable(),
  joinAttempts: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  failureReason: z.string().nullable(),
});
export type BotSessionDTO = z.infer<typeof botSessionSchema>;
