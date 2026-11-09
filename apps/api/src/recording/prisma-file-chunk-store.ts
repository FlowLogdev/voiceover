import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AudioChunkFrame } from "@voiceover/audio";
import { prisma } from "@voiceover/database";
import type { ChunkStore, SaveChunkResult } from "./chunk-store.js";

/**
 * Writes chunk bytes to local disk and records metadata in Postgres.
 *
 * This is a placeholder for the S3-compatible object storage described in
 * ARCHITECTURE.md section 4 (encryption at rest, short-lived signed URLs) —
 * local disk has neither. Swap the file write for an S3 PutObject call behind
 * the same `ChunkStore` interface before any real audio is recorded through
 * this path; nothing else needs to change.
 */
export class PrismaFileChunkStore implements ChunkStore {
  constructor(private readonly storageDir: string) {}

  async saveChunk(recordingTrackId: string, frame: AudioChunkFrame): Promise<SaveChunkResult> {
    const existing = await prisma.audioChunk.findUnique({
      where: {
        recordingTrackId_sequenceNumber: {
          recordingTrackId,
          sequenceNumber: frame.sequenceNumber,
        },
      },
    });
    if (existing) {
      return { alreadyStored: true };
    }

    const dir = join(this.storageDir, recordingTrackId);
    await mkdir(dir, { recursive: true });
    const storageKey = join(dir, `${String(frame.sequenceNumber).padStart(8, "0")}.pcm`);
    await writeFile(storageKey, frame.bytes);

    await prisma.audioChunk.create({
      data: {
        recordingTrackId,
        sequenceNumber: frame.sequenceNumber,
        startMs: frame.startMs,
        endMs: frame.endMs,
        storageKey,
        byteSize: frame.bytes.byteLength,
        checksum: frame.checksum,
        acknowledgedAt: new Date(),
      },
    });

    return { alreadyStored: false };
  }
}
