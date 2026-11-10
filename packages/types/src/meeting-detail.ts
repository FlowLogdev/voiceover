import { z } from "zod";
import { recordingSessionStatusSchema } from "./recording-consent.js";

export const speakerSchema = z.object({
  id: z.string().uuid(),
  /** Default label: "Speaker N" from diarization, or the capture source ("Microphone", "Tab audio", "Meeting audio"). */
  label: z.string(),
  /** User-assigned name, if renamed. */
  displayName: z.string().nullable(),
  /** "diarization" = from the ASR provider; "source" = one speaker per capture track (not real diarization). */
  attribution: z.enum(["diarization", "source"]),
});
export type SpeakerDTO = z.infer<typeof speakerSchema>;

export const meetingTrackSchema = z.object({
  id: z.string().uuid(),
  recordingSessionId: z.string().uuid(),
  method: z.enum(["BROWSER", "BOT"]),
  sourceTrack: z.string(),
  sessionStatus: recordingSessionStatusSchema,
  durationMs: z.number().int().nullable(),
  missingChunkCount: z.number().int().nullable(),
  /** True once the finalization job has assembled a playable file. */
  playbackAvailable: z.boolean(),
  failureReason: z.string().nullable(),
});
export type MeetingTrackDTO = z.infer<typeof meetingTrackSchema>;

export const meetingDetailSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  platform: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  recordingMethod: z.enum(["BROWSER", "BOT"]).nullable(),
  speakers: z.array(speakerSchema),
  tracks: z.array(meetingTrackSchema),
});
export type MeetingDetailDTO = z.infer<typeof meetingDetailSchema>;

export const transcriptSegmentSchema = z.object({
  id: z.string().uuid(),
  recordingTrackId: z.string().uuid().nullable(),
  sourceTrack: z.string(),
  speakerId: z.string().uuid().nullable(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  text: z.string(),
  languageCode: z.string(),
  provider: z.string(),
});
export type TranscriptSegmentDTO = z.infer<typeof transcriptSegmentSchema>;

export const meetingTranscriptSchema = z.object({
  segments: z.array(transcriptSegmentSchema),
  /** Contiguous language runs, computed when a recording is finalized. */
  languages: z.array(z.object({ languageCode: z.string(), startMs: z.number().int(), endMs: z.number().int() })),
});
export type MeetingTranscriptDTO = z.infer<typeof meetingTranscriptSchema>;

export const renameSpeakerRequestSchema = z.object({
  /** null clears the rename and falls back to the default label. */
  displayName: z.string().trim().min(1).max(100).nullable(),
});
export type RenameSpeakerRequest = z.infer<typeof renameSpeakerRequestSchema>;
