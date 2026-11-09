import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildChunkFrame } from "@voiceover/audio";
import { issueSessionToken, SESSION_COOKIE_NAME } from "@voiceover/auth";
import type { ServerMessage } from "@voiceover/types";
import { buildApp } from "../app.js";
import { InMemoryChunkStore } from "../recording/chunk-store.js";

const SESSION_SECRET = "ws-test-secret-at-least-this-long";

function frameMessage(sequenceNumber: number) {
  const frame = buildChunkFrame({
    sequenceNumber,
    startMs: sequenceNumber * 100,
    endMs: (sequenceNumber + 1) * 100,
    sourceTrack: "remote_tab",
    sampleRate: 16000,
    samples: new Float32Array(1600),
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

describe("recording audio WebSocket ingestion", () => {
  let app: FastifyInstance;
  let chunkStore: InMemoryChunkStore;
  let baseUrl: string;
  let sessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    chunkStore = new InMemoryChunkStore();
    app = await buildApp({ chunkStore });
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
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify(frameMessage(0))); // simulate retry/replay of the same chunk
    await new Promise((r) => setTimeout(r, 50));

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
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toEqual([{ type: "error", message: "Checksum mismatch for sequence 1" }]);
    expect(chunkStore.sequencesFor("track-1")).toEqual([]);
    ws.close();
  });
});
