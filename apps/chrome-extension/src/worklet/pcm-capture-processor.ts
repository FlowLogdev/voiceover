// AudioWorkletProcessor runs in a separate realm without the usual DOM lib
// globals typed by default — see worklet-globals.d.ts for the minimal ambient
// types this file relies on (AudioWorkletProcessor, registerProcessor, sampleRate).

const CHUNK_DURATION_MS = 1000;

class PCMCaptureProcessor extends AudioWorkletProcessor {
  private buffer: number[] = [];
  private chunkSampleTarget: number;
  private samplesSinceChunkStart = 0;

  constructor() {
    super();
    this.chunkSampleTarget = Math.round((sampleRate * CHUNK_DURATION_MS) / 1000);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0]!;
      for (let i = 0; i < channelData.length; i++) {
        this.buffer.push(channelData[i]!);
      }
      this.samplesSinceChunkStart += channelData.length;

      if (this.samplesSinceChunkStart >= this.chunkSampleTarget) {
        const samples = new Float32Array(this.buffer);
        this.port.postMessage({ type: "audio-frame", samples, sampleRate }, [samples.buffer]);
        this.buffer = [];
        this.samplesSinceChunkStart = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PCMCaptureProcessor);
