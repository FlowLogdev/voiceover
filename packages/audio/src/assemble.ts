import { buildWavHeader } from "./wav.js";

/** What's known about a chunk without loading its bytes (i.e. its database row). */
export interface ChunkMeta {
  sequenceNumber: number;
  startMs: number;
  sampleRate: number;
  /** Stored PCM16LE byte length. */
  byteLength: number;
}

export type AssemblyPiece =
  | { kind: "silence"; byteLength: number }
  | { kind: "chunk"; sequenceNumber: number; byteLength: number };

export interface TrackAssemblyPlan {
  sampleRate: number;
  header: Uint8Array;
  /** In order, after the header. A chunk piece's byteLength may be 1 less than stored (odd trailing byte dropped). */
  pieces: AssemblyPiece[];
  byteLength: number;
  durationMs: number;
  chunkCount: number;
  /** Sequence numbers never received (gaps inside 0..max), filled with silence. */
  missingSequenceNumbers: number[];
  /** Total silence inserted to keep the audio timeline aligned with chunk timestamps. */
  silenceInsertedMs: number;
}

export class TrackAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackAssemblyError";
  }
}

/**
 * Plans one playable WAV for a track from chunk metadata alone, so the
 * caller can stream chunk bytes one at a time (an hour at 48 kHz is ~345 MB;
 * it must never be held in memory at once).
 *
 * Transcript timestamps live in the chunks' own startMs timeline, so playback
 * must too: wherever a chunk is missing (lost upload, dropped frame) silence
 * of the same length is inserted rather than splicing neighbours together,
 * which would make every later transcript timestamp point at the wrong audio.
 */
export function planTrackAssembly(chunks: ChunkMeta[]): TrackAssemblyPlan {
  if (chunks.length === 0) throw new TrackAssemblyError("Track has no audio chunks");
  const ordered = [...chunks].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const sampleRate = ordered[0]!.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new TrackAssemblyError(`Invalid sample rate ${sampleRate}`);
  const mixed = ordered.find((c) => c.sampleRate !== sampleRate);
  if (mixed) {
    throw new TrackAssemblyError(
      `Track mixes sample rates (${sampleRate} Hz and ${mixed.sampleRate} Hz at sequence ${mixed.sequenceNumber}); resampling is not implemented`,
    );
  }

  const missingSequenceNumbers: number[] = [];
  const pieces: AssemblyPiece[] = [];
  let samplesWritten = 0;
  let silenceSamples = 0;
  let previousSequence = -1;
  let chunkCount = 0;
  const samplesAt = (ms: number) => Math.round((ms * sampleRate) / 1000);

  for (const chunk of ordered) {
    if (chunk.sequenceNumber === previousSequence) continue; // duplicate row; first wins
    for (let missing = previousSequence + 1; missing < chunk.sequenceNumber; missing++) missingSequenceNumbers.push(missing);
    previousSequence = chunk.sequenceNumber;
    chunkCount++;

    const gap = samplesAt(chunk.startMs) - samplesWritten;
    if (gap > 0) {
      pieces.push({ kind: "silence", byteLength: gap * 2 });
      samplesWritten += gap;
      silenceSamples += gap;
    }
    const usable = chunk.byteLength - (chunk.byteLength % 2);
    pieces.push({ kind: "chunk", sequenceNumber: chunk.sequenceNumber, byteLength: usable });
    samplesWritten += usable / 2;
  }

  const dataByteLength = samplesWritten * 2;
  const header = buildWavHeader({ sampleRate, dataByteLength });
  return {
    sampleRate,
    header,
    pieces,
    byteLength: header.length + dataByteLength,
    durationMs: Math.round((samplesWritten * 1000) / sampleRate),
    chunkCount,
    missingSequenceNumbers,
    silenceInsertedMs: Math.round((silenceSamples * 1000) / sampleRate),
  };
}

/**
 * Streams the planned WAV: header, then each piece, loading one chunk's bytes
 * at a time via `loadChunk`. Throws if a chunk's bytes are shorter than its
 * recorded length (the file on disk doesn't match the database).
 */
export async function* streamTrackAssembly(
  plan: TrackAssemblyPlan,
  loadChunk: (sequenceNumber: number) => Promise<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield plan.header;
  const SILENCE_BLOCK = 64 * 1024;
  for (const piece of plan.pieces) {
    if (piece.kind === "silence") {
      for (let remaining = piece.byteLength; remaining > 0; remaining -= SILENCE_BLOCK) {
        yield new Uint8Array(Math.min(SILENCE_BLOCK, remaining));
      }
      continue;
    }
    const bytes = await loadChunk(piece.sequenceNumber);
    if (bytes.length < piece.byteLength) {
      throw new TrackAssemblyError(
        `Chunk ${piece.sequenceNumber} has ${bytes.length} bytes, expected ${piece.byteLength}`,
      );
    }
    yield bytes.subarray(0, piece.byteLength);
  }
}
