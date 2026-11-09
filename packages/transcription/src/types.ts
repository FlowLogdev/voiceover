export interface TranscriptEventBase {
  segmentId: string;
  sourceTrack: string;
  startMs: number;
  endMs: number;
  text: string;
  languageCode: string;
  confidence?: number;
}

export type AsrEvent =
  | ({ type: "partial" } & TranscriptEventBase)
  | ({ type: "final" } & TranscriptEventBase)
  | { type: "language_detected"; sourceTrack: string; languageCode: string; confidence: number };

export interface AsrAudioFrame {
  sequenceNumber: number;
  startMs: number;
  endMs: number;
  sampleRate: number;
  samples: Int16Array;
}

export interface AsrSession {
  pushAudio(frame: AsrAudioFrame): void;
  onEvent(callback: (event: AsrEvent) => void): void;
  /** Flush any in-progress segment as final. Call once, when the stream ends. */
  finalize(): void;
}

/**
 * Provider-agnostic streaming ASR contract (see ARCHITECTURE.md section 5).
 * `createSession` is called once per recording track/connection; the
 * provider owns its own internal buffering/segmentation per session.
 */
export interface AsrProvider {
  readonly name: string;
  createSession(options: { sourceTrack: string }): AsrSession;
}
