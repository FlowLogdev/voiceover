import { z } from "zod";

/**
 * The notice a user must explicitly confirm before any recording starts
 * (browser capture or meeting bot). Versioned: the server rejects an
 * attestation against any version but the current one, so a stale client
 * can't record against wording the user never saw. Bump `version` whenever
 * `text` changes.
 *
 * This is a product control, not legal advice — the wording should be
 * reviewed by counsel before launch.
 */
export const RECORDING_CONSENT_NOTICE = {
  version: "2026-11-10",
  text:
    "I confirm that everyone in this meeting has been told it will be recorded and transcribed " +
    "by VoiceOver AI, and that I have obtained any consent required by law where they are " +
    "(some places require every participant to agree).",
} as const;

export const consentAttestationSchema = z.object({
  attested: z.literal(true),
  noticeVersion: z.string().min(1).max(64),
});
export type ConsentAttestation = z.infer<typeof consentAttestationSchema>;

export const sourceTrackSchema = z.enum(["remote_tab", "local_mic"]);

export const createRecordingSessionRequestSchema = z.object({
  consent: consentAttestationSchema,
  /** Browser-capture tracks to open. Defaults to the captured tab's audio only. */
  sourceTracks: z.array(sourceTrackSchema).min(1).max(2).optional(),
});
export type CreateRecordingSessionRequest = z.infer<typeof createRecordingSessionRequestSchema>;

export const recordingSessionStatusSchema = z.enum([
  "PENDING",
  "RECORDING",
  "PAUSED",
  "STOPPING",
  "FINALIZING",
  "COMPLETE",
  "FAILED",
  "CANCELED",
]);

export const recordingSessionSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  method: z.enum(["BROWSER", "BOT"]),
  status: recordingSessionStatusSchema,
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  tracks: z.array(z.object({ id: z.string().uuid(), sourceTrack: z.string() })),
});
export type RecordingSessionDTO = z.infer<typeof recordingSessionSchema>;

export const recordingConsentSchema = z.object({
  id: z.string().uuid(),
  recordingSessionId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  basis: z.literal("ORGANIZER_ATTESTATION"),
  noticeVersion: z.string().nullable(),
  grantedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type RecordingConsentDTO = z.infer<typeof recordingConsentSchema>;

export const revokeConsentResponseSchema = z.object({
  revokedConsents: z.number().int().nonnegative(),
  stoppedBrowserSessions: z.number().int().nonnegative(),
  stoppedBotSessions: z.number().int().nonnegative(),
  /** Bot sessions the provider failed to remove; their audio is still dropped server-side. */
  botLeaveFailures: z.array(z.object({ recordingSessionId: z.string(), error: z.string() })),
});
export type RevokeConsentResponse = z.infer<typeof revokeConsentResponseSchema>;
