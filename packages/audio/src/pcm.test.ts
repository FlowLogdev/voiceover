import { describe, expect, it } from "vitest";
import { buildChunkFrame, float32ToPCM16, fnv1aChecksum, verifyChunkFrame } from "./pcm.js";

describe("float32ToPCM16", () => {
  it("maps full-scale positive and negative samples", () => {
    const out = float32ToPCM16(new Float32Array([1, -1, 0]));
    expect(out[0]).toBe(0x7fff);
    expect(out[1]).toBe(-0x8000);
    expect(out[2]).toBe(0);
  });

  it("clamps out-of-range input instead of overflowing", () => {
    const out = float32ToPCM16(new Float32Array([2.5, -3]));
    expect(out[0]).toBe(0x7fff);
    expect(out[1]).toBe(-0x8000);
  });
});

describe("fnv1aChecksum", () => {
  it("is deterministic for the same bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(fnv1aChecksum(bytes)).toBe(fnv1aChecksum(new Uint8Array([1, 2, 3, 4])));
  });

  it("differs for different bytes", () => {
    expect(fnv1aChecksum(new Uint8Array([1, 2, 3]))).not.toBe(fnv1aChecksum(new Uint8Array([1, 2, 4])));
  });
});

describe("buildChunkFrame / verifyChunkFrame", () => {
  it("builds a frame whose checksum verifies", () => {
    const frame = buildChunkFrame({
      sequenceNumber: 1,
      startMs: 0,
      endMs: 100,
      sourceTrack: "remote_tab",
      sampleRate: 16000,
      samples: new Float32Array(1600),
    });
    expect(verifyChunkFrame(frame)).toBe(true);
  });

  it("detects a tampered payload", () => {
    const frame = buildChunkFrame({
      sequenceNumber: 1,
      startMs: 0,
      endMs: 100,
      sourceTrack: "remote_tab",
      sampleRate: 16000,
      samples: new Float32Array(1600),
    });
    frame.bytes[0] = (frame.bytes[0]! + 1) % 256;
    expect(verifyChunkFrame(frame)).toBe(false);
  });
});
