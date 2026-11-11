import { verifyChunkFrame, type AudioChunkFrame } from "@voiceover/audio";
import type { AsrEvent, AsrProvider, AsrSession } from "@voiceover/transcription";
import type { ServerMessage } from "@voiceover/types";
import type { ChunkStore } from "./chunk-store.js";
import type { TranscriptStore } from "./transcript-store.js";

export type TranscriptMessage = Extract<
  ServerMessage,
  { type: "transcript.partial" | "transcript.final" | "language.detected" }
>;

/**
 * In-process fan-out of live transcript events per recording track, so a
 * client can watch a track it isn't itself uploading — e.g. the web UI
 * watching a meeting bot's transcript. Single-process only: once api runs as
 * more than one replica this needs to become Redis pub/sub (or similar)
 * behind the same subscribe/publish shape.
 */
export class TranscriptBus {
  private readonly listeners = new Map<string, Set<(message: TranscriptMessage) => void>>();

  subscribe(recordingTrackId: string, listener: (message: TranscriptMessage) => void): () => void {
    const set = this.listeners.get(recordingTrackId) ?? new Set();
    set.add(listener);
    this.listeners.set(recordingTrackId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(recordingTrackId);
    };
  }

  publish(recordingTrackId: string, message: TranscriptMessage): void {
    for (const listener of this.listeners.get(recordingTrackId) ?? []) {
      try {
        listener(message);
      } catch {
        // One broken subscriber (e.g. a socket mid-close) must not starve the others.
      }
    }
  }

  subscriberCount(recordingTrackId: string): number {
    return this.listeners.get(recordingTrackId)?.size ?? 0;
  }
}

export function toTranscriptMessage(event: AsrEvent): TranscriptMessage {
  switch (event.type) {
    case "partial":
    case "final":
      return {
        type: event.type === "partial" ? "transcript.partial" : "transcript.final",
        segmentId: event.segmentId,
        sourceTrack: event.sourceTrack,
        startMs: event.startMs,
        endMs: event.endMs,
        text: event.text,
        languageCode: event.languageCode,
      };
    case "language_detected":
      return {
        type: "language.detected",
        sourceTrack: event.sourceTrack,
        languageCode: event.languageCode,
        confidence: event.confidence,
      };
  }
}

/** Decodes PCM16LE bytes into an Int16Array with its own aligned backing buffer
 * (an Int16Array view requires a 2-byte-aligned offset, which a pooled Buffer
 * slice doesn't guarantee). */
function toInt16Samples(bytes: Uint8Array): Int16Array {
  const aligned = new Uint8Array(bytes.length - (bytes.length % 2));
  aligned.set(bytes.subarray(0, aligned.length));
  return new Int16Array(aligned.buffer);
}

export interface TrackIngestionDeps {
  chunkStore: ChunkStore;
  asrProvider: AsrProvider;
  transcriptBus: TranscriptBus;
  /** Final segments are persisted here. Optional so pure pipeline tests can omit it. */
  transcriptStore?: TranscriptStore;
  logError?: (error: unknown, message: string) => void;
}

export type IngestResult = { ok: true; alreadyStored: boolean } | { ok: false; error: string };

/**
 * The single audio ingestion path for one recording track, shared by every
 * capture method (browser-capture WebSocket, meeting bot): verify checksum ->
 * persist chunk -> stream into one ASR session -> publish transcript events.
 */
export class TrackIngestion {
  private asrSession: AsrSession | null = null;
  private finalized = false;
  private readonly localListeners = new Set<(message: TranscriptMessage) => void>();
  /** Persistence is serialised per track so revisions of one segment land in order. */
  private persistence: Promise<void> = Promise.resolve();
  /**
   * Ingest is serialised per track: chunks reach ASR in the order they
   * arrived. Without this, a slower store write for chunk N let chunk N+1
   * reach ASR first (seen against real Postgres, where segment timing came
   * out shifted by a chunk).
   */
  private ingestQueue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly recordingTrackId: string,
    private readonly deps: TrackIngestionDeps,
  ) {}

  /** Resolves once every final segment emitted so far has been persisted (or failed and been logged). */
  flushed(): Promise<void> {
    return this.persistence;
  }

  /** Listener for this pipeline's own events only (e.g. the uploading socket). */
  onTranscript(listener: (message: TranscriptMessage) => void): void {
    this.localListeners.add(listener);
  }

  /**
   * `onStored` runs after the chunk is durably saved but before it reaches
   * ASR, so a caller can ack first and keep the wire order "ack, then any
   * transcript events that chunk produced".
   */
  ingest(frame: AudioChunkFrame, onStored?: () => void): Promise<IngestResult> {
    const result = this.ingestQueue.then(() => this.ingestInOrder(frame, onStored));
    this.ingestQueue = result.catch(() => {});
    return result;
  }

  private async ingestInOrder(frame: AudioChunkFrame, onStored?: () => void): Promise<IngestResult> {
    if (this.finalized) return { ok: false, error: "Track ingestion already finalized" };
    if (!verifyChunkFrame(frame)) {
      return { ok: false, error: `Checksum mismatch for sequence ${frame.sequenceNumber}` };
    }

    const { alreadyStored } = await this.deps.chunkStore.saveChunk(this.recordingTrackId, frame);
    onStored?.();
    // A replayed chunk (client retry after a lost ack) was already transcribed — don't feed it twice.
    if (!alreadyStored) {
      this.session(frame.sourceTrack).pushAudio({
        sequenceNumber: frame.sequenceNumber,
        startMs: frame.startMs,
        endMs: frame.endMs,
        sampleRate: frame.sampleRate,
        samples: toInt16Samples(frame.bytes),
      });
    }
    return { ok: true, alreadyStored };
  }

  /** Flushes any open transcript segment. Idempotent. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.asrSession?.finalize();
  }

  private session(sourceTrack: string): AsrSession {
    if (!this.asrSession) {
      this.asrSession = this.deps.asrProvider.createSession({ sourceTrack });
      this.asrSession.onEvent((event) => {
        if (event.type === "final" && this.deps.transcriptStore) {
          const store = this.deps.transcriptStore;
          const { type: _type, ...segment } = event;
          this.persistence = this.persistence
            .then(() => store.saveFinal(this.recordingTrackId, segment, this.deps.asrProvider.name))
            .catch((error) =>
              // Never break the live feed over a persistence failure, but don't hide it either.
              (this.deps.logError ?? console.error)(error, `Failed to persist transcript segment ${event.segmentId}`),
            );
        }
        const message = toTranscriptMessage(event);
        for (const listener of this.localListeners) listener(message);
        this.deps.transcriptBus.publish(this.recordingTrackId, message);
      });
    }
    return this.asrSession;
  }
}
