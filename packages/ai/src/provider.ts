import type { MeetingAnalysis, MeetingAnalysisInput } from "./analysis.js";
import type { Answer, AskInput } from "./ask.js";

export interface LlmResult<T> {
  result: T;
  /** The model that actually produced the output (may be a server-side fallback). */
  model: string;
}

/**
 * Provider-agnostic meeting intelligence contract (ARCHITECTURE.md
 * section 5). Callers never see prompts or provider SDK types.
 */
export interface LlmProvider {
  readonly name: string;
  analyzeMeeting(input: MeetingAnalysisInput): Promise<LlmResult<MeetingAnalysis>>;
  answerQuestion(input: AskInput): Promise<LlmResult<Answer>>;
}

/** Base class for LLM failures; `retryable` says whether trying again later could help. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** The input is too large to send in one request. Never silently truncated. */
export class TranscriptTooLongError extends LlmError {
  constructor(characters: number, limit: number) {
    super(`Transcript is ${characters.toLocaleString("en-US")} characters; the limit for one analysis is ${limit.toLocaleString("en-US")}`, false);
    this.name = "TranscriptTooLongError";
  }
}
