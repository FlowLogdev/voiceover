import { describe, expect, it } from "vitest";
import { ChunkBuffer } from "./chunk-buffer.js";
import { buildChunkFrame } from "./pcm.js";

function frame(sequenceNumber: number) {
  return buildChunkFrame({
    sequenceNumber,
    startMs: sequenceNumber * 100,
    endMs: (sequenceNumber + 1) * 100,
    sourceTrack: "remote_tab",
    sampleRate: 16000,
    samples: new Float32Array(1600),
  });
}

describe("ChunkBuffer", () => {
  it("stores chunks as unacknowledged until marked", async () => {
    const buffer = await ChunkBuffer.open(`test-${Date.now()}-${Math.random()}`);
    await buffer.put(frame(0));
    await buffer.put(frame(1));

    const unacked = await buffer.getUnacknowledged();
    expect(unacked.map((c) => c.sequenceNumber)).toEqual([0, 1]);

    await buffer.markAcknowledged(0);
    const stillUnacked = await buffer.getUnacknowledged();
    expect(stillUnacked.map((c) => c.sequenceNumber)).toEqual([1]);

    buffer.close();
  });

  it("returns unacknowledged chunks in sequence order regardless of insertion order", async () => {
    const buffer = await ChunkBuffer.open(`test-${Date.now()}-${Math.random()}`);
    await buffer.put(frame(2));
    await buffer.put(frame(0));
    await buffer.put(frame(1));

    const unacked = await buffer.getUnacknowledged();
    expect(unacked.map((c) => c.sequenceNumber)).toEqual([0, 1, 2]);

    buffer.close();
  });
});
