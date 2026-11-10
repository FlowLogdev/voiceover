import { describe, expect, it } from "vitest";
import { buildChunkFrame } from "@voiceover/audio";
import {
  AdmissionRetryPolicy,
  BotSessionManager,
  InMemoryBotSessionRepository,
  TestDoubleMeetingBotProvider,
} from "@voiceover/meeting-bot";
import { TestDoubleAsrProvider } from "@voiceover/transcription";
import { BotIngestionSink } from "../meeting-bot/bot-audio-sink.js";
import { InMemoryChunkStore } from "./chunk-store.js";
import { TrackIngestion, TranscriptBus, type TranscriptMessage } from "./track-ingestion.js";

function loudFrame(sequenceNumber: number) {
  const samples = new Float32Array(1600).map((_, i) => (i % 2 === 0 ? 0.8 : -0.8));
  return buildChunkFrame({
    sequenceNumber,
    startMs: sequenceNumber * 100,
    endMs: (sequenceNumber + 1) * 100,
    sourceTrack: "remote_tab",
    sampleRate: 16_000,
    samples,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("TrackIngestion", () => {
  it("stores, transcribes, and fans transcript events out to both the local listener and bus subscribers", async () => {
    const chunkStore = new InMemoryChunkStore();
    const bus = new TranscriptBus();
    const ingestion = new TrackIngestion("track-a", { chunkStore, asrProvider: new TestDoubleAsrProvider(), transcriptBus: bus });
    const local: TranscriptMessage[] = [];
    const watched: TranscriptMessage[] = [];
    const otherTrack: TranscriptMessage[] = [];
    ingestion.onTranscript((m) => local.push(m));
    bus.subscribe("track-a", (m) => watched.push(m));
    bus.subscribe("track-b", (m) => otherTrack.push(m));

    expect(await ingestion.ingest(loudFrame(0))).toEqual({ ok: true, alreadyStored: false });
    expect(chunkStore.sequencesFor("track-a")).toEqual([0]);
    expect(local.map((m) => m.type)).toEqual(["language.detected", "transcript.partial"]);
    expect(watched).toEqual(local);
    expect(otherTrack).toEqual([]);
  });

  it("does not feed a replayed chunk to ASR a second time", async () => {
    const ingestion = new TrackIngestion("track-a", {
      chunkStore: new InMemoryChunkStore(),
      asrProvider: new TestDoubleAsrProvider(),
      transcriptBus: new TranscriptBus(),
    });
    const events: TranscriptMessage[] = [];
    ingestion.onTranscript((m) => events.push(m));

    await ingestion.ingest(loudFrame(0));
    const countAfterFirst = events.length;
    expect(await ingestion.ingest(loudFrame(0))).toEqual({ ok: true, alreadyStored: true });
    expect(events.length).toBe(countAfterFirst);
  });

  it("runs onStored before any transcript event for that chunk, and rejects bad checksums without storing", async () => {
    const chunkStore = new InMemoryChunkStore();
    const ingestion = new TrackIngestion("track-a", { chunkStore, asrProvider: new TestDoubleAsrProvider(), transcriptBus: new TranscriptBus() });
    const order: string[] = [];
    ingestion.onTranscript((m) => order.push(m.type));

    await ingestion.ingest(loudFrame(0), () => order.push("stored"));
    expect(order[0]).toBe("stored");

    const tampered = { ...loudFrame(1), checksum: "00000000" };
    expect(await ingestion.ingest(tampered)).toEqual({ ok: false, error: "Checksum mismatch for sequence 1" });
    expect(chunkStore.sequencesFor("track-a")).toEqual([0]);
  });
});

describe("meeting bot -> shared ingestion pipeline (no database)", () => {
  it("turns a test-double bot's in-call audio into stored chunks and live transcript events on its track", async () => {
    const chunkStore = new InMemoryChunkStore();
    const bus = new TranscriptBus();
    const repository = new InMemoryBotSessionRepository();
    const provider = new TestDoubleMeetingBotProvider({ stepDelayMs: 10, frameDurationMs: 20, speechBurstMs: 200, silenceMs: 800 });
    const manager = new BotSessionManager({
      provider,
      repository,
      retryPolicy: new AdmissionRetryPolicy({ maxAttempts: 1 }),
      audioSink: new BotIngestionSink(
        (trackId) => new TrackIngestion(trackId, { chunkStore, asrProvider: new TestDoubleAsrProvider(), transcriptBus: bus }),
      ),
      logError: (error) => {
        throw error;
      },
    });
    repository.insert({
      id: "session-1",
      recordingTrackId: "bot-track-1",
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
    });
    const events: TranscriptMessage[] = [];
    bus.subscribe("bot-track-1", (m) => events.push(m));

    await manager.start("session-1");
    await waitFor(() => events.some((e) => e.type === "transcript.final"));
    await manager.leave("session-1");
    await manager.idle("session-1");

    const sequences = chunkStore.sequencesFor("bot-track-1");
    expect(sequences.length).toBeGreaterThan(5);
    expect(sequences).toEqual(sequences.map((_, i) => i)); // contiguous from 0, nothing dropped at join
    expect(events[0]).toMatchObject({ type: "language.detected", sourceTrack: "bot_mixed" });
    const final = events.find((e) => e.type === "transcript.final");
    expect(final).toMatchObject({ sourceTrack: "bot_mixed", startMs: 0 });
    expect(final && "text" in final ? final.text : "").toContain("[test-double transcript");
    expect((await repository.get("session-1"))?.status).toBe("LEFT");
  });
});
