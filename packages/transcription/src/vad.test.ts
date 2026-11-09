import { describe, expect, it } from "vitest";
import { computeRmsEnergy, isSpeech, VadSegmenter } from "./vad.js";

function silentFrame(length = 160): Int16Array {
  return new Int16Array(length); // all zeros
}

function loudFrame(length = 160, amplitude = 20000): Int16Array {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return samples;
}

describe("computeRmsEnergy / isSpeech", () => {
  it("returns 0 for silence", () => {
    expect(computeRmsEnergy(silentFrame())).toBe(0);
  });

  it("returns a high value for a loud signal", () => {
    expect(computeRmsEnergy(loudFrame())).toBeGreaterThan(10000);
  });

  it("classifies silence as not speech and a loud frame as speech", () => {
    expect(isSpeech(silentFrame())).toBe(false);
    expect(isSpeech(loudFrame())).toBe(true);
  });
});

describe("VadSegmenter", () => {
  it("emits segment_start on the first speech frame", () => {
    const vad = new VadSegmenter();
    const events = vad.pushFrame({ startMs: 0, endMs: 100, samples: loudFrame() });
    expect(events).toEqual([{ type: "segment_start", startMs: 0 }]);
  });

  it("emits segment_continue for subsequent speech frames in the same segment", () => {
    const vad = new VadSegmenter();
    vad.pushFrame({ startMs: 0, endMs: 100, samples: loudFrame() });
    const events = vad.pushFrame({ startMs: 100, endMs: 200, samples: loudFrame() });
    expect(events).toEqual([{ type: "segment_continue", endMs: 200 }]);
  });

  it("does not end a segment on a brief silence shorter than the threshold", () => {
    const vad = new VadSegmenter({ silenceDurationMsToEndSegment: 300 });
    vad.pushFrame({ startMs: 0, endMs: 100, samples: loudFrame() });
    const events = vad.pushFrame({ startMs: 100, endMs: 200, samples: silentFrame() });
    expect(events).toEqual([]);
  });

  it("ends a segment once trailing silence reaches the threshold", () => {
    const vad = new VadSegmenter({ silenceDurationMsToEndSegment: 150 });
    vad.pushFrame({ startMs: 0, endMs: 100, samples: loudFrame() }); // segment_start, speech ends at 100
    vad.pushFrame({ startMs: 100, endMs: 200, samples: silentFrame() }); // 100ms silence, not enough yet
    const events = vad.pushFrame({ startMs: 200, endMs: 300, samples: silentFrame() }); // 200ms silence total
    expect(events).toEqual([{ type: "segment_end", endMs: 100 }]);
  });

  it("starts a new segment after one ends", () => {
    const vad = new VadSegmenter({ silenceDurationMsToEndSegment: 100 });
    vad.pushFrame({ startMs: 0, endMs: 100, samples: loudFrame() });
    vad.pushFrame({ startMs: 100, endMs: 200, samples: silentFrame() }); // ends segment
    const events = vad.pushFrame({ startMs: 200, endMs: 300, samples: loudFrame() });
    expect(events).toEqual([{ type: "segment_start", startMs: 200 }]);
  });

  it("flush() closes a still-open segment", () => {
    const vad = new VadSegmenter();
    vad.pushFrame({ startMs: 0, endMs: 100, samples: loudFrame() });
    expect(vad.flush()).toEqual([{ type: "segment_end", endMs: 100 }]);
  });

  it("flush() is a no-op when no segment is open", () => {
    const vad = new VadSegmenter();
    expect(vad.flush()).toEqual([]);
  });
});
