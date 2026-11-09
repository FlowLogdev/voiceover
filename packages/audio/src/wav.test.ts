import { describe, expect, it } from "vitest";
import { buildWavHeader, concatWav } from "./wav.js";

function headerString(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

describe("buildWavHeader", () => {
  it("produces a valid 44-byte RIFF/WAVE/PCM header", () => {
    const header = buildWavHeader({ sampleRate: 16000, dataByteLength: 3200 });
    expect(header.length).toBe(44);
    expect(headerString(header, 0, 4)).toBe("RIFF");
    expect(headerString(header, 8, 4)).toBe("WAVE");
    expect(headerString(header, 12, 4)).toBe("fmt ");
    expect(headerString(header, 36, 4)).toBe("data");

    const view = new DataView(header.buffer);
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(3200); // data length
  });
});

describe("concatWav", () => {
  it("concatenates chunk payloads after a single header sized to their total length", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const wav = concatWav({ sampleRate: 16000, pcmChunks: [a, b] });
    expect(wav.length).toBe(44 + 5);
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4, 5]);
  });
});
