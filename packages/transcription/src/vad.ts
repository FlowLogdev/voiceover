/**
 * Simple energy-based (RMS) voice activity detection. Not a substitute for a
 * real VAD model (e.g. WebRTC VAD, Silero) — good enough to segment audio
 * into speech/silence spans for the test-double ASR provider and for early
 * pipeline wiring, but should be swapped for a real model before relying on
 * it for accuracy-sensitive behavior.
 */

const DEFAULT_SILENCE_RMS_THRESHOLD = 500; // out of a possible 32767 for PCM16
const DEFAULT_SILENCE_DURATION_MS_TO_END_SEGMENT = 600;

export function computeRmsEnergy(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i]! * samples[i]!;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function isSpeech(samples: Int16Array, threshold = DEFAULT_SILENCE_RMS_THRESHOLD): boolean {
  return computeRmsEnergy(samples) >= threshold;
}

export type VadSegmentEvent =
  | { type: "segment_start"; startMs: number }
  | { type: "segment_continue"; endMs: number }
  | { type: "segment_end"; endMs: number };

export interface VadSegmenterOptions {
  silenceRmsThreshold?: number;
  silenceDurationMsToEndSegment?: number;
}

/**
 * Stateful segmenter: feed it consecutive audio frames (with their start/end
 * timestamps) and it emits segment_start/continue/end events marking
 * contiguous speech spans, using trailing-silence duration to decide when a
 * segment has actually ended (so a short pause mid-sentence doesn't split it).
 */
export class VadSegmenter {
  private readonly silenceRmsThreshold: number;
  private readonly silenceDurationMsToEndSegment: number;
  private inSegment = false;
  private silenceDurationMs = 0;
  private lastSpeechEndMs = 0;

  constructor(options: VadSegmenterOptions = {}) {
    this.silenceRmsThreshold = options.silenceRmsThreshold ?? DEFAULT_SILENCE_RMS_THRESHOLD;
    this.silenceDurationMsToEndSegment =
      options.silenceDurationMsToEndSegment ?? DEFAULT_SILENCE_DURATION_MS_TO_END_SEGMENT;
  }

  pushFrame(frame: { startMs: number; endMs: number; samples: Int16Array }): VadSegmentEvent[] {
    const events: VadSegmentEvent[] = [];
    const speech = isSpeech(frame.samples, this.silenceRmsThreshold);
    const frameDurationMs = frame.endMs - frame.startMs;

    if (speech) {
      this.silenceDurationMs = 0;
      this.lastSpeechEndMs = frame.endMs;
      if (!this.inSegment) {
        this.inSegment = true;
        events.push({ type: "segment_start", startMs: frame.startMs });
      } else {
        events.push({ type: "segment_continue", endMs: frame.endMs });
      }
    } else if (this.inSegment) {
      this.silenceDurationMs += frameDurationMs;
      if (this.silenceDurationMs >= this.silenceDurationMsToEndSegment) {
        this.inSegment = false;
        events.push({ type: "segment_end", endMs: this.lastSpeechEndMs });
      }
    }

    return events;
  }

  /** Call when the stream ends, to flush a still-open segment. */
  flush(): VadSegmentEvent[] {
    if (this.inSegment) {
      this.inSegment = false;
      return [{ type: "segment_end", endMs: this.lastSpeechEndMs }];
    }
    return [];
  }
}
