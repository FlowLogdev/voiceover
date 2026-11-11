import { z } from "zod";

/** A retrieved transcript excerpt offered to the model as possible evidence. `ref` is "E1", "E2", ... */
export interface AskExcerpt {
  ref: string;
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string | null;
  startMs: number;
  speaker: string;
  text: string;
}

export interface AskInput {
  question: string;
  excerpts: AskExcerpt[];
}

export const rawAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(z.string()),
  insufficientEvidence: z.boolean(),
});
export type RawAnswer = z.infer<typeof rawAnswerSchema>;

export const ANSWER_JSON_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The answer, in the language of the question" },
    citations: {
      type: "array",
      items: { type: "string" },
      description: 'Refs of the excerpts the answer relies on, e.g. ["E3", "E7"]',
    },
    insufficientEvidence: { type: "boolean", description: "True if the excerpts don't contain the answer" },
  },
  required: ["answer", "citations", "insufficientEvidence"],
  additionalProperties: false,
} as const;

export interface Answer {
  answer: string;
  /** Only excerpts that were actually offered; unknown refs are discarded. */
  citations: AskExcerpt[];
  insufficientEvidence: boolean;
}

export function resolveAnswer(raw: RawAnswer, excerpts: AskExcerpt[]): Answer {
  const byRef = new Map(excerpts.map((e) => [e.ref.toUpperCase(), e]));
  const seen = new Set<string>();
  const citations: AskExcerpt[] = [];
  for (const ref of raw.citations) {
    const excerpt = byRef.get(ref.trim().toUpperCase());
    if (excerpt && !seen.has(excerpt.ref)) {
      seen.add(excerpt.ref);
      citations.push(excerpt);
    }
  }
  // An answer that claims support but cites nothing real is not supported.
  const insufficientEvidence = raw.insufficientEvidence || citations.length === 0;
  return { answer: raw.answer.trim(), citations, insufficientEvidence };
}

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function renderExcerpts(excerpts: AskExcerpt[]): string {
  return excerpts
    .map(
      (e) =>
        `[${e.ref}] Meeting "${e.meetingTitle.replace(/["\n]/g, " ")}"${e.meetingDate ? ` (${e.meetingDate})` : ""} at ${formatTimestamp(e.startMs)}, ${e.speaker.replace(/\n/g, " ")}: ${e.text.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");
}
