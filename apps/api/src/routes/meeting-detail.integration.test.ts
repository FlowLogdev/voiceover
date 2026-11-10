/**
 * Integration tests against a real Postgres instance (DATABASE_URL): see
 * auth.integration.test.ts for setup. Audio goes through the real
 * Prisma-backed chunk store into a temp-dir object store; transcripts through
 * the real Prisma transcript store. Finalization itself is the worker's job
 * (apps/worker, tested there); here the playback object is put in place the
 * way the worker leaves it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildChunkFrame } from "@voiceover/audio";
import { prisma } from "@voiceover/database";
import { LocalDiskObjectStore, storageKeys } from "@voiceover/storage";
import type { AsrEvent, AsrProvider, AsrSession } from "@voiceover/transcription";
import {
  RECORDING_CONSENT_NOTICE,
  type MeetingDetailDTO,
  type MeetingTranscriptDTO,
  type RecordingSessionDTO,
  type ServerMessage,
  type SpeakerDTO,
} from "@voiceover/types";
import { buildApp } from "../app.js";

const consent = { attested: true, noticeVersion: RECORDING_CONSENT_NOTICE.version } as const;

interface TestUser {
  userId: string;
  cookie: string;
  organizationId: string;
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function chunkMessage(sequenceNumber: number, loud: boolean): string {
  const samples = new Float32Array(1600).map((_, i) => (loud ? (i % 2 === 0 ? 0.8 : -0.8) : 0));
  const frame = buildChunkFrame({
    sequenceNumber,
    startMs: sequenceNumber * 100,
    endMs: (sequenceNumber + 1) * 100,
    sourceTrack: "remote_tab",
    sampleRate: 16_000,
    samples,
  });
  return JSON.stringify({
    type: "chunk",
    sequenceNumber: frame.sequenceNumber,
    startMs: frame.startMs,
    endMs: frame.endMs,
    sourceTrack: frame.sourceTrack,
    sampleRate: frame.sampleRate,
    checksum: frame.checksum,
    bytesBase64: Buffer.from(frame.bytes).toString("base64"),
  });
}

/** A diarizing ASR stand-in: each chunk becomes one final segment, speakers alternating A, B, A, ... */
const diarizingAsr: AsrProvider = {
  name: "diarizing-double",
  createSession({ sourceTrack }): AsrSession {
    let listener: ((event: AsrEvent) => void) | null = null;
    return {
      onEvent: (cb) => {
        listener = cb;
      },
      pushAudio: (frame) =>
        listener?.({
          type: "final",
          segmentId: `seg-${frame.sequenceNumber}`,
          sourceTrack,
          startMs: frame.startMs,
          endMs: frame.endMs,
          text: `line ${frame.sequenceNumber}`,
          languageCode: "en",
          speakerLabel: frame.sequenceNumber % 2 === 0 ? "A" : "B",
        }),
      finalize: () => {},
    };
  },
};

describe("persisted transcript, meeting detail, speakers and playback (real Postgres)", () => {
  let dir: string;
  let objectStore: LocalDiskObjectStore;
  let app: FastifyInstance;
  let diarizingApp: FastifyInstance;
  const baseUrls = new Map<FastifyInstance, string>();

  async function listen(instance: FastifyInstance): Promise<void> {
    await instance.listen({ port: 0, host: "127.0.0.1" });
    baseUrls.set(instance, `127.0.0.1:${(instance.server.address() as AddressInfo).port}`);
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "voiceover-api-store-"));
    objectStore = new LocalDiskObjectStore(dir);
    app = await buildApp({ objectStore });
    diarizingApp = await buildApp({ objectStore, asrProvider: diarizingAsr });
    await listen(app);
    await listen(diarizingApp);
  });

  afterAll(async () => {
    await app.close();
    await diarizingApp.close();
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  async function signup(label: string): Promise<TestUser> {
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        password: "a-long-enough-password",
        name: label,
        organizationName: `${label} org`,
      },
    });
    expect(response.statusCode).toBe(201);
    const raw = response.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(";")[0]!;
    const body = response.json() as { userId: string; organizationId: string };
    return { ...body, cookie };
  }

  async function recordMeeting(instance: FastifyInstance, user: TestUser, chunks: boolean[]) {
    const base = baseUrls.get(instance)!;
    const meeting = await instance.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/meetings`,
      headers: { cookie: user.cookie },
      payload: { title: "Persisted call" },
    });
    const meetingId = meeting.json().id as string;
    const session = (
      await instance.inject({
        method: "POST",
        url: `/organizations/${user.organizationId}/meetings/${meetingId}/recording-sessions`,
        headers: { cookie: user.cookie },
        payload: { consent },
      })
    ).json() as RecordingSessionDTO;
    const trackId = session.tracks[0]!.id;

    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`ws://${base}/recording-tracks/${trackId}/audio`, { headers: { cookie: user.cookie } });
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve) => socket.on("open", resolve));
    chunks.forEach((loud, i) => socket.send(chunkMessage(i, loud)));
    await waitFor(() => (messages.filter((m) => m.type === "ack").length === chunks.length ? true : undefined));

    // Stopping closes the upload, which flushes the ASR's open segment as a final.
    const stopped = await instance.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/recording-sessions/${session.id}/stop`,
      headers: { cookie: user.cookie },
    });
    expect(stopped.json()).toMatchObject({ status: "FINALIZING" });
    return { meetingId, sessionId: session.id, trackId };
  }

  const get = (user: TestUser, url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { cookie: user.cookie, ...headers } });

  it("persists final transcript segments attributed to the capture source, and stores chunks with their sample rate", async () => {
    const owner = await signup("persist-owner");
    const { meetingId, trackId } = await recordMeeting(app, owner, [true, true, true, false]);
    const transcriptUrl = `/organizations/${owner.organizationId}/meetings/${meetingId}/transcript`;

    const transcript = await waitFor(async () => {
      const body = (await get(owner, transcriptUrl)).json() as MeetingTranscriptDTO;
      return body.segments.length > 0 ? body : undefined;
    });
    expect(transcript.segments).toHaveLength(1);
    expect(transcript.segments[0]).toMatchObject({
      recordingTrackId: trackId,
      sourceTrack: "remote_tab",
      startMs: 0,
      languageCode: "en",
      provider: "test-double",
    });
    expect(transcript.segments[0]!.text).toContain("test-double transcript");

    const detail = (await get(owner, `/organizations/${owner.organizationId}/meetings/${meetingId}`)).json() as MeetingDetailDTO;
    expect(detail.speakers).toEqual([
      { id: transcript.segments[0]!.speakerId, label: "Tab audio", displayName: null, attribution: "source" },
    ]);
    expect(detail.tracks).toEqual([
      expect.objectContaining({ id: trackId, method: "BROWSER", sourceTrack: "remote_tab", sessionStatus: "FINALIZING", playbackAvailable: false }),
    ]);

    const chunks = await prisma.audioChunk.findMany({ where: { recordingTrackId: trackId }, orderBy: { sequenceNumber: "asc" } });
    expect(chunks.map((c) => [c.sequenceNumber, c.sampleRate, c.storageKey])).toEqual(
      [0, 1, 2, 3].map((n) => [n, 16_000, storageKeys.chunk(trackId, n)]),
    );
    expect(await objectStore.size(chunks[0]!.storageKey)).toBe(3200);
  });

  it("numbers diarized speakers per meeting and lets members rename them", async () => {
    const owner = await signup("diarize-owner");
    const { meetingId } = await recordMeeting(diarizingApp, owner, [true, true, true]);
    const transcript = await waitFor(async () => {
      const body = (await get(owner, `/organizations/${owner.organizationId}/meetings/${meetingId}/transcript`)).json() as MeetingTranscriptDTO;
      return body.segments.length === 3 ? body : undefined;
    });
    const detail = (await get(owner, `/organizations/${owner.organizationId}/meetings/${meetingId}`)).json() as MeetingDetailDTO;
    expect(detail.speakers.map((s) => [s.label, s.attribution])).toEqual([
      ["Speaker 1", "diarization"],
      ["Speaker 2", "diarization"],
    ]);
    const [first, second] = detail.speakers;
    expect(transcript.segments.map((s) => s.speakerId)).toEqual([first!.id, second!.id, first!.id]);

    const renameUrl = `/organizations/${owner.organizationId}/meetings/${meetingId}/speakers/${first!.id}`;
    const renamed = await app.inject({ method: "PATCH", url: renameUrl, headers: { cookie: owner.cookie }, payload: { displayName: "  Maria  " } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json() as SpeakerDTO).toMatchObject({ label: "Speaker 1", displayName: "Maria" });

    const guest = await signup("diarize-guest");
    await prisma.membership.create({ data: { userId: guest.userId, organizationId: owner.organizationId, role: "GUEST" } });
    const guestRename = await app.inject({ method: "PATCH", url: renameUrl, headers: { cookie: guest.cookie }, payload: { displayName: "x" } });
    expect(guestRename.statusCode).toBe(403);

    const cleared = await app.inject({ method: "PATCH", url: renameUrl, headers: { cookie: owner.cookie }, payload: { displayName: null } });
    expect((cleared.json() as SpeakerDTO).displayName).toBeNull();
  });

  it("serves finalized playback audio with byte ranges, only within the organization", async () => {
    const owner = await signup("playback-owner");
    const { meetingId, trackId } = await recordMeeting(app, owner, [true, false]);
    const playbackUrl = `/organizations/${owner.organizationId}/recording-tracks/${trackId}/playback`;

    expect((await get(owner, playbackUrl)).statusCode).toBe(404); // not finalized yet

    // What the worker leaves behind after finalizing.
    const wav = new Uint8Array(1000).map((_, i) => i % 256);
    await objectStore.put(storageKeys.playback(trackId), wav);
    await prisma.recordingTrack.update({
      where: { id: trackId },
      data: { playbackStorageKey: storageKeys.playback(trackId), durationMs: 200, playbackSampleRate: 16_000 },
    });

    const full = await get(owner, playbackUrl);
    expect(full.statusCode).toBe(200);
    expect(full.headers).toMatchObject({ "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": "1000" });
    expect(new Uint8Array(full.rawPayload)).toEqual(wav);

    const partial = await get(owner, playbackUrl, { range: "bytes=10-19" });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers["content-range"]).toBe("bytes 10-19/1000");
    expect([...partial.rawPayload]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect((await get(owner, playbackUrl, { range: "bytes=5000-" })).statusCode).toBe(416);

    const detail = (await get(owner, `/organizations/${owner.organizationId}/meetings/${meetingId}`)).json() as MeetingDetailDTO;
    expect(detail.tracks[0]).toMatchObject({ playbackAvailable: true, durationMs: 200 });

    const outsider = await signup("playback-outsider");
    expect((await get(outsider, playbackUrl)).statusCode).toBe(403);
    for (const url of [
      `/organizations/${outsider.organizationId}/recording-tracks/${trackId}/playback`,
      `/organizations/${outsider.organizationId}/meetings/${meetingId}`,
      `/organizations/${outsider.organizationId}/meetings/${meetingId}/transcript`,
    ]) {
      expect((await get(outsider, url)).statusCode, url).toBe(404);
    }
  });
});
