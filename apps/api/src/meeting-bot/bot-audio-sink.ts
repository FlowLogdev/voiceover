import { fnv1aChecksum, pcm16ToBytes } from "@voiceover/audio";
import type { BotAudioFrame, BotAudioSink, BotSessionRecord } from "@voiceover/meeting-bot";
import { TrackIngestion } from "../recording/track-ingestion.js";

/**
 * Routes meeting-bot audio into the exact same TrackIngestion pipeline the
 * browser-capture WebSocket uses (chunk store -> ASR -> transcript bus), so
 * everything downstream of ingestion is capture-method-agnostic.
 */
export class BotIngestionSink implements BotAudioSink {
  private readonly pipelines = new Map<string, TrackIngestion>();

  constructor(private readonly createIngestion: (recordingTrackId: string) => TrackIngestion) {}

  async pushAudio(session: BotSessionRecord, frame: BotAudioFrame): Promise<void> {
    let pipeline = this.pipelines.get(session.id);
    if (!pipeline) {
      pipeline = this.createIngestion(session.recordingTrackId);
      this.pipelines.set(session.id, pipeline);
    }
    // Copy so the checksum covers bytes we own, not a view a provider might reuse.
    const bytes = new Uint8Array(pcm16ToBytes(frame.samples));
    const result = await pipeline.ingest({
      sequenceNumber: frame.sequenceNumber,
      startMs: frame.startMs,
      endMs: frame.endMs,
      sourceTrack: "bot_mixed",
      sampleRate: frame.sampleRate,
      bytes,
      checksum: fnv1aChecksum(bytes),
    });
    if (!result.ok) throw new Error(result.error);
  }

  endOfStream(session: BotSessionRecord): void {
    this.pipelines.get(session.id)?.finalize();
    this.pipelines.delete(session.id);
  }
}
