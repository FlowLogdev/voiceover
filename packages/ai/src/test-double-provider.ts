import { resolveAnalysis, type MeetingAnalysis, type MeetingAnalysisInput } from "./analysis.js";
import { resolveAnswer, type Answer, type AskInput } from "./ask.js";
import { LlmError, type LlmProvider, type LlmResult } from "./provider.js";

/**
 * Deterministic stand-in for a real LLM: no network, no cost. Its output says
 * plainly that it's placeholder text, but it goes through the same
 * resolution path as a real response (it cites real refs), so everything
 * downstream (persistence, evidence links, editing, regeneration) is real.
 */
export class TestDoubleLlmProvider implements LlmProvider {
  readonly name = "test-double";
  readonly model = "test-double";

  async analyzeMeeting(input: MeetingAnalysisInput): Promise<LlmResult<MeetingAnalysis>> {
    const segments = input.segments;
    if (segments.length === 0) throw new LlmError("Meeting has no transcript to analyze", false);
    const first = segments[0]!;
    const last = segments[segments.length - 1]!;
    const speakers = [...new Set(segments.map((s) => s.speaker))];
    const raw = {
      language: "en",
      executiveSummary: `[test-double analysis: no language model was called] "${input.title}" has ${segments.length} transcript segment(s) from ${speakers.length} speaker(s).`,
      keyPoints: [`[test-double] First line: ${first.text.slice(0, 120)}`],
      topics: [{ title: "[test-double] Whole meeting", firstSegment: first.ref, lastSegment: last.ref }],
      decisions: [],
      actionItems: [{ text: `[test-double] Review the transcript of "${input.title}"`, owner: null, dueDate: null, evidence: [first.ref] }],
      openQuestions: [],
      risks: [],
      commitments: [],
    };
    return { result: resolveAnalysis(raw, segments), model: this.model };
  }

  async answerQuestion(input: AskInput): Promise<LlmResult<Answer>> {
    const cited = input.excerpts.slice(0, 2);
    const raw = {
      answer:
        cited.length > 0
          ? `[test-double answer: no language model was called] ${input.excerpts.length} excerpt(s) matched "${input.question}". The top match: "${cited[0]!.text.slice(0, 160)}"`
          : `[test-double answer: no language model was called] No transcript excerpts matched "${input.question}".`,
      citations: cited.map((e) => e.ref),
      insufficientEvidence: cited.length === 0,
    };
    return { result: resolveAnswer(raw, input.excerpts), model: this.model };
  }
}
