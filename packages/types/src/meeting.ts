import { z } from "zod";

export const recordingMethodSchema = z.enum(["BROWSER", "BOT"]);

export const createMeetingRequestSchema = z.object({
  title: z.string().min(1).max(500),
  platform: z.enum(["google_meet", "teams", "zoom", "other"]).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  recordingMethod: recordingMethodSchema.optional(),
});
export type CreateMeetingRequest = z.infer<typeof createMeetingRequestSchema>;

export const meetingSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  platform: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  recordingMethod: recordingMethodSchema.nullable(),
});
export type MeetingSummaryDTO = z.infer<typeof meetingSummarySchema>;
