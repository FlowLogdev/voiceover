import type { AudioChunkFrame } from "@voiceover/audio";
import { prisma } from "@voiceover/database";
import { storageKeys, type ObjectStore } from "@voiceover/storage";
import type { ChunkStore, SaveChunkResult } from "./chunk-store.js";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Writes chunk bytes to the object store and records metadata (including the
 * sample rate, needed later to assemble the playback file) in Postgres.
 *
 * The object store is local disk today (`LocalDiskObjectStore`), a placeholder
 * for S3-compatible storage with encryption at rest (ARCHITECTURE.md
 * section 4); swapping it needs no change here.
 */
export class PrismaFileChunkStore implements ChunkStore {
  constructor(private readonly objectStore: ObjectStore) {}

  async saveChunk(recordingTrackId: string, frame: AudioChunkFrame): Promise<SaveChunkResult> {
    const existing = await prisma.audioChunk.findUnique({
      where: { recordingTrackId_sequenceNumber: { recordingTrackId, sequenceNumber: frame.sequenceNumber } },
      select: { id: true },
    });
    if (existing) return { alreadyStored: true };

    // Object first, row second: a row never points at bytes that aren't there.
    // Same key for a retried sequence number, so a crash between the two just
    // gets overwritten on retry.
    const storageKey = storageKeys.chunk(recordingTrackId, frame.sequenceNumber);
    await this.objectStore.put(storageKey, frame.bytes);

    try {
      await prisma.audioChunk.create({
        data: {
          recordingTrackId,
          sequenceNumber: frame.sequenceNumber,
          startMs: frame.startMs,
          endMs: frame.endMs,
          storageKey,
          byteSize: frame.bytes.byteLength,
          checksum: frame.checksum,
          sampleRate: frame.sampleRate,
          acknowledgedAt: new Date(),
        },
      });
    } catch (error) {
      // A concurrent replay of the same chunk won the insert.
      if (isUniqueViolation(error)) return { alreadyStored: true };
      throw error;
    }
    return { alreadyStored: false };
  }
}
