import { canTransition, isTerminalBotStatus, type BotStatus } from "./lifecycle.js";
import { AdmissionRetryPolicy } from "./retry-policy.js";
import {
  BOT_RECORDING_ANNOUNCEMENT,
  systemTimers,
  type BotAudioFrame,
  type BotAudioSink,
  type BotProviderEvent,
  type BotSessionPatch,
  type BotSessionRecord,
  type BotSessionRepository,
  type MeetingBotProvider,
  type Timers,
} from "./types.js";

/**
 * setTimeout's delay is a signed 32-bit int: anything above ~24.8 days
 * overflows and fires *immediately*. Long waits are chained in steps of at
 * most this size, re-checking the remaining delay each time.
 */
export const MAX_TIMER_STEP_MS = 2_147_483_647;

/**
 * Providers can deliver the first audio frames before (or in the same tick
 * as) the in_call status event, which is applied asynchronously. Frames that
 * arrive for a session that isn't live yet are held here, bounded, and
 * replayed in order once it goes live (or dropped if it never does).
 */
export const MAX_PRE_LIVE_FRAMES_PER_SESSION = 100;
const MAX_PRE_LIVE_SESSIONS = 1_000;

export interface BotStatusChange {
  previous: BotStatus;
  session: BotSessionRecord;
}

export interface BotSessionManagerOptions {
  provider: MeetingBotProvider;
  repository: BotSessionRepository;
  audioSink: BotAudioSink;
  timers?: Timers;
  retryPolicy?: AdmissionRetryPolicy;
  /** Disclosure passed to every join; defaults to BOT_RECORDING_ANNOUNCEMENT. */
  recordingNotice?: string;
  /** Fired after every persisted status change (audit log, live UI, metrics). Errors are logged, not rethrown. */
  onStatusChange?: (change: BotStatusChange) => void | Promise<void>;
  logError?: (error: unknown, message: string) => void;
}

export type ProviderEventOutcome =
  | { applied: true; status: BotStatus }
  | { applied: false; reason: string };

export class BotLeaveError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "BotLeaveError";
  }
}

interface LiveSession {
  providerBotId: string;
  record: BotSessionRecord;
  /** Serialises audio pushes + end-of-stream so ordering is preserved. */
  audioChain: Promise<void>;
}

/**
 * Owns bot session lifecycle independent of which provider is plugged in:
 * scheduled join, admission-failure retry with backoff, leave-on-request,
 * and routing in-call audio into the shared ingestion pipeline.
 *
 * All mutations of a given session (timer firing, provider events, leave
 * requests) are serialised through a per-session lock, so e.g. a provider
 * event that arrives while `joinMeeting()` is still awaiting is applied after
 * the provider bot id has been persisted, never racing it.
 */
export class BotSessionManager {
  private readonly provider: MeetingBotProvider;
  private readonly repository: BotSessionRepository;
  private readonly audioSink: BotAudioSink;
  private readonly timers: Timers;
  private readonly retryPolicy: AdmissionRetryPolicy;
  private readonly recordingNotice: string;
  private readonly onStatusChange?: BotSessionManagerOptions["onStatusChange"];
  private readonly logError: (error: unknown, message: string) => void;

  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly joinTimers = new Map<string, unknown>();
  private readonly live = new Map<string, LiveSession>();
  private readonly preLive = new Map<string, { providerBotId: string; frames: BotAudioFrame[] }>();
  private stopped = false;

  constructor(options: BotSessionManagerOptions) {
    this.provider = options.provider;
    this.repository = options.repository;
    this.audioSink = options.audioSink;
    this.timers = options.timers ?? systemTimers;
    this.retryPolicy = options.retryPolicy ?? new AdmissionRetryPolicy();
    this.recordingNotice = options.recordingNotice ?? BOT_RECORDING_ANNOUNCEMENT;
    this.onStatusChange = options.onStatusChange;
    this.logError = options.logError ?? ((error, message) => console.error(message, error));

    this.provider.setEventSink({
      onEvent: (sessionId, providerBotId, event) => {
        this.handleProviderEvent(sessionId, providerBotId, event).catch((error) =>
          this.logError(error, `Failed to apply bot event ${event.type} for session ${sessionId}`),
        );
      },
      onAudio: (sessionId, providerBotId, frame) => this.handleProviderAudio(sessionId, providerBotId, frame),
    });
  }

  /** Arms a freshly-created SCHEDULED session: joins now, or at `scheduledJoinAt`. */
  start(sessionId: string): Promise<BotSessionRecord | null> {
    return this.withLock(sessionId, async () => {
      const session = await this.repository.get(sessionId);
      if (!session || session.status !== "SCHEDULED") return session;
      return this.joinNowOrArm(session);
    });
  }

  /**
   * Leave-on-request. Idempotent: leaving an already-terminal session is a
   * no-op that returns it unchanged. If the provider call fails the session
   * keeps its current status (the bot may well still be in the call) and a
   * BotLeaveError is thrown so the caller can surface it and retry.
   */
  leave(sessionId: string): Promise<BotSessionRecord | null> {
    return this.withLock(sessionId, async () => {
      const session = await this.repository.get(sessionId);
      if (!session || isTerminalBotStatus(session.status)) return session;

      this.clearJoinTimer(sessionId);
      if (session.status !== "SCHEDULED" && session.providerBotId) {
        try {
          await this.provider.leaveMeeting(session.providerBotId);
        } catch (error) {
          throw new BotLeaveError("Meeting bot provider failed to remove the bot", error);
        }
      }
      return this.finish(session, "LEFT", { failureReason: null });
    });
  }

  /**
   * Re-arms in-memory state after a process restart: timers for SCHEDULED
   * sessions (a missed join time joins immediately), the audio route for
   * IN_CALL sessions, and a retry for any session that crashed mid-dispatch
   * (JOINING with no provider bot id — the provider call never returned).
   */
  async restore(): Promise<void> {
    const sessions = await this.repository.listNonTerminal();
    await Promise.all(
      sessions.map((session) =>
        this.withLock(session.id, async () => {
          const current = await this.repository.get(session.id);
          if (!current) return;
          if (current.status === "SCHEDULED") {
            await this.joinNowOrArm(current);
          } else if (current.status === "IN_CALL" && current.providerBotId) {
            this.markLive(current);
          } else if (current.status === "JOINING" && !current.providerBotId) {
            await this.handleJoinFailure(current, "Interrupted while dispatching bot", true, "FAILED");
          }
        }),
      ),
    );
  }

  /** Cancels pending join timers. Does not touch persisted state or live bots. */
  shutdown(): void {
    this.stopped = true;
    for (const handle of this.joinTimers.values()) this.timers.clearTimeout(handle);
    this.joinTimers.clear();
  }

  handleProviderEvent(sessionId: string, providerBotId: string, event: BotProviderEvent): Promise<ProviderEventOutcome> {
    return this.withLock(sessionId, async (): Promise<ProviderEventOutcome> => {
      const session = await this.repository.get(sessionId);
      if (!session) return { applied: false, reason: "unknown session" };
      if (session.providerBotId !== providerBotId) {
        return { applied: false, reason: "event from a superseded or unknown provider bot" };
      }
      if (isTerminalBotStatus(session.status)) return { applied: false, reason: `session already ${session.status}` };

      const preJoin = session.status === "JOINING" || session.status === "WAITING_ROOM";
      let updated: BotSessionRecord | null = null;

      switch (event.type) {
        case "joining":
          // Status is set to JOINING when we dispatch; the provider echoing it is a no-op.
          return { applied: false, reason: "already joining or past it" };
        case "waiting_room":
          if (canTransition(session.status, "WAITING_ROOM")) updated = await this.transition(session, "WAITING_ROOM", {});
          break;
        case "in_call":
          if (canTransition(session.status, "IN_CALL")) {
            updated = await this.transition(session, "IN_CALL", {
              startedAt: session.startedAt ?? new Date(this.timers.now()),
              failureReason: null,
            });
            this.markLive(updated);
          }
          break;
        case "admission_rejected":
          if (preJoin) updated = await this.handleJoinFailure(session, event.reason, true, "ADMISSION_REJECTED");
          break;
        case "join_failed":
          if (preJoin) updated = await this.handleJoinFailure(session, event.reason, event.retryable, "FAILED");
          break;
        case "left":
          updated = await this.finish(session, "LEFT", {
            failureReason: event.reason === "requested" ? null : `Bot left: ${event.reason}`,
          });
          break;
        case "fatal":
          updated = await this.finish(session, "FAILED", { failureReason: event.reason });
          break;
      }

      return updated
        ? { applied: true, status: updated.status }
        : { applied: false, reason: `${event.type} not valid from ${session.status}` };
    });
  }

  handleProviderAudio(sessionId: string, providerBotId: string, frame: BotAudioFrame): void {
    const live = this.live.get(sessionId);
    if (live) {
      if (live.providerBotId === providerBotId) this.enqueueAudio(live, frame);
      return;
    }
    let buffered = this.preLive.get(sessionId);
    if (!buffered || buffered.providerBotId !== providerBotId) {
      if (!buffered && this.preLive.size >= MAX_PRE_LIVE_SESSIONS) return;
      buffered = { providerBotId, frames: [] };
      this.preLive.set(sessionId, buffered);
    }
    buffered.frames.push(frame);
    if (buffered.frames.length > MAX_PRE_LIVE_FRAMES_PER_SESSION) buffered.frames.shift();
  }

  private enqueueAudio(live: LiveSession, frame: BotAudioFrame): void {
    live.audioChain = live.audioChain
      .then(() => this.audioSink.pushAudio(live.record, frame))
      .catch((error) => this.logError(error, `Failed to ingest bot audio for session ${live.record.id}`));
  }

  /** Test/diagnostic hook: resolves once every queued operation for the session has run. */
  async idle(sessionId: string): Promise<void> {
    while (this.locks.has(sessionId)) await this.locks.get(sessionId);
    await this.live.get(sessionId)?.audioChain;
  }

  // -------------------------------------------------------------------------

  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(sessionId, tail);
    void tail.then(() => {
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    });
    return result;
  }

  private async joinNowOrArm(session: BotSessionRecord): Promise<BotSessionRecord> {
    const joinAt = session.scheduledJoinAt?.getTime() ?? this.timers.now();
    const delay = joinAt - this.timers.now();
    if (delay <= 0) return this.dispatchJoin(session);
    this.armJoinTimer(session.id, delay);
    return session;
  }

  private armJoinTimer(sessionId: string, delayMs: number): void {
    if (this.stopped) return;
    this.clearJoinTimer(sessionId);
    const handle = this.timers.setTimeout(() => {
      this.joinTimers.delete(sessionId);
      this.withLock(sessionId, async () => {
        const session = await this.repository.get(sessionId);
        // Re-evaluates the remaining delay, which also continues a chained long wait.
        if (session?.status === "SCHEDULED") await this.joinNowOrArm(session);
      }).catch((error) => this.logError(error, `Scheduled join failed for session ${sessionId}`));
    }, Math.min(delayMs, MAX_TIMER_STEP_MS));
    this.joinTimers.set(sessionId, handle);
  }

  private clearJoinTimer(sessionId: string): void {
    const handle = this.joinTimers.get(sessionId);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.joinTimers.delete(sessionId);
    }
  }

  private async dispatchJoin(session: BotSessionRecord): Promise<BotSessionRecord> {
    const joining = await this.transition(session, "JOINING", {
      joinAttempts: session.joinAttempts + 1,
      scheduledJoinAt: null,
      providerBotId: null,
    });
    try {
      const { providerBotId } = await this.provider.joinMeeting({
        sessionId: joining.id,
        meetingUrl: joining.meetingUrl,
        platform: joining.platform,
        botName: joining.botName,
        recordingNotice: this.recordingNotice,
      });
      return await this.repository.update(joining.id, { providerBotId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.handleJoinFailure(joining, `Provider failed to dispatch bot: ${message}`, true, "FAILED");
    }
  }

  private async handleJoinFailure(
    session: BotSessionRecord,
    reason: string,
    retryable: boolean,
    terminalStatus: "ADMISSION_REJECTED" | "FAILED",
  ): Promise<BotSessionRecord> {
    if (retryable && this.retryPolicy.shouldRetry(session.joinAttempts)) {
      const delay = this.retryPolicy.delayBeforeNextAttemptMs(session.joinAttempts);
      this.preLive.delete(session.id);
      const rescheduled = await this.transition(session, "SCHEDULED", {
        scheduledJoinAt: new Date(this.timers.now() + delay),
        providerBotId: null,
        failureReason: `Attempt ${session.joinAttempts} failed: ${reason}; retrying`,
      });
      this.armJoinTimer(rescheduled.id, delay);
      return rescheduled;
    }
    const suffix = retryable ? ` (gave up after ${session.joinAttempts} attempt(s))` : "";
    return this.finish(session, terminalStatus, { failureReason: `${reason}${suffix}` });
  }

  /** Moves to a terminal status and flushes the transcript if the bot was ever in the call. */
  private async finish(
    session: BotSessionRecord,
    status: "LEFT" | "FAILED" | "ADMISSION_REJECTED",
    patch: BotSessionPatch,
  ): Promise<BotSessionRecord> {
    this.clearJoinTimer(session.id);
    this.preLive.delete(session.id);
    const ended = await this.transition(session, status, { ...patch, endedAt: new Date(this.timers.now()) });
    const live = this.live.get(session.id);
    this.live.delete(session.id);
    if (live) {
      live.audioChain = live.audioChain
        .then(() => this.audioSink.endOfStream(ended))
        .catch((error) => this.logError(error, `Failed to finalise bot audio for session ${session.id}`));
      await live.audioChain;
    }
    return ended;
  }

  private async transition(
    session: BotSessionRecord,
    to: BotStatus,
    patch: BotSessionPatch,
  ): Promise<BotSessionRecord> {
    if (!canTransition(session.status, to)) {
      throw new Error(`Illegal bot status transition ${session.status} -> ${to} for session ${session.id}`);
    }
    const updated = await this.repository.update(session.id, { ...patch, status: to });
    if (this.onStatusChange) {
      try {
        await this.onStatusChange({ previous: session.status, session: updated });
      } catch (error) {
        this.logError(error, `onStatusChange hook failed for session ${session.id}`);
      }
    }
    return updated;
  }

  private markLive(session: BotSessionRecord): void {
    if (!session.providerBotId) return;
    const existing = this.live.get(session.id);
    const live: LiveSession = {
      providerBotId: session.providerBotId,
      record: session,
      audioChain: existing?.audioChain ?? Promise.resolve(),
    };
    this.live.set(session.id, live);
    const buffered = this.preLive.get(session.id);
    this.preLive.delete(session.id);
    if (buffered?.providerBotId === session.providerBotId) {
      for (const frame of buffered.frames) this.enqueueAudio(live, frame);
    }
  }
}
