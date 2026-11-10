/**
 * Integration tests against a real Postgres instance (DATABASE_URL; CI
 * provides one, see .github/workflows/ci.yml). Audio objects live in a temp
 * directory. Sessions are seeded directly, as the API would have left them.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fnv1aChecksum } from "@voiceover/audio";
import { prisma } from "@voiceover/database";
import { LocalDiskObjectStore, storageKeys } from "@voiceover/storage";
import { RecordingFinalizer } from "./finalizer.js";

const RATE = 16_000;
const quiet = () => {};

describe("RecordingFinalizer (real Postgres)", () => {
  let dir: string;
  let store: LocalDiskObjectStore;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "voiceover-finalizer-"));
    store = new LocalDiskObjectStore(dir);
    const suffix = randomUUID();
    const org = await prisma.organization.create({ data: { name: "Finalizer org", slug: `finalizer-${suffix}` } });
    const user = await prisma.user.create({ data: { email: `finalizer-${suffix}@example.test`, name: "Ana" } });
    organizationId = org.id;
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  /** A 100 ms PCM16 chunk filled with `value`. */
  function pcm(value: number): Uint8Array {
    return new Uint8Array(new Int16Array(RATE / 10).fill(value).buffer);
  }

  async function seedSession(options: {
    endedAt?: Date;
    chunks?: Array<{ sequenceNumber: number; value: number; sampleRate?: number; writeObject?: boolean; corrupt?: boolean }>;
  }) {
    const meeting = await prisma.meeting.create({ data: { organizationId, hostUserId: userId, title: "Finalize me" } });
    const session = await prisma.recordingSession.create({
      data: {
        meetingId: meeting.id,
        method: "BROWSER",
        status: "FINALIZING",
        startedAt: new Date(Date.now() - 120_000),
        endedAt: options.endedAt ?? new Date(Date.now() - 60_000),
        startedByUserId: userId,
        tracks: { create: { sourceTrack: "remote_tab", storagePrefix: "unused" } },
      },
      include: { tracks: true },
    });
    const track = session.tracks[0]!;
    for (const chunk of options.chunks ?? []) {
      const bytes = pcm(chunk.value);
      const storageKey = storageKeys.chunk(track.id, chunk.sequenceNumber);
      if (chunk.writeObject !== false) await store.put(storageKey, chunk.corrupt ? pcm(chunk.value + 1) : bytes);
      await prisma.audioChunk.create({
        data: {
          recordingTrackId: track.id,
          sequenceNumber: chunk.sequenceNumber,
          startMs: chunk.sequenceNumber * 100,
          endMs: (chunk.sequenceNumber + 1) * 100,
          storageKey,
          byteSize: bytes.length,
          checksum: fnv1aChecksum(bytes),
          sampleRate: chunk.sampleRate ?? RATE,
        },
      });
    }
    return { meetingId: meeting.id, sessionId: session.id, trackId: track.id };
  }

  it("assembles aligned playback audio, records gaps, rebuilds the language timeline, and is idempotent", async () => {
    const { meetingId, sessionId, trackId } = await seedSession({
      chunks: [
        { sequenceNumber: 0, value: 100 },
        { sequenceNumber: 1, value: 200 },
        { sequenceNumber: 3, value: 400 }, // 2 never arrived
      ],
    });
    const segment = (startMs: number, endMs: number, languageCode: string, isFinal = true) => ({
      meetingId,
      recordingTrackId: trackId,
      externalSegmentId: randomUUID(),
      sourceTrack: "remote_tab",
      startMs,
      endMs,
      text: "x",
      languageCode,
      provider: "test-double",
      isFinal,
    });
    await prisma.transcriptSegment.createMany({
      data: [segment(0, 100, "en"), segment(150, 200, "en"), segment(300, 400, "es"), segment(0, 400, "pt", false)],
    });

    const finalizer = new RecordingFinalizer({ objectStore: store, log: quiet });
    expect(await finalizer.runOnce({ sessionIds: [sessionId] })).toEqual([{ sessionId, status: "COMPLETE" }]);

    const track = await prisma.recordingTrack.findUniqueOrThrow({ where: { id: trackId } });
    expect(track).toMatchObject({
      durationMs: 400,
      chunkCount: 3,
      missingChunkCount: 1,
      playbackStorageKey: storageKeys.playback(trackId),
      playbackSampleRate: RATE,
    });
    const wav = await store.get(track.playbackStorageKey!);
    expect(wav.length).toBe(44 + 400 * (RATE / 1000) * 2);
    const view = new DataView(wav.buffer, wav.byteOffset);
    const sampleAt = (ms: number) => view.getInt16(44 + ms * (RATE / 1000) * 2, true);
    expect([sampleAt(50), sampleAt(150), sampleAt(250), sampleAt(350)]).toEqual([100, 200, 0, 400]);

    const languages = async () =>
      prisma.languageSegment.findMany({
        where: { meetingId },
        orderBy: { startMs: "asc" },
        select: { languageCode: true, startMs: true, endMs: true },
      });
    expect(await languages()).toEqual([
      { languageCode: "en", startMs: 0, endMs: 200 },
      { languageCode: "es", startMs: 300, endMs: 400 },
    ]);
    const session = await prisma.recordingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({ status: "COMPLETE", finalizeAttempts: 1, finalizeLockedUntil: null });
    expect(session.finalizedAt).not.toBeNull();
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).endedAt).toEqual(session.endedAt);

    // Re-running (e.g. a worker that lost its lease mid-way) produces the same result, not duplicates.
    await prisma.recordingSession.update({ where: { id: sessionId }, data: { status: "FINALIZING" } });
    expect(await finalizer.runOnce({ sessionIds: [sessionId] })).toEqual([{ sessionId, status: "COMPLETE" }]);
    expect(await languages()).toHaveLength(2);
    expect((await store.get(track.playbackStorageKey!)).length).toBe(wav.length);
  });

  it("finalizes a track with no audio as empty, not as an error", async () => {
    const { sessionId, trackId } = await seedSession({});
    const finalizer = new RecordingFinalizer({ objectStore: store, log: quiet });
    expect(await finalizer.runOnce({ sessionIds: [sessionId] })).toEqual([{ sessionId, status: "COMPLETE" }]);
    expect(await prisma.recordingTrack.findUniqueOrThrow({ where: { id: trackId } })).toMatchObject({
      chunkCount: 0,
      durationMs: 0,
      playbackStorageKey: null,
    });
  });

  it("waits for a just-ended session to settle before claiming it", async () => {
    const endedAt = new Date();
    const { sessionId } = await seedSession({ endedAt, chunks: [{ sequenceNumber: 0, value: 1 }] });
    const at = (ms: number) => () => new Date(endedAt.getTime() + ms);
    expect(await new RecordingFinalizer({ objectStore: store, settleMs: 5_000, now: at(1_000), log: quiet }).claimNext({ sessionIds: [sessionId] })).toBeNull();
    expect(await new RecordingFinalizer({ objectStore: store, settleMs: 5_000, now: at(6_000), log: quiet }).claimNext({ sessionIds: [sessionId] })).toBe(sessionId);
  });

  it("lets exactly one of several concurrent workers claim a session", async () => {
    const { sessionId } = await seedSession({ chunks: [{ sequenceNumber: 0, value: 1 }] });
    const workers = Array.from({ length: 5 }, () => new RecordingFinalizer({ objectStore: store, log: quiet }));
    const claims = await Promise.all(workers.map((w) => w.claimNext({ sessionIds: [sessionId] })));
    expect(claims.filter((c) => c === sessionId)).toHaveLength(1);
    // And a crashed worker's claim is taken over once its lease expires.
    const later = new RecordingFinalizer({ objectStore: store, log: quiet, now: () => new Date(Date.now() + 11 * 60_000) });
    expect(await later.claimNext({ sessionIds: [sessionId] })).toBe(sessionId);
  });

  it("retries a transient failure with backoff, then marks the session FAILED", async () => {
    // Chunk row exists but its object is missing: an I/O error, worth retrying.
    const { sessionId } = await seedSession({ chunks: [{ sequenceNumber: 0, value: 1, writeObject: false }] });
    let clock = Date.now();
    const finalizer = new RecordingFinalizer({
      objectStore: store,
      now: () => new Date(clock),
      maxAttempts: 2,
      baseRetryDelayMs: 60_000,
      log: quiet,
    });

    const [first] = await finalizer.runOnce({ sessionIds: [sessionId] });
    expect(first).toMatchObject({ sessionId, status: "RETRY" });
    expect(first!.status === "RETRY" && first!.retryAt.getTime()).toBe(clock + 60_000);
    expect(await prisma.recordingSession.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({
      status: "FINALIZING",
      finalizeAttempts: 1,
    });
    expect(await finalizer.runOnce({ sessionIds: [sessionId] })).toEqual([]); // backing off

    clock += 61_000;
    const [second] = await finalizer.runOnce({ sessionIds: [sessionId] });
    expect(second).toMatchObject({ sessionId, status: "FAILED" });
    const failed = await prisma.recordingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toMatch(/^Finalization failed after 2 attempts/);
  });

  it("fails at once, without retrying, on corrupt or unusable audio", async () => {
    const corrupt = await seedSession({ chunks: [{ sequenceNumber: 0, value: 1, corrupt: true }] });
    const mixed = await seedSession({
      chunks: [
        { sequenceNumber: 0, value: 1 },
        { sequenceNumber: 1, value: 1, sampleRate: 48_000 },
      ],
    });
    const finalizer = new RecordingFinalizer({ objectStore: store, log: quiet });
    const outcomes = await finalizer.runOnce({ sessionIds: [corrupt.sessionId, mixed.sessionId] });
    expect(outcomes.map((o) => o.status)).toEqual(["FAILED", "FAILED"]);
    const reasons = await prisma.recordingSession.findMany({
      where: { id: { in: [corrupt.sessionId, mixed.sessionId] } },
      select: { id: true, failureReason: true, finalizeAttempts: true },
    });
    const byId = new Map(reasons.map((r) => [r.id, r]));
    expect(byId.get(corrupt.sessionId)).toMatchObject({ finalizeAttempts: 1 });
    expect(byId.get(corrupt.sessionId)!.failureReason).toMatch(/does not match its checksum/);
    expect(byId.get(mixed.sessionId)!.failureReason).toMatch(/mixes sample rates/);
  });
});
