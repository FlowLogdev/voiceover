import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_JSON_SCHEMA,
  ANSWER_JSON_SCHEMA,
  AnthropicProvider,
  createLlmProvider,
  LlmError,
  renderTranscript,
  resolveAnalysis,
  resolveAnswer,
  TestDoubleLlmProvider,
  toLlmError,
  TranscriptTooLongError,
  type AnalysisSegment,
  type AskExcerpt,
  type RawAnalysis,
} from "./index.js";

const segments: AnalysisSegment[] = [
  { ref: "S1", segmentId: "seg-a", startMs: 0, endMs: 4_000, speaker: "Maria", text: "Let's ship on Friday." },
  { ref: "S2", segmentId: "seg-b", startMs: 4_000, endMs: 9_000, speaker: "João", text: "I'll write the release notes\nby Thursday." },
  { ref: "S3", segmentId: "seg-c", startMs: 9_000, endMs: 12_000, speaker: "Maria", text: "Risk: the vendor API is flaky." },
];

function raw(overrides: Partial<RawAnalysis> = {}): RawAnalysis {
  return {
    language: "en",
    executiveSummary: " Release planning. ",
    keyPoints: ["Ship Friday", " "],
    topics: [{ title: "Release", firstSegment: "s1", lastSegment: "S3" }],
    decisions: [{ text: "Ship on Friday", evidence: ["S1"] }],
    actionItems: [{ text: "Write release notes", owner: " João ", dueDate: "2026-11-12", evidence: ["S2", "S2", "S99"] }],
    openQuestions: [],
    risks: [{ text: "Vendor API flaky", severity: "medium", evidence: ["S3"] }],
    commitments: [{ text: "Notes by Thursday", committedBy: null, dueDate: "Thursday", evidence: ["S2"] }],
    ...overrides,
  };
}

describe("resolveAnalysis", () => {
  it("maps refs to segments, dedupes evidence, trims text, and keeps only valid ISO dates", () => {
    const result = resolveAnalysis(raw(), segments);
    expect(result.executiveSummary).toBe("Release planning.");
    expect(result.keyPoints).toEqual(["Ship Friday"]);
    expect(result.topics).toEqual([{ title: "Release", startMs: 0, endMs: 12_000 }]);
    expect(result.decisions).toEqual([{ text: "Ship on Friday", evidence: [{ segmentId: "seg-a", startMs: 0 }] }]);
    expect(result.actionItems[0]).toEqual({
      text: "Write release notes",
      owner: "João",
      dueDate: "2026-11-12",
      evidence: [{ segmentId: "seg-b", startMs: 4_000 }],
    });
    expect(result.commitments[0]!.dueDate).toBeNull(); // "Thursday" isn't a date
    expect(result.droppedUnsupportedItems).toBe(0);
  });

  it("drops items whose evidence doesn't exist in the transcript, and counts them", () => {
    const result = resolveAnalysis(
      raw({
        decisions: [
          { text: "Invented decision", evidence: ["S42"] },
          { text: "No evidence at all", evidence: [] },
          { text: "Grounded", evidence: ["S1"] },
        ],
        topics: [{ title: "Ghost topic", firstSegment: "S7", lastSegment: "S8" }],
        actionItems: [{ text: "x", owner: null, dueDate: "2026-02-30", evidence: ["S1"] }],
      }),
      segments,
    );
    expect(result.decisions.map((d) => d.text)).toEqual(["Grounded"]);
    expect(result.topics).toEqual([]);
    expect(result.actionItems[0]!.dueDate).toBeNull(); // Feb 30 isn't a real date
    expect(result.droppedUnsupportedItems).toBe(3);
  });
});

describe("structured-output JSON schemas", () => {
  /** Structured outputs need every object closed with all keys required. */
  function assertClosed(schema: unknown, path = "$"): void {
    if (!schema || typeof schema !== "object") return;
    const node = schema as Record<string, unknown>;
    if (node.type === "object") {
      expect(node.additionalProperties, path).toBe(false);
      expect([...(node.required as string[])].sort(), path).toEqual(Object.keys(node.properties as object).sort());
    }
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) value.forEach((v, i) => assertClosed(v, `${path}.${key}[${i}]`));
      else assertClosed(value, `${path}.${key}`);
    }
  }
  it("closes every object and requires every key", () => {
    assertClosed(ANALYSIS_JSON_SCHEMA);
    assertClosed(ANSWER_JSON_SCHEMA);
  });
});

describe("renderTranscript", () => {
  it("renders one ref-tagged line per segment, flattening newlines so refs stay unambiguous", () => {
    expect(renderTranscript(segments).split("\n")).toEqual([
      "[S1 0:00:00 Maria] Let's ship on Friday.",
      "[S2 0:00:04 João] I'll write the release notes by Thursday.",
      "[S3 0:00:09 Maria] Risk: the vendor API is flaky.",
    ]);
  });
});

const excerpts: AskExcerpt[] = [
  { ref: "E1", segmentId: "seg-a", meetingId: "m1", meetingTitle: "Weekly", meetingDate: "2026-11-01", startMs: 0, speaker: "Maria", text: "Ship Friday" },
  { ref: "E2", segmentId: "seg-b", meetingId: "m1", meetingTitle: "Weekly", meetingDate: "2026-11-01", startMs: 4_000, speaker: "João", text: "Notes" },
];

describe("resolveAnswer", () => {
  it("keeps only offered excerpts as citations, and treats an uncited answer as unsupported", () => {
    expect(resolveAnswer({ answer: " Friday. ", citations: ["e1", "E9", "E1"], insufficientEvidence: false }, excerpts)).toEqual({
      answer: "Friday.",
      citations: [excerpts[0]],
      insufficientEvidence: false,
    });
    expect(resolveAnswer({ answer: "Probably Friday", citations: ["E9"], insufficientEvidence: false }, excerpts).insufficientEvidence).toBe(true);
  });
});

/** A stand-in for the SDK client: records the request, returns a canned message. */
function fakeClient(message: Partial<Anthropic.Beta.BetaMessage> | Error) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            finalMessage: async () => {
              if (message instanceof Error) throw message;
              return { model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, content: [], ...message };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function textMessage(value: unknown, extra: Partial<Anthropic.Beta.BetaMessage> = {}): Partial<Anthropic.Beta.BetaMessage> {
  return {
    content: [
      { type: "thinking", thinking: "", signature: "x" } as unknown as Anthropic.Beta.BetaContentBlock,
      { type: "text", text: JSON.stringify(value), citations: null } as Anthropic.Beta.BetaTextBlock,
    ],
    ...extra,
  };
}

describe("AnthropicProvider", () => {
  it("sends a streamed structured-output request with fallbacks, explicit effort and a cacheable system prompt", async () => {
    const { client, calls } = fakeClient(textMessage(raw(), { model: "claude-opus-5-5" }));
    const provider = new AnthropicProvider({ client });
    const { result, model } = await provider.analyzeMeeting({ title: "Release sync", segments });

    expect(model).toBe("claude-opus-5-5");
    expect(result.decisions).toHaveLength(1);
    const request = calls[0]!;
    expect(request).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 64_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: ANALYSIS_JSON_SCHEMA } },
    });
    expect(request).not.toHaveProperty("thinking"); // adaptive by default on this model
    expect(request.system).toEqual([expect.objectContaining({ type: "text", cache_control: { type: "ephemeral" } })]);
    const content = (request.messages as Array<{ content: string }>)[0]!.content;
    expect(content).toContain("<meeting_title>Release sync</meeting_title>");
    expect(content).toContain("[S2 0:00:04 João] I'll write the release notes by Thursday.");
  });

  it("reports the model that actually answered (e.g. a server-side fallback)", async () => {
    const { client } = fakeClient(textMessage({ answer: "Friday", citations: ["E1"], insufficientEvidence: false }, { model: "claude-opus-4-8" }));
    const { model, result } = await new AnthropicProvider({ client }).answerQuestion({ question: "When?", excerpts });
    expect(model).toBe("claude-opus-4-8");
    expect(result.citations.map((c) => c.ref)).toEqual(["E1"]);
  });

  it("turns refusals, truncation and malformed output into LlmErrors with the right retry decision", async () => {
    const cases: Array<[Partial<Anthropic.Beta.BetaMessage>, RegExp, boolean]> = [
      [{ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as Anthropic.Beta.BetaRefusalStopDetails }, /declined.*cyber/, false],
      [{ ...textMessage(raw()), stop_reason: "max_tokens" }, /cut off/, false],
      [{ content: [{ type: "text", text: "not json", citations: null } as Anthropic.Beta.BetaTextBlock] }, /not valid JSON/, true],
      [textMessage({ executiveSummary: 1 }), /expected shape/, true],
    ];
    for (const [message, pattern, retryable] of cases) {
      const { client } = fakeClient(message);
      const error = await new AnthropicProvider({ client }).analyzeMeeting({ title: "t", segments }).catch((e) => e);
      expect(error).toBeInstanceOf(LlmError);
      expect(error.message).toMatch(pattern);
      expect(error.retryable).toBe(retryable);
    }
  });

  it("refuses to send an over-long transcript instead of truncating it, and rejects an empty one", async () => {
    const { client, calls } = fakeClient(textMessage(raw()));
    const provider = new AnthropicProvider({ client, maxTranscriptChars: 50 });
    await expect(provider.analyzeMeeting({ title: "t", segments })).rejects.toBeInstanceOf(TranscriptTooLongError);
    await expect(provider.analyzeMeeting({ title: "t", segments: [] })).rejects.toThrow(/no transcript/);
    expect(calls).toHaveLength(0);
  });

  it("classifies SDK errors: retry rate limits, server errors and connection failures; not bad requests or auth", () => {
    const headers = new Headers();
    expect(toLlmError(new Anthropic.RateLimitError(429, {}, "slow down", headers)).retryable).toBe(true);
    expect(toLlmError(new Anthropic.InternalServerError(529, {}, "overloaded", headers)).retryable).toBe(true);
    expect(toLlmError(new Anthropic.APIConnectionError({ message: "reset" })).retryable).toBe(true);
    expect(toLlmError(new Anthropic.BadRequestError(400, {}, "bad", headers)).retryable).toBe(false);
    expect(toLlmError(new Anthropic.AuthenticationError(401, {}, "no key", headers)).retryable).toBe(false);
  });
});

describe("provider selection and the test double", () => {
  it("defaults to the test double, builds Anthropic on request, and refuses unknown providers", () => {
    expect(createLlmProvider({}).name).toBe("test-double");
    expect(createLlmProvider({ provider: "anthropic", effort: "medium" }).name).toBe("anthropic");
    expect(() => createLlmProvider({ provider: "openai" })).toThrow(/no adapter/);
    expect(() => createLlmProvider({ provider: "anthropic", effort: "turbo" })).toThrow(/LLM_EFFORT/);
  });

  it("produces clearly labelled, grounded placeholder output", async () => {
    const llm = new TestDoubleLlmProvider();
    const { result } = await llm.analyzeMeeting({ title: "Release sync", segments });
    expect(result.executiveSummary).toMatch(/^\[test-double analysis/);
    expect(result.actionItems[0]!.evidence).toEqual([{ segmentId: "seg-a", startMs: 0 }]);
    const answer = await llm.answerQuestion({ question: "When?", excerpts: [] });
    expect(answer.result.insufficientEvidence).toBe(true);
  });
});
