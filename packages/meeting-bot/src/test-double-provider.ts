import { randomUUID } from "node:crypto";
import {
  systemTimers,
  type BotEventSink,
  type JoinMeetingRequest,
  type MeetingBotProvider,
  type Timers,
} from "./types.js";

export type TestDoubleBotScenario =
  | { kind: "admit"; viaWaitingRoom?: boolean; meetingEndsAfterMs?: number }
  | { kind: "reject"; reason?: string }
  | { kind: "join_failed"; reason?: string; retryable: boolean }
  | { kind: "dispatch_error"; message?: string };

export interface TestDoubleMeetingBotProviderOptions {
  timers?: Timers;
  /** Delay between simulated lifecycle steps (joining -> waiting room -> in call). */
  stepDelayMs?: number;
  /** Picks the outcome per join attempt (1-based per session). Default: always admit. */
  scenario?: (request: JoinMeetingRequest, attempt: number) => TestDoubleBotScenario;
  frameDurationMs?: number;
  sampleRate?: number;
  /** Synthetic "speech" bursts alternate with silence so VAD produces real segments. */
  speechBurstMs?: number;
  silenceMs?: number;
}

interface SimulatedBot {
  sessionId: string;
  active: boolean;
  handles: Set<unknown>;
  sequenceNumber: number;
  elapsedMs: number;
}

/**
 * Deterministic stand-in for a real meeting bot provider (Recall.ai or
 * equivalent — not provisioned yet, see ARCHITECTURE.md section 5). It never
 * contacts a meeting platform: it simulates the provider-side lifecycle
 * (joining, waiting room, admitted/rejected, left) on timers, and while "in
 * the call" emits SYNTHETIC square-wave audio bursts alternating with silence
 * — not meeting audio — so the real VAD/ASR/ingestion path downstream has
 * something to segment. Exists so scheduling, retries, leave handling and the
 * shared ingestion path can be built and tested against the real interface.
 */
export class TestDoubleMeetingBotProvider implements MeetingBotProvider {
  readonly name = "test-double";

  private sink: BotEventSink | null = null;
  private readonly timers: Timers;
  private readonly stepDelayMs: number;
  private readonly scenario: NonNullable<TestDoubleMeetingBotProviderOptions["scenario"]>;
  private readonly frameDurationMs: number;
  private readonly sampleRate: number;
  private readonly speechBurstMs: number;
  private readonly silenceMs: number;
  private readonly bots = new Map<string, SimulatedBot>();
  private readonly attemptsBySession = new Map<string, number>();

  constructor(options: TestDoubleMeetingBotProviderOptions = {}) {
    this.timers = options.timers ?? systemTimers;
    this.stepDelayMs = options.stepDelayMs ?? 500;
    this.scenario = options.scenario ?? (() => ({ kind: "admit", viaWaitingRoom: true }));
    this.frameDurationMs = options.frameDurationMs ?? 100;
    this.sampleRate = options.sampleRate ?? 16_000;
    this.speechBurstMs = options.speechBurstMs ?? 1_500;
    this.silenceMs = options.silenceMs ?? 1_000;
  }

  setEventSink(sink: BotEventSink): void {
    this.sink = sink;
  }

  /** Bots currently simulated as present in a meeting (dispatched and not yet gone). */
  activeBotIds(): string[] {
    return [...this.bots.entries()].filter(([, bot]) => bot.active).map(([id]) => id);
  }

  async joinMeeting(request: JoinMeetingRequest): Promise<{ providerBotId: string }> {
    const attempt = (this.attemptsBySession.get(request.sessionId) ?? 0) + 1;
    this.attemptsBySession.set(request.sessionId, attempt);
    const scenario = this.scenario(request, attempt);
    if (scenario.kind === "dispatch_error") {
      throw new Error(scenario.message ?? "test-double provider dispatch error");
    }

    const providerBotId = `test-bot-${randomUUID()}`;
    const bot: SimulatedBot = {
      sessionId: request.sessionId,
      active: true,
      handles: new Set(),
      sequenceNumber: 0,
      elapsedMs: 0,
    };
    this.bots.set(providerBotId, bot);

    const steps: Array<() => void> = [() => this.emit(providerBotId, { type: "joining" })];
    switch (scenario.kind) {
      case "admit":
        if (scenario.viaWaitingRoom) steps.push(() => this.emit(providerBotId, { type: "waiting_room" }));
        steps.push(() => {
          this.emit(providerBotId, { type: "in_call" });
          this.streamAudio(providerBotId);
          if (scenario.meetingEndsAfterMs !== undefined) {
            this.after(providerBotId, scenario.meetingEndsAfterMs, () => {
              this.emit(providerBotId, { type: "left", reason: "meeting_ended" });
              this.stop(providerBotId);
            });
          }
        });
        break;
      case "reject":
        steps.push(() => this.emit(providerBotId, { type: "waiting_room" }));
        steps.push(() => {
          this.emit(providerBotId, { type: "admission_rejected", reason: scenario.reason ?? "Host did not admit the bot" });
          this.stop(providerBotId);
        });
        break;
      case "join_failed":
        steps.push(() => {
          this.emit(providerBotId, {
            type: "join_failed",
            reason: scenario.reason ?? "Meeting has not started",
            retryable: scenario.retryable,
          });
          this.stop(providerBotId);
        });
        break;
    }

    steps.forEach((step, index) => this.after(providerBotId, this.stepDelayMs * (index + 1), step));
    return { providerBotId };
  }

  async leaveMeeting(providerBotId: string): Promise<void> {
    const bot = this.bots.get(providerBotId);
    if (!bot) throw new Error(`Unknown test-double bot ${providerBotId}`);
    if (!bot.active) return;
    this.stop(providerBotId);
    // Real providers confirm removal asynchronously; the manager must treat this as a duplicate.
    this.timers.setTimeout(() => this.sink?.onEvent(bot.sessionId, providerBotId, { type: "left", reason: "requested" }), this.stepDelayMs);
  }

  private emit(providerBotId: string, event: Parameters<BotEventSink["onEvent"]>[2]): void {
    const bot = this.bots.get(providerBotId);
    if (!bot) return;
    this.sink?.onEvent(bot.sessionId, providerBotId, event);
  }

  private after(providerBotId: string, ms: number, fn: () => void): void {
    const bot = this.bots.get(providerBotId);
    if (!bot) return;
    const handle = this.timers.setTimeout(() => {
      bot.handles.delete(handle);
      if (bot.active) fn();
    }, ms);
    bot.handles.add(handle);
  }

  private stop(providerBotId: string): void {
    const bot = this.bots.get(providerBotId);
    if (!bot) return;
    bot.active = false;
    for (const handle of bot.handles) this.timers.clearTimeout(handle);
    bot.handles.clear();
  }

  private streamAudio(providerBotId: string): void {
    const bot = this.bots.get(providerBotId);
    if (!bot?.active) return;
    const startMs = bot.elapsedMs;
    const endMs = startMs + this.frameDurationMs;
    const cycle = this.speechBurstMs + this.silenceMs;
    const isSpeech = startMs % cycle < this.speechBurstMs;
    const samples = new Int16Array(Math.round((this.sampleRate * this.frameDurationMs) / 1000));
    if (isSpeech) {
      for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 9_000 : -9_000;
    }
    this.sink?.onAudio(bot.sessionId, providerBotId, {
      sequenceNumber: bot.sequenceNumber,
      startMs,
      endMs,
      sampleRate: this.sampleRate,
      samples,
    });
    bot.sequenceNumber += 1;
    bot.elapsedMs = endMs;
    this.after(providerBotId, this.frameDurationMs, () => this.streamAudio(providerBotId));
  }
}
