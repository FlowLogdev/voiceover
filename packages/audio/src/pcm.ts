/** Converts Web Audio's Float32 samples (range [-1, 1]) to little-endian PCM16. */
export function float32ToPCM16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]!));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * A simple, dependency-free checksum (not cryptographic) used only to detect
 * truncated/corrupted chunk uploads in transit, not for security purposes.
 */
export function fnv1aChecksum(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface AudioChunkFrame {
  sequenceNumber: number;
  startMs: number;
  endMs: number;
  sourceTrack: string;
  sampleRate: number;
  bytes: Uint8Array;
  checksum: string;
}

export function buildChunkFrame(params: {
  sequenceNumber: number;
  startMs: number;
  endMs: number;
  sourceTrack: string;
  sampleRate: number;
  samples: Float32Array;
}): AudioChunkFrame {
  const pcm16 = float32ToPCM16(params.samples);
  const bytes = pcm16ToBytes(pcm16);
  return {
    sequenceNumber: params.sequenceNumber,
    startMs: params.startMs,
    endMs: params.endMs,
    sourceTrack: params.sourceTrack,
    sampleRate: params.sampleRate,
    bytes,
    checksum: fnv1aChecksum(bytes),
  };
}

export function verifyChunkFrame(frame: AudioChunkFrame): boolean {
  return fnv1aChecksum(frame.bytes) === frame.checksum;
}
