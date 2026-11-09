import { randomUUID } from "node:crypto";
import { VadSegmenter } from "./vad.js";
import type { AsrAudioFrame, AsrEvent, AsrProvider, AsrSession } from "./types.js";

export interface TestDoubleAsrProviderOptions {
  /** Deterministic language to report — real language detection isn't implemented. */
  languageCode?: string;
  silenceRmsThreshold?: number;
  silenceDurationMsToEndSegment?: number;
}

/**
 * A deterministic stand-in for a real streaming ASR provider (Deepgram,
 * AssemblyAI, Google STT, etc. — none is selected/provisioned yet, see
 * ARCHITECTURE.md section 5). It does NOT transcribe speech: it runs real VAD
 * segmentation on the actual audio, then emits placeholder text that
 * unambiguously says so, so nothing downstream can mistake this for a real
 * transcript. Exists so the rest of the pipeline (WS event relay, UI,
 * eventually persistence) can be built and tested against a real interface
 * shape before a real provider is chosen.
 */
export class TestDoubleAsrProvider implements AsrProvider {
  readonly name = "test-double";

  constructor(private readonly options: TestDoubleAsrProviderOptions = {}) {}

  createSession(sessionOptions: { sourceTrack: string }): AsrSession {
    return new TestDoubleAsrSession(sessionOptions.sourceTrack, this.options);
  }
}

class TestDoubleAsrSession implements AsrSession {
  private readonly vad: VadSegmenter;
  private readonly languageCode: string;
  private listener: ((event: AsrEvent) => void) | null = null;
  private currentSegmentId: string | null = null;
  private currentSegmentStartMs = 0;
  private frameCountInSegment = 0;
  private sampleCountInSegment = 0;
  private languageAnnounced = false;

  constructor(
    private readonly sourceTrack: string,
    options: TestDoubleAsrProviderOptions,
  ) {
    this.vad = new VadSegmenter({
      silenceRmsThreshold: options.silenceRmsThreshold,
      silenceDurationMsToEndSegment: options.silenceDurationMsToEndSegment,
    });
    this.languageCode = options.languageCode ?? "en";
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.listener = callback;
  }

  private emit(event: AsrEvent): void {
    this.listener?.(event);
  }

  private placeholderText(endMs: number): string {
    const durationMs = endMs - this.currentSegmentStartMs;
    return `[test-double transcript — ${this.frameCountInSegment} chunk(s), ${this.sampleCountInSegment} samples, ${durationMs}ms of detected speech]`;
  }

  private announceLanguageOnce(): void {
    if (this.languageAnnounced) return;
    this.languageAnnounced = true;
    this.emit({
      type: "language_detected",
      sourceTrack: this.sourceTrack,
      languageCode: this.languageCode,
      confidence: 1,
    });
  }

  pushAudio(frame: AsrAudioFrame): void {
    const vadEvents = this.vad.pushFrame(frame);

    for (const vadEvent of vadEvents) {
      if (vadEvent.type === "segment_start") {
        this.currentSegmentId = randomUUID();
        this.currentSegmentStartMs = vadEvent.startMs;
        this.frameCountInSegment = 1;
        this.sampleCountInSegment = frame.samples.length;
        this.announceLanguageOnce();
        this.emit({
          type: "partial",
          segmentId: this.currentSegmentId,
          sourceTrack: this.sourceTrack,
          startMs: this.currentSegmentStartMs,
          endMs: frame.endMs,
          text: this.placeholderText(frame.endMs),
          languageCode: this.languageCode,
        });
      } else if (vadEvent.type === "segment_continue" && this.currentSegmentId) {
        this.frameCountInSegment += 1;
        this.sampleCountInSegment += frame.samples.length;
        this.emit({
          type: "partial",
          segmentId: this.currentSegmentId,
          sourceTrack: this.sourceTrack,
          startMs: this.currentSegmentStartMs,
          endMs: vadEvent.endMs,
          text: this.placeholderText(vadEvent.endMs),
          languageCode: this.languageCode,
        });
      } else if (vadEvent.type === "segment_end" && this.currentSegmentId) {
        this.emit({
          type: "final",
          segmentId: this.currentSegmentId,
          sourceTrack: this.sourceTrack,
          startMs: this.currentSegmentStartMs,
          endMs: vadEvent.endMs,
          text: this.placeholderText(vadEvent.endMs),
          languageCode: this.languageCode,
        });
        this.currentSegmentId = null;
      }
    }
  }

  finalize(): void {
    const flushed = this.vad.flush();
    for (const vadEvent of flushed) {
      if (vadEvent.type === "segment_end" && this.currentSegmentId) {
        this.emit({
          type: "final",
          segmentId: this.currentSegmentId,
          sourceTrack: this.sourceTrack,
          startMs: this.currentSegmentStartMs,
          endMs: vadEvent.endMs,
          text: this.placeholderText(vadEvent.endMs),
          languageCode: this.languageCode,
        });
        this.currentSegmentId = null;
      }
    }
  }
}
