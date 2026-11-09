import { describe, expect, it } from "vitest";
import { TestDoubleAsrProvider } from "./test-double-provider.js";
import type { AsrEvent } from "./types.js";

function silentFrame(length = 160): Int16Array {
  return new Int16Array(length);
}

function loudFrame(length = 160, amplitude = 20000): Int16Array {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return samples;
}

describe("TestDoubleAsrProvider", () => {
  it("emits language_detected once, then partial then final for one speech segment", () => {
    const provider = new TestDoubleAsrProvider({ silenceDurationMsToEndSegment: 150 });
    const session = provider.createSession({ sourceTrack: "remote_tab" });
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));

    session.pushAudio({ sequenceNumber: 0, startMs: 0, endMs: 100, sampleRate: 1600, samples: loudFrame() });
    session.pushAudio({
      sequenceNumber: 1,
      startMs: 100,
      endMs: 200,
      sampleRate: 1600,
      samples: silentFrame(),
    });
    session.pushAudio({
      sequenceNumber: 2,
      startMs: 200,
      endMs: 300,
      sampleRate: 1600,
      samples: silentFrame(),
    });

    expect(events.map((e) => e.type)).toEqual(["language_detected", "partial", "final"]);
    expect(events[0]).toMatchObject({ type: "language_detected", languageCode: "en", confidence: 1 });

    const partial = events[1] as Extract<AsrEvent, { type: "partial" }>;
    const final = events[2] as Extract<AsrEvent, { type: "final" }>;
    expect(partial.segmentId).toBe(final.segmentId);
    expect(partial.startMs).toBe(0);
    expect(final.endMs).toBe(100);
    expect(final.text).toContain("test-double transcript");
  });

  it("reports the configured language", () => {
    const provider = new TestDoubleAsrProvider({ languageCode: "es" });
    const session = provider.createSession({ sourceTrack: "remote_tab" });
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));

    session.pushAudio({ sequenceNumber: 0, startMs: 0, endMs: 100, sampleRate: 1600, samples: loudFrame() });

    expect(events[0]).toMatchObject({ type: "language_detected", languageCode: "es" });
  });

  it("emits a new segmentId for a second speech segment", () => {
    const provider = new TestDoubleAsrProvider({ silenceDurationMsToEndSegment: 100 });
    const session = provider.createSession({ sourceTrack: "remote_tab" });
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));

    session.pushAudio({ sequenceNumber: 0, startMs: 0, endMs: 100, sampleRate: 1600, samples: loudFrame() });
    session.pushAudio({
      sequenceNumber: 1,
      startMs: 100,
      endMs: 200,
      sampleRate: 1600,
      samples: silentFrame(),
    }); // ends segment 1
    session.pushAudio({ sequenceNumber: 2, startMs: 200, endMs: 300, sampleRate: 1600, samples: loudFrame() }); // starts segment 2

    const finals = events.filter((e) => e.type === "final") as Extract<AsrEvent, { type: "final" }>[];
    const secondPartial = events.find(
      (e, i) => e.type === "partial" && i > events.findIndex((x) => x.type === "final"),
    ) as Extract<AsrEvent, { type: "partial" }>;
    expect(finals).toHaveLength(1);
    expect(secondPartial.segmentId).not.toBe(finals[0]!.segmentId);
  });

  it("finalize() flushes a still-open segment as final", () => {
    const provider = new TestDoubleAsrProvider();
    const session = provider.createSession({ sourceTrack: "remote_tab" });
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));

    session.pushAudio({ sequenceNumber: 0, startMs: 0, endMs: 100, sampleRate: 1600, samples: loudFrame() });
    expect(events.map((e) => e.type)).toEqual(["language_detected", "partial"]);

    session.finalize();
    expect(events.map((e) => e.type)).toEqual(["language_detected", "partial", "final"]);
  });

  it("emits nothing for a session that only ever sees silence", () => {
    const provider = new TestDoubleAsrProvider();
    const session = provider.createSession({ sourceTrack: "remote_tab" });
    const events: AsrEvent[] = [];
    session.onEvent((e) => events.push(e));

    session.pushAudio({
      sequenceNumber: 0,
      startMs: 0,
      endMs: 100,
      sampleRate: 1600,
      samples: silentFrame(),
    });
    session.finalize();

    expect(events).toEqual([]);
  });
});
