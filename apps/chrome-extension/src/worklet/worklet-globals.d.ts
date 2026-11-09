// Minimal ambient types for the AudioWorkletGlobalScope — lib.dom.d.ts models
// AudioWorkletProcessor/registerProcessor as available in the main realm (for
// typing the AudioWorkletNode side), but the globals actually available
// *inside* a worklet module (this `sampleRate`, `this.port`, etc.) aren't
// separately modeled. Declared narrowly here rather than pulling in a full
// alternate lib, since only this one file runs in that scope.
declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;
