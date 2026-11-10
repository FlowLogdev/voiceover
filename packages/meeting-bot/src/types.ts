import type { BotStatus } from "./lifecycle.js";
import type { MeetingPlatform } from "./meeting-url.js";

export type BotLeaveReason = "requested" | "meeting_ended" | "removed_by_host" | "provider_ended";

/**
 * Normalised bot lifecycle events. Each provider adapter maps its own
 * webhook/status vocabulary onto these (e.g. Recall-style
 * `in_waiting_room` -> `waiting_room`).
 */
export type BotProviderEvent =
  | { type: "joining" }
  | { type: "waiting_room" }
  | { type: "in_call" }
  /** Host denied entry, or the waiting room timed out. Retryable by policy. */
  | { type: "admission_rejected"; reason: string }
  /** Bot could not get into the call. `retryable` e.g. "meeting not started yet". */
  | { type: "join_failed"; reason: string; retryable: boolean }
  | { type: "left"; reason: BotLeaveReason }
  /** Unrecoverable provider-side error at any point. */
  | { type: "fatal"; reason: string };

export interface BotAudioFrame {
  sequenceNumber: number;
  startMs: number;
  endMs: number;
  sampleRate: number;
  /** Mixed meeting audio, PCM16 mono. */
  samples: Int16Array;
}

/**
 * Every callback carries our own `sessionId` (providers must echo it back —
 * real ones support attaching metadata to a bot) as well as the
 * provider's bot id. The session id is the lookup key, so an event that
 * arrives before `joinMeeting()` has even resolved still finds its session;
 * the provider bot id is used to drop late events from a superseded
 * (retried) bot.
 */
export interface BotEventSink {
  onEvent(sessionId: string, providerBotId: string, event: BotProviderEvent): void;
  onAudio(sessionId: string, providerBotId: string, frame: BotAudioFrame): void;
}

export interface JoinMeetingRequest {
  sessionId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
  botName: string;
}

/**
 * Provider-agnostic meeting bot contract (ARCHITECTURE.md section 3/5). The
 * provider dispatches a bot immediately on `joinMeeting` — scheduling and
 * retries are owned by `BotSessionManager`, not delegated to the provider, so
 * they behave identically whichever provider is plugged in.
 */
export interface MeetingBotProvider {
  readonly name: string;
  setEventSink(sink: BotEventSink): void;
  joinMeeting(request: JoinMeetingRequest): Promise<{ providerBotId: string }>;
  leaveMeeting(providerBotId: string): Promise<void>;
}

export interface BotSessionRecord {
  id: string;
  /** The ingestion track this bot's audio is written to (sourceTrack "bot_mixed"). */
  recordingTrackId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
  botName: string;
  status: BotStatus;
  providerBotId: string | null;
  scheduledJoinAt: Date | null;
  joinAttempts: number;
  /** Set once the bot first reaches IN_CALL. */
  startedAt: Date | null;
  endedAt: Date | null;
  failureReason: string | null;
}

export type BotSessionPatch = Partial<Omit<BotSessionRecord, "id" | "recordingTrackId">>;

export interface BotSessionRepository {
  get(id: string): Promise<BotSessionRecord | null>;
  update(id: string, patch: BotSessionPatch): Promise<BotSessionRecord>;
  /** Sessions not yet in a terminal status — used to re-arm timers after a restart. */
  listNonTerminal(): Promise<BotSessionRecord[]>;
}

/** Where a bot's audio goes: the same ingestion pipeline browser capture uses. */
export interface BotAudioSink {
  pushAudio(session: BotSessionRecord, frame: BotAudioFrame): void | Promise<void>;
  /** The bot has left/failed for good — flush any open transcript segment. */
  endOfStream(session: BotSessionRecord): void | Promise<void>;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const systemTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};
