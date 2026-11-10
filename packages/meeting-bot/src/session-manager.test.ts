import { describe, expect, it, vi } from "vitest";
import { FakeTimers } from "./fake-timers.test-util.js";
import { InMemoryBotSessionRepository } from "./in-memory-repository.js";
import type { BotStatus } from "./lifecycle.js";
import { AdmissionRetryPolicy } from "./retry-policy.js";
import { BotLeaveError, BotSessionManager, MAX_TIMER_STEP_MS, type BotStatusChange } from "./session-manager.js";
import { TestDoubleMeetingBotProvider, type TestDoubleBotScenario } from "./test-double-provider.js";
import type { BotAudioFrame, BotSessionRecord } from "./types.js";

const STEP_MS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

function setup(
  options: {
    scenario?: (attempt: number) => TestDoubleBotScenario;
    retryPolicy?: AdmissionRetryPolicy;
    onStatusChange?: (change: BotStatusChange) => void | Promise<void>;
    timers?: FakeTimers;
    repository?: InMemoryBotSessionRepository;
  } = {},
) {
  const timers = options.timers ?? new FakeTimers();
  const repository = options.repository ?? new InMemoryBotSessionRepository();
  const provider = new TestDoubleMeetingBotProvider({
    timers,
    stepDelayMs: STEP_MS,
    frameDurationMs: 100,
    speechBurstMs: 300,
    silenceMs: 200,
    scenario: options.scenario ? (_req, attempt) => options.scenario!(attempt) : undefined,
  });
  const audio: Array<{ sessionId: string; frame: BotAudioFrame }> = [];
  const ended: string[] = [];
  const statuses: BotStatus[] = [];
  const manager = new BotSessionManager({
    provider,
    repository,
    timers,
    retryPolicy: options.retryPolicy ?? new AdmissionRetryPolicy({ maxAttempts: 3, baseDelayMs: 1_000 }),
    audioSink: {
      pushAudio: (session, frame) => {
        audio.push({ sessionId: session.id, frame });
      },
      endOfStream: (session) => {
        ended.push(session.id);
      },
    },
    onStatusChange: async (change) => {
      statuses.push(change.session.status);
      await options.onStatusChange?.(change);
    },
    logError: () => {},
  });
  return { timers, repository, provider, manager, audio, ended, statuses };
}

function newSession(repository: InMemoryBotSessionRepository, overrides: Partial<BotSessionRecord> = {}) {
  return repository.insert({
    id: `session-${Math.random().toString(36).slice(2)}`,
    recordingTrackId: "track-1",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    botName: "VoiceOver Notetaker",
    status: "SCHEDULED",
    providerBotId: null,
    scheduledJoinAt: null,
    joinAttempts: 0,
    startedAt: null,
    endedAt: null,
    failureReason: null,
    ...overrides,
  });
}

describe("BotSessionManager", () => {
  it("joins immediately, passes through the waiting room, and streams in-call audio to the sink", async () => {
    const { timers, repository, manager, audio, statuses } = setup();
    const session = newSession(repository);

    const afterStart = await manager.start(session.id);
    expect(afterStart?.status).toBe("JOINING");
    expect(afterStart?.joinAttempts).toBe(1);
    expect(afterStart?.providerBotId).toMatch(/^test-bot-/);

    await timers.advance(STEP_MS * 3 + 1_000);
    const current = await repository.get(session.id);
    expect(current?.status).toBe("IN_CALL");
    expect(current?.startedAt).toBeInstanceOf(Date);
    expect(statuses).toEqual(["JOINING", "WAITING_ROOM", "IN_CALL"]);

    expect(audio.length).toBeGreaterThanOrEqual(9);
    expect(audio.every((a) => a.sessionId === session.id)).toBe(true);
    expect(audio.map((a) => a.frame.sequenceNumber)).toEqual(audio.map((_, i) => i));
    // Synthetic pattern: 300ms burst, 200ms silence.
    const loud = audio.map((a) => a.frame.samples.some((s) => s !== 0));
    expect(loud.slice(0, 5)).toEqual([true, true, true, false, false]);
  });

  it("waits for a future scheduledJoinAt before dispatching", async () => {
    const timers = new FakeTimers();
    const { repository, provider, manager } = setup({ timers });
    const joinMeeting = vi.spyOn(provider, "joinMeeting");
    const session = newSession(repository, { scheduledJoinAt: new Date(timers.now() + 10 * 60_000) });

    expect((await manager.start(session.id))?.status).toBe("SCHEDULED");
    await timers.advance(10 * 60_000 - 1);
    expect(joinMeeting).not.toHaveBeenCalled();

    await timers.advance(1);
    expect(joinMeeting).toHaveBeenCalledTimes(1);
    expect((await repository.get(session.id))?.status).toBe("JOINING");
  });

  it("does not fire early for joins further out than setTimeout's 32-bit limit", async () => {
    const timers = new FakeTimers();
    const { repository, provider, manager } = setup({ timers });
    const joinMeeting = vi.spyOn(provider, "joinMeeting");
    const session = newSession(repository, { scheduledJoinAt: new Date(timers.now() + 30 * DAY_MS) });

    await manager.start(session.id);
    expect(Math.max(...timers.requestedDelays)).toBeLessThanOrEqual(MAX_TIMER_STEP_MS);

    await timers.advance(25 * DAY_MS);
    expect(joinMeeting).not.toHaveBeenCalled();
    expect((await repository.get(session.id))?.status).toBe("SCHEDULED");

    await timers.advance(5 * DAY_MS);
    expect(joinMeeting).toHaveBeenCalledTimes(1);
  });

  it("retries after an admission rejection and succeeds on the next attempt", async () => {
    const { timers, repository, manager, statuses } = setup({
      scenario: (attempt) => (attempt === 1 ? { kind: "reject", reason: "Host denied entry" } : { kind: "admit" }),
    });
    const session = newSession(repository);
    await manager.start(session.id);
    const firstBotId = (await repository.get(session.id))?.providerBotId;

    await timers.advance(STEP_MS * 3);
    const afterReject = await repository.get(session.id);
    expect(afterReject?.status).toBe("SCHEDULED");
    expect(afterReject?.failureReason).toContain("Host denied entry");
    expect(afterReject?.scheduledJoinAt?.getTime()).toBe(timers.now() + 1_000);

    await timers.advance(1_000 + STEP_MS * 2);
    const afterRetry = await repository.get(session.id);
    expect(afterRetry?.status).toBe("IN_CALL");
    expect(afterRetry?.joinAttempts).toBe(2);
    expect(afterRetry?.providerBotId).not.toBe(firstBotId);
    expect(afterRetry?.failureReason).toBeNull();
    expect(statuses).toEqual(["JOINING", "WAITING_ROOM", "SCHEDULED", "JOINING", "IN_CALL"]);
  });

  it("gives up with ADMISSION_REJECTED once retries are exhausted", async () => {
    const { timers, repository, manager } = setup({
      scenario: () => ({ kind: "reject" }),
      retryPolicy: new AdmissionRetryPolicy({ maxAttempts: 2, baseDelayMs: 1_000 }),
    });
    const session = newSession(repository);
    await manager.start(session.id);
    await timers.advance(60_000);

    const final = await repository.get(session.id);
    expect(final?.status).toBe("ADMISSION_REJECTED");
    expect(final?.joinAttempts).toBe(2);
    expect(final?.failureReason).toContain("gave up after 2 attempt(s)");
    expect(final?.endedAt).toBeInstanceOf(Date);
    expect(timers.pendingCount()).toBe(0);
  });

  it("fails immediately, without retrying, on a non-retryable join failure", async () => {
    const { timers, repository, provider, manager } = setup({
      scenario: () => ({ kind: "join_failed", reason: "Meeting is locked", retryable: false }),
    });
    const joinMeeting = vi.spyOn(provider, "joinMeeting");
    const session = newSession(repository);
    await manager.start(session.id);
    await timers.advance(60_000);

    const final = await repository.get(session.id);
    expect(final?.status).toBe("FAILED");
    expect(final?.failureReason).toBe("Meeting is locked");
    expect(joinMeeting).toHaveBeenCalledTimes(1);
  });

  it("treats a provider dispatch error as retryable", async () => {
    const { timers, repository, manager } = setup({
      scenario: (attempt) => (attempt === 1 ? { kind: "dispatch_error", message: "503 from provider" } : { kind: "admit" }),
    });
    const session = newSession(repository);
    const afterStart = await manager.start(session.id);
    expect(afterStart?.status).toBe("SCHEDULED");
    expect(afterStart?.failureReason).toContain("503 from provider");

    await timers.advance(1_000 + STEP_MS * 2);
    expect((await repository.get(session.id))?.status).toBe("IN_CALL");
  });

  it("leaves on request mid-call, flushes the stream once, and ignores the provider's late confirmation and audio", async () => {
    const { timers, repository, provider, manager, audio, ended } = setup({ scenario: () => ({ kind: "admit" }) });
    const session = newSession(repository);
    await manager.start(session.id);
    await timers.advance(STEP_MS * 2 + 500);
    const botId = (await repository.get(session.id))!.providerBotId!;
    expect(provider.activeBotIds()).toEqual([botId]);

    const left = await manager.leave(session.id);
    expect(left?.status).toBe("LEFT");
    expect(left?.failureReason).toBeNull();
    expect(provider.activeBotIds()).toEqual([]);
    expect(ended).toEqual([session.id]);

    const framesAtLeave = audio.length;
    const lateLeft = await manager.handleProviderEvent(session.id, botId, { type: "left", reason: "requested" });
    expect(lateLeft).toEqual({ applied: false, reason: "session already LEFT" });
    manager.handleProviderAudio(session.id, botId, audio[0]!.frame);
    await timers.advance(5_000);
    expect(audio.length).toBe(framesAtLeave);
    expect(ended).toEqual([session.id]);
  });

  it("cancels a pending scheduled join when asked to leave before it starts", async () => {
    const timers = new FakeTimers();
    const { repository, provider, manager, ended } = setup({ timers });
    const joinMeeting = vi.spyOn(provider, "joinMeeting");
    const session = newSession(repository, { scheduledJoinAt: new Date(timers.now() + 60_000) });
    await manager.start(session.id);

    expect((await manager.leave(session.id))?.status).toBe("LEFT");
    expect((await manager.leave(session.id))?.status).toBe("LEFT"); // idempotent
    await timers.advance(120_000);
    expect(joinMeeting).not.toHaveBeenCalled();
    expect(ended).toEqual([]); // never in the call, nothing to flush
  });

  it("keeps the session's status and throws if the provider fails to remove the bot", async () => {
    const { timers, repository, provider, manager } = setup({ scenario: () => ({ kind: "admit" }) });
    const session = newSession(repository);
    await manager.start(session.id);
    await timers.advance(STEP_MS * 2);
    vi.spyOn(provider, "leaveMeeting").mockRejectedValueOnce(new Error("provider down"));

    await expect(manager.leave(session.id)).rejects.toBeInstanceOf(BotLeaveError);
    expect((await repository.get(session.id))?.status).toBe("IN_CALL");
    expect((await manager.leave(session.id))?.status).toBe("LEFT");
  });

  it("ignores events from a superseded bot and out-of-order events", async () => {
    const { timers, repository, manager } = setup({
      scenario: (attempt) => (attempt === 1 ? { kind: "reject" } : { kind: "admit" }),
    });
    const session = newSession(repository);
    await manager.start(session.id);
    const staleBotId = (await repository.get(session.id))!.providerBotId!;
    await timers.advance(1_000 + STEP_MS * 5);
    expect((await repository.get(session.id))?.status).toBe("IN_CALL");

    expect(await manager.handleProviderEvent(session.id, staleBotId, { type: "fatal", reason: "old bot crashed" })).toEqual({
      applied: false,
      reason: "event from a superseded or unknown provider bot",
    });
    const currentBotId = (await repository.get(session.id))!.providerBotId!;
    const outOfOrder = await manager.handleProviderEvent(session.id, currentBotId, { type: "waiting_room" });
    expect(outOfOrder.applied).toBe(false);
    expect((await repository.get(session.id))?.status).toBe("IN_CALL");
  });

  it("records why the bot left when the meeting ends on its own", async () => {
    const { timers, repository, manager, ended } = setup({
      scenario: () => ({ kind: "admit", meetingEndsAfterMs: 2_000 }),
    });
    const session = newSession(repository);
    await manager.start(session.id);
    await timers.advance(STEP_MS * 2 + 2_000);

    const final = await repository.get(session.id);
    expect(final?.status).toBe("LEFT");
    expect(final?.failureReason).toBe("Bot left: meeting_ended");
    expect(ended).toEqual([session.id]);
  });

  it("re-arms scheduled joins after a restart (new manager, same repository)", async () => {
    const timers = new FakeTimers();
    const repository = new InMemoryBotSessionRepository();
    const first = setup({ timers, repository });
    const session = newSession(repository, { scheduledJoinAt: new Date(timers.now() + 60_000) });
    await first.manager.start(session.id);
    first.manager.shutdown(); // simulated crash: in-memory timers gone

    await timers.advance(120_000);
    expect((await repository.get(session.id))?.status).toBe("SCHEDULED");

    const second = setup({ timers, repository });
    await second.manager.restore(); // join time already passed -> joins now
    expect((await repository.get(session.id))?.status).toBe("JOINING");
  });

  it("re-attaches the audio route for an in-call session after a restart", async () => {
    const timers = new FakeTimers();
    const repository = new InMemoryBotSessionRepository();
    const session = newSession(repository, { status: "IN_CALL", providerBotId: "bot-from-before-restart" });
    const { manager, audio } = setup({ timers, repository });

    const frame = { sequenceNumber: 0, startMs: 0, endMs: 100, sampleRate: 16_000, samples: new Int16Array(1600) };
    manager.handleProviderAudio(session.id, "bot-from-before-restart", frame);
    await manager.idle(session.id);
    expect(audio).toHaveLength(0); // not live until restored — held, not ingested

    await manager.restore();
    manager.handleProviderAudio(session.id, "bot-from-before-restart", { ...frame, sequenceNumber: 1 });
    await manager.idle(session.id);
    expect(audio.map((a) => a.frame.sequenceNumber)).toEqual([0, 1]); // buffered frame replayed first
  });

  it("discards audio buffered for a bot that never makes it into the call", async () => {
    const { timers, repository, manager, audio } = setup({
      scenario: (attempt) => (attempt === 1 ? { kind: "reject" } : { kind: "admit" }),
    });
    const session = newSession(repository);
    await manager.start(session.id);
    const rejectedBotId = (await repository.get(session.id))!.providerBotId!;
    manager.handleProviderAudio(session.id, rejectedBotId, {
      sequenceNumber: 999,
      startMs: 0,
      endMs: 100,
      sampleRate: 16_000,
      samples: new Int16Array(1600),
    });

    await timers.advance(1_000 + STEP_MS * 5);
    expect((await repository.get(session.id))?.status).toBe("IN_CALL");
    expect(audio.some((a) => a.frame.sequenceNumber === 999)).toBe(false);
  });

  it("does not let a failing status hook break the lifecycle", async () => {
    const { timers, repository, manager } = setup({
      scenario: () => ({ kind: "admit" }),
      onStatusChange: () => {
        throw new Error("audit log down");
      },
    });
    const session = newSession(repository);
    await manager.start(session.id);
    await timers.advance(STEP_MS * 2);
    expect((await repository.get(session.id))?.status).toBe("IN_CALL");
  });
});
