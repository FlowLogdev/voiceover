import { describe, expect, it } from "vitest";
import { planTrackAssembly, streamTrackAssembly, TrackAssemblyError, type ChunkMeta } from "./assemble.js";

const RATE = 16_000;

interface TestChunk extends ChunkMeta {
  bytes: Uint8Array;
}

/** 100 ms chunk whose samples all equal `value`, so we can see where each lands. */
function chunk(sequenceNumber: number, value: number, overrides: Partial<TestChunk> = {}): TestChunk {
  const bytes = new Uint8Array(new Int16Array(1600).fill(value).buffer);
  return { sequenceNumber, startMs: sequenceNumber * 100, sampleRate: RATE, byteLength: bytes.length, bytes, ...overrides };
}

async function assemble(chunks: TestChunk[]) {
  const plan = planTrackAssembly(chunks);
  const bySequence = new Map(chunks.map((c) => [c.sequenceNumber, c.bytes]));
  const parts: Uint8Array[] = [];
  for await (const part of streamTrackAssembly(plan, async (seq) => bySequence.get(seq)!)) parts.push(part);
  const wav = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    wav.set(part, offset);
    offset += part.length;
  }
  return { plan, wav };
}

function sampleAtMs(wav: Uint8Array, ms: number): number {
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getInt16(44 + Math.round((ms * RATE) / 1000) * 2, true);
}

describe("track assembly", () => {
  it("builds a valid WAV whose header matches its contents, in sequence order", async () => {
    const { plan, wav } = await assemble([chunk(1, 2), chunk(0, 1)]);
    expect(wav.length).toBe(plan.byteLength);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint32(40, true)).toBe(wav.length - 44);
    expect(plan).toMatchObject({ durationMs: 200, chunkCount: 2, missingSequenceNumbers: [], silenceInsertedMs: 0 });
    expect(sampleAtMs(wav, 50)).toBe(1);
    expect(sampleAtMs(wav, 150)).toBe(2);
  });

  it("fills a missing chunk with silence so later audio stays at its own timestamp", async () => {
    const { plan, wav } = await assemble([chunk(0, 1), chunk(1, 2), chunk(3, 4)]);
    expect(plan).toMatchObject({ durationMs: 400, missingSequenceNumbers: [2], silenceInsertedMs: 100 });
    expect(sampleAtMs(wav, 250)).toBe(0);
    expect(sampleAtMs(wav, 350)).toBe(4); // still at 300-400 ms, not pulled back to 200 ms
  });

  it("also aligns a track that doesn't start at 0 ms", async () => {
    const { plan, wav } = await assemble([chunk(0, 7, { startMs: 500 })]);
    expect(plan.durationMs).toBe(600);
    expect(sampleAtMs(wav, 550)).toBe(7);
  });

  it("streams long silences in bounded blocks", async () => {
    const plan = planTrackAssembly([chunk(0, 1, { startMs: 60_000 })]);
    let largest = 0;
    for await (const part of streamTrackAssembly(plan, async () => chunk(0, 1).bytes)) largest = Math.max(largest, part.length);
    expect(plan.silenceInsertedMs).toBe(60_000);
    expect(largest).toBeLessThanOrEqual(64 * 1024);
  });

  it("refuses an empty track, mixed sample rates, and bytes that don't match the recorded length", async () => {
    expect(() => planTrackAssembly([])).toThrow(TrackAssemblyError);
    expect(() => planTrackAssembly([chunk(0, 1), chunk(1, 1, { sampleRate: 48_000 })])).toThrow(/mixes sample rates/);
    const truncated = chunk(0, 1);
    await expect(assemble([{ ...truncated, bytes: truncated.bytes.subarray(0, 10) }])).rejects.toThrow(/expected 3200/);
  });

  it("drops an odd trailing byte rather than shifting every later sample", async () => {
    const odd = chunk(0, 1);
    const oddBytes = new Uint8Array(odd.bytes.length + 1);
    oddBytes.set(odd.bytes);
    const { plan, wav } = await assemble([{ ...odd, bytes: oddBytes, byteLength: oddBytes.length }, chunk(1, 3)]);
    expect(plan.durationMs).toBe(200);
    expect(sampleAtMs(wav, 50)).toBe(1);
    expect(sampleAtMs(wav, 150)).toBe(3);
  });
});
