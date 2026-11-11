import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import {
  ANALYSIS_JSON_SCHEMA,
  rawAnalysisSchema,
  renderTranscript,
  resolveAnalysis,
  type MeetingAnalysis,
  type MeetingAnalysisInput,
} from "./analysis.js";
import { ANSWER_JSON_SCHEMA, rawAnswerSchema, renderExcerpts, resolveAnswer, type Answer, type AskInput } from "./ask.js";
import { ANALYSIS_SYSTEM_PROMPT, ASK_SYSTEM_PROMPT } from "./prompts.js";
import { LlmError, TranscriptTooLongError, type LlmProvider, type LlmResult } from "./provider.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
  /** Defaults to the SDK's own credential resolution (ANTHROPIC_API_KEY, `ant auth login` profile, ...). */
  client?: Anthropic;
  model?: string;
  /** Claude Opus 5.5 defaults to "medium" when unset; we always send it explicitly. */
  effort?: Effort;
  /**
   * Upper bound on transcript characters per analysis (~4 characters per
   * token; the default leaves ample room in a 1M-token context). Larger
   * transcripts fail with TranscriptTooLongError instead of being truncated.
   */
  maxTranscriptChars?: number;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Maps SDK errors to LlmError with a retry decision. Most-specific first. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new LlmError(`Anthropic credentials were rejected: ${error.message}`, false, error);
  }
  if (error instanceof Anthropic.RateLimitError) return new LlmError(`Anthropic rate limit: ${error.message}`, true, error);
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new LlmError(`Anthropic rejected the request: ${error.message}`, false, error);
  }
  if (error instanceof Anthropic.APIConnectionError) return new LlmError(`Could not reach Anthropic: ${error.message}`, true, error);
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new LlmError(`Anthropic API error ${status}: ${error.message}`, status >= 500 || status === 408 || status === 409, error);
  }
  // The SDK throws a plain Error when no credentials can be resolved at all.
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(message, false, error);
}

/**
 * Claude via the official SDK. Structured outputs (`output_config.format`)
 * constrain the JSON shape; results are re-validated with zod and refs are
 * resolved against the input, so nothing ungrounded gets through. Requests
 * stream (long transcripts, long outputs) and opt into server-side refusal
 * fallbacks.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly effort: Effort;
  private readonly maxTranscriptChars: number;
  private clientInstance: Anthropic | undefined;

  constructor(private readonly options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.effort = options.effort ?? "high";
    this.maxTranscriptChars = options.maxTranscriptChars ?? 2_000_000;
    this.clientInstance = options.client;
  }

  /** Created lazily so a process without credentials still starts; the first call reports the problem. */
  private get client(): Anthropic {
    this.clientInstance ??= new Anthropic();
    return this.clientInstance;
  }

  async analyzeMeeting(input: MeetingAnalysisInput): Promise<LlmResult<MeetingAnalysis>> {
    if (input.segments.length === 0) throw new LlmError("Meeting has no transcript to analyze", false);
    const transcript = renderTranscript(input.segments);
    if (transcript.length > this.maxTranscriptChars) throw new TranscriptTooLongError(transcript.length, this.maxTranscriptChars);
    const content = `<meeting_title>${input.title}</meeting_title>\n<transcript>\n${transcript}\n</transcript>`;
    const { data, model } = await this.structuredCall(ANALYSIS_SYSTEM_PROMPT, content, ANALYSIS_JSON_SCHEMA, rawAnalysisSchema);
    return { result: resolveAnalysis(data, input.segments), model };
  }

  async answerQuestion(input: AskInput): Promise<LlmResult<Answer>> {
    const content = `<excerpts>\n${renderExcerpts(input.excerpts) || "(no excerpts matched)"}\n</excerpts>\n<question>${input.question}</question>`;
    const { data, model } = await this.structuredCall(ASK_SYSTEM_PROMPT, content, ANSWER_JSON_SCHEMA, rawAnswerSchema);
    return { result: resolveAnswer(data, input.excerpts), model };
  }

  private async structuredCall<T>(
    system: string,
    userContent: string,
    jsonSchema: Record<string, unknown>,
    validator: z.ZodType<T>,
  ): Promise<{ data: T; model: string }> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: 64_000,
        betas: [FALLBACK_BETA],
        // If the model declines on policy grounds, the API retries on its default fallback model.
        fallbacks: "default",
        output_config: { effort: this.effort, format: { type: "json_schema", schema: jsonSchema } },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      });
      message = await stream.finalMessage();
    } catch (error) {
      throw toLlmError(error);
    }

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? "unspecified";
      throw new LlmError(`The model declined this request (refusal category: ${category})`, false);
    }
    if (message.stop_reason === "max_tokens") {
      throw new LlmError("The model's output was cut off at the token limit", false);
    }
    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new LlmError("The model returned output that is not valid JSON", true, error);
    }
    const parsed = validator.safeParse(json);
    if (!parsed.success) throw new LlmError(`The model's output did not match the expected shape: ${parsed.error.message}`, true);
    return { data: parsed.data, model: message.model };
  }
}
