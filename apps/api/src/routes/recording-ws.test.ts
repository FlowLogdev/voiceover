import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildChunkFrame } from "@voiceover/audio";
import { issueSessionToken, SESSION_COOKIE_NAME } from "@voiceover/auth";
import type { ServerMessage } from "@voiceover/types";
import { buildApp } from "../app.js";
import { InMemoryChunkStore } from "../recording/chunk-store.js";
import { InMemoryTranscriptStore } from "../recording/transcript-store.js";
import type { UploadAuthorization, UploadAuthorizer } from "../recording/upload-authorizer.js";

/**
 * Stands in for the Prisma-backed ownership check (covered against real
 * Postgres in recording-sessions.integration.test.ts) so the socket protocol
 * itself can be tested without a database.
 */
class FakeUploadAuthorizer implements UploadAuthorizer {
  readonly decisions = new Map<string, UploadAuthorization | Error>([
    ["track-1", { ok: true, recordingSessionId: "session-1", sourceTrack: "remote_tab" }],
  ]);
  readonly calls: Array<{ userId: string; recordingTrackId: string }> = [];
  async authorize(userId: string, recordingTrackId: string): Promise<UploadAuthorization> {
    this.calls.push({ userId, recordingTrackId });
    const decision = this.decisions.get(recordingTrackId) ?? { ok: false, closeCode: 4004, reason: "Recording track not found" };
    if (decision instanceof Error) throw decision;
    return decision;
  }
}

const SESSION_SECRET = "ws-test-secret-at-least-this-long";

function frameMessage(sequenceNumber: number, samples: Float32Array = new Float32Array(1600)) {
  const frame = buildChunkFrame({
    sequenceNumber,
    startMs: sequenceNumber * 100,
    endMs: (sequenceNumber + 1) * 100,
    sourceTrack: "remote_tab",
    sampleRate: 16000,
    samples,
  });
  return {
    type: "chunk" as const,
    sequenceNumber: frame.sequenceNumber,
    startMs: frame.startMs,
    endMs: frame.endMs,
    sourceTrack: frame.sourceTrack,
    sampleRate: frame.sampleRate,
    checksum: frame.checksum,
    bytesBase64: Buffer.from(frame.bytes).toString("base64"),
  };
}

/** Loud enough to clear the ASR test double's default VAD speech threshold. */
function loudSamples(length = 1600, amplitude = 0.8): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return samples;
}

/**
 * Polls instead of a fixed sleep: the auth-context preHandler hook now does a
 * real DB round trip for any request with a session cookie (see
 * auth-context.ts), so a fixed short sleep that's fine on a fast local
 * machine can be too tight on a loaded CI runner. Polls up to `timeoutMs`
 * rather than guessing a constant that happens to work in one environment.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("recording audio WebSocket ingestion", () => {
  let app: FastifyInstance;
  let chunkStore: InMemoryChunkStore;
  let baseUrl: string;
  let sessionCookie: string;
  let authorizer: FakeUploadAuthorizer;

  beforeEach(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    chunkStore = new InMemoryChunkStore();
    authorizer = new FakeUploadAuthorizer();
    app = await buildApp({ chunkStore, uploadAuthorizer: authorizer, transcriptStore: new InMemoryTranscriptStore() });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address.replace("http://", "ws://");

    const token = await issueSessionToken(
      { userId: "test-user", activeOrganizationId: null },
      SESSION_SECRET,
    );
    sessionCookie = `${SESSION_COOKIE_NAME}=${token}`;
  });

  afterEach(async () => {
    await app.close();
  });

  /** Opens a socket, sends one chunk immediately (before auth resolves), and reports how it closed. */
  function connectExpectingClose(trackId: string): Promise<{ code: number; reason: string; messages: ServerMessage[] }> {
    return new Promise((resolve, reject) => {
      const messages: ServerMessage[] = [];
      const ws = new WebSocket(`${baseUrl}/recording-tracks/${trackId}/audio`, { headers: { cookie: sessionCookie } });
      ws.on("open", () => ws.send(JSON.stringify(frameMessage(0, loudSamples()))));
      ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString(), messages }));
      ws.on("error", reject);
    });
  }

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl}/recording-tracks/track-1/audio`, {
        headers: { cookie: sessionCookie },
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  it("rejects a connection without a session cookie", async () => {
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${baseUrl}/recording-tracks/track-1/audio`);
      ws.on("close", (code) => resolve(code));
      ws.on("error", reject);
    });
    expect(closeCode).toBe(4001);
  });

  it("acks a valid chunk and stores it idempotently", async () => {
    const ws = await connect();
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    ws.send(JSON.stringify(frameMessage(0)));
    await waitFor(() => messages.length >= 1);
    ws.send(JSON.stringify(frameMessage(0))); // simulate retry/replay of the same chunk
    await waitFor(() => messages.length >= 2);

    expect(messages).toEqual([
      { type: "ack", sequenceNumber: 0 },
      { type: "ack", sequenceNumber: 0 },
    ]);
    expect(chunkStore.sequencesFor("track-1")).toEqual([0]);
    ws.close();
  });

  it("rejects a chunk with a tampered checksum", async () => {
    const ws = await connect();
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    const msg = frameMessage(1);
    msg.checksum = "deadbeef";
    ws.send(JSON.stringify(msg));
    await waitFor(() => messages.length >= 1);

    expect(messages).toEqual([{ type: "error", message: "Checksum mismatch for sequence 1" }]);
    expect(chunkStore.sequencesFor("track-1")).toEqual([]);
    ws.close();
  });

  it("relays live transcript events (test-double ASR) for audio loud enough to count as speech", async () => {
    const ws = await connect();
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    ws.send(JSON.stringify(frameMessage(0, loudSamples())));
    await waitFor(
      () => messages.some((m) => m.type === "transcript.partial"),
    );

    expect(messages).toContainEqual({ type: "ack", sequenceNumber: 0 });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "language.detected", sourceTrack: "remote_tab", languageCode: "en" }),
    );
    const partial = messages.find((m) => m.type === "transcript.partial");
    expect(partial).toMatchObject({
      type: "transcript.partial",
      sourceTrack: "remote_tab",
      startMs: 0,
      languageCode: "en",
    });
    expect((partial as { text: string }).text).toContain("test-double transcript");
    ws.close();
  });

  it("does not emit any transcript events for silent audio", async () => {
    const ws = await connect();
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    ws.send(JSON.stringify(frameMessage(0))); // default all-zero (silent) samples
    await waitFor(() => messages.length >= 1);
    // Give any (incorrect) async transcript event a moment to arrive, if it were going to.
    await new Promise((r) => setTimeout(r, 100));

    expect(messages).toEqual([{ type: "ack", sequenceNumber: 0 }]);
    ws.close();
  });
  it("checks ownership for the session's user, and stores nothing for a track that isn't theirs", async () => {
    const result = await connectExpectingClose("someone-elses-track");
    expect(result.code).toBe(4004);
    expect(result.messages).toEqual([]);
    expect(chunkStore.sequencesFor("someone-elses-track")).toEqual([]);
    expect(authorizer.calls).toEqual([{ userId: "test-user", recordingTrackId: "someone-elses-track" }]);
  });

  it("closes with the authorizer's code when the user didn't start the recording or consent is not in effect", async () => {
    authorizer.decisions.set("not-mine", { ok: false, closeCode: 4003, reason: "Only the user who started this recording can upload to it" });
    authorizer.decisions.set("revoked", { ok: false, closeCode: 4003, reason: "Recording consent is not in effect" });
    authorizer.decisions.set("stopped", { ok: false, closeCode: 4009, reason: "Recording session is not active" });
    for (const [trackId, code, reason] of [
      ["not-mine", 4003, "Only the user who started this recording can upload to it"],
      ["revoked", 4003, "Recording consent is not in effect"],
      ["stopped", 4009, "Recording session is not active"],
    ] as const) {
      const result = await connectExpectingClose(trackId);
      expect(result).toMatchObject({ code, reason, messages: [] });
      expect(chunkStore.sequencesFor(trackId)).toEqual([]);
    }
  });

  it("fails closed with a retryable 1011 when the ownership check can't run", async () => {
    authorizer.decisions.set("db-down", new Error("connection refused"));
    const result = await connectExpectingClose("db-down");
    expect(result.code).toBe(1011);
    expect(chunkStore.sequencesFor("db-down")).toEqual([]);
  });

  it("rejects frames whose sourceTrack doesn't match the server-issued track", async () => {
    const ws = await connect();
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({ ...frameMessage(0), sourceTrack: "local_mic" }));
    await waitFor(() => messages.length >= 1);
    expect(messages[0]).toMatchObject({ type: "error" });
    expect((messages[0] as { message: string }).message).toContain("does not match");
    expect(chunkStore.sequencesFor("track-1")).toEqual([]);
    ws.close();
  });

  it("closes a live upload immediately when its recording is stopped, and stores nothing after", async () => {
    const ws = await connect();
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify(frameMessage(0)));
    await waitFor(() => messages.length >= 1);
    await waitFor(() => app.recordingControl.liveUploadCount("track-1") === 1);

    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    app.recordingControl.stopTracks(["track-1"], 4003, "Recording consent revoked");
    expect(await closed).toBe(4003);
    expect(chunkStore.sequencesFor("track-1")).toEqual([0]);

    // A reconnect is re-authorized, and in-process the track stays stopped either way.
    authorizer.decisions.set("track-1", { ok: true, recordingSessionId: "session-1", sourceTrack: "remote_tab" });
    const again = await connectExpectingClose("track-1");
    expect(again.code).toBe(4009);
    expect(chunkStore.sequencesFor("track-1")).toEqual([0]);
  });
});
