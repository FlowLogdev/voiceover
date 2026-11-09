import { z } from "zod";

/**
 * Wire protocol for the browser-capture audio ingestion WebSocket
 * (`/recording-tracks/:trackId/audio`). JSON-framed with base64 PCM payloads —
 * simple and debuggable; revisit for a binary framing if per-chunk JSON/base64
 * overhead becomes a measured bottleneck.
 */
export const clientChunkMessageSchema = z.object({
  type: z.literal("chunk"),
  sequenceNumber: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  sourceTrack: z.string().min(1),
  sampleRate: z.number().int().positive(),
  checksum: z.string(),
  bytesBase64: z.string(),
});
export type ClientChunkMessage = z.infer<typeof clientChunkMessageSchema>;

export const clientMessageSchema = clientChunkMessageSchema;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverAckMessageSchema = z.object({
  type: z.literal("ack"),
  sequenceNumber: z.number().int().nonnegative(),
});
export type ServerAckMessage = z.infer<typeof serverAckMessageSchema>;

export const serverErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});
export type ServerErrorMessage = z.infer<typeof serverErrorMessageSchema>;

const transcriptEventFieldsSchema = {
  segmentId: z.string(),
  sourceTrack: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
  languageCode: z.string(),
};

export const serverTranscriptPartialMessageSchema = z.object({
  type: z.literal("transcript.partial"),
  ...transcriptEventFieldsSchema,
});
export type ServerTranscriptPartialMessage = z.infer<typeof serverTranscriptPartialMessageSchema>;

export const serverTranscriptFinalMessageSchema = z.object({
  type: z.literal("transcript.final"),
  ...transcriptEventFieldsSchema,
});
export type ServerTranscriptFinalMessage = z.infer<typeof serverTranscriptFinalMessageSchema>;

export const serverLanguageDetectedMessageSchema = z.object({
  type: z.literal("language.detected"),
  sourceTrack: z.string(),
  languageCode: z.string(),
  confidence: z.number(),
});
export type ServerLanguageDetectedMessage = z.infer<typeof serverLanguageDetectedMessageSchema>;

export type ServerMessage =
  | ServerAckMessage
  | ServerErrorMessage
  | ServerTranscriptPartialMessage
  | ServerTranscriptFinalMessage
  | ServerLanguageDetectedMessage;
