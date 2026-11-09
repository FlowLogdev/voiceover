import type { AudioChunkFrame } from "@voiceover/audio";

export interface SaveChunkResult {
  /** True if this sequence number was already stored (retry/replay) — caller should still ack. */
  alreadyStored: boolean;
}

export interface ChunkStore {
  saveChunk(recordingTrackId: string, frame: AudioChunkFrame): Promise<SaveChunkResult>;
}

/**
 * In-memory store used by unit tests and local dev without object storage
 * configured. Not for production use — see PrismaFileChunkStore.
 */
export class InMemoryChunkStore implements ChunkStore {
  private readonly seen = new Map<string, Set<number>>();

  async saveChunk(recordingTrackId: string, frame: AudioChunkFrame): Promise<SaveChunkResult> {
    const existing = this.seen.get(recordingTrackId) ?? new Set<number>();
    const alreadyStored = existing.has(frame.sequenceNumber);
    existing.add(frame.sequenceNumber);
    this.seen.set(recordingTrackId, existing);
    return { alreadyStored };
  }

  sequencesFor(recordingTrackId: string): number[] {
    return Array.from(this.seen.get(recordingTrackId) ?? []).sort((a, b) => a - b);
  }
}
