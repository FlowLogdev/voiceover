export type CaptureState = "idle" | "starting" | "recording" | "paused" | "stopping" | "error";

export interface TranscriptLine {
  segmentId: string;
  text: string;
  languageCode: string;
  isFinal: boolean;
}

export interface CaptureStatus {
  state: CaptureState;
  startedAt: number | null;
  error?: string;
  transcriptLines: TranscriptLine[];
}

// popup -> background
export type PopupRequest =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "get-status" };

export type PopupResponse = CaptureStatus;

// background -> offscreen
export type OffscreenCommand =
  | { type: "init-capture"; streamId: string; recordingTrackId: string; wsUrl: string }
  | { type: "pause-capture" }
  | { type: "resume-capture" }
  | { type: "stop-capture" };

// offscreen -> background
export type OffscreenEvent =
  | { type: "offscreen-status"; status: Omit<CaptureStatus, "transcriptLines"> }
  | { type: "transcript-line"; line: TranscriptLine };

export const API_BASE_URL = "http://localhost:4000";
export const WS_BASE_URL = "ws://localhost:4000";
