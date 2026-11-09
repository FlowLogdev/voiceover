/**
 * Builds a standard 44-byte RIFF/WAVE header for mono 16-bit PCM, so finalized
 * recordings (and ad-hoc exports of buffered chunks) can be opened by any
 * audio player without a separate transcoding step.
 */
export function buildWavHeader(params: {
  sampleRate: number;
  dataByteLength: number;
  numChannels?: number;
}): Uint8Array {
  const { sampleRate, dataByteLength, numChannels = 1 } = params;
  const bytesPerSample = 2; // PCM16
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataByteLength, true);

  return new Uint8Array(buffer);
}

export function concatWav(params: {
  sampleRate: number;
  numChannels?: number;
  pcmChunks: Uint8Array[];
}): Uint8Array {
  const totalLength = params.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = buildWavHeader({
    sampleRate: params.sampleRate,
    dataByteLength: totalLength,
    numChannels: params.numChannels,
  });
  const result = new Uint8Array(header.length + totalLength);
  result.set(header, 0);
  let offset = header.length;
  for (const chunk of params.pcmChunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
