import { z } from "zod";

/**
 * One transcript segment as the model sees it. `ref` ("S1", "S2", ...) is
 * the only handle the model may cite; it's mapped back to the real segment
 * id afterwards, so a hallucinated reference simply doesn't resolve.
 */
export interface AnalysisSegment {
  ref: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
}

export interface MeetingAnalysisInput {
  title: string;
  segments: AnalysisSegment[];
}

const evidence = z.array(z.string()).describe("Refs (e.g. \"S12\") of the transcript lines that support this item");
const nullableString = z.string().nullable();

/** What the model must return (validated after parsing; mirrored by ANALYSIS_JSON_SCHEMA). */
export const rawAnalysisSchema = z.object({
  language: z.string(),
  executiveSummary: z.string(),
  keyPoints: z.array(z.string()),
  topics: z.array(z.object({ title: z.string(), firstSegment: z.string(), lastSegment: z.string() })),
  decisions: z.array(z.object({ text: z.string(), evidence })),
  actionItems: z.array(z.object({ text: z.string(), owner: nullableString, dueDate: nullableString, evidence })),
  openQuestions: z.array(z.object({ text: z.string(), resolved: z.boolean(), evidence })),
  risks: z.array(z.object({ text: z.string(), severity: z.enum(["low", "medium", "high"]), evidence })),
  commitments: z.array(z.object({ text: z.string(), committedBy: nullableString, dueDate: nullableString, evidence })),
});
export type RawAnalysis = z.infer<typeof rawAnalysisSchema>;

// --- JSON schema for structured outputs (every object closed, every key required) ---
const str = { type: "string" } as const;
const strOrNull = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const refs = {
  type: "array",
  items: { type: "string" },
  description: 'Refs of the transcript lines that support this item, e.g. ["S12", "S13"]. At least one.',
} as const;
function closed(properties: Record<string, unknown>) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false } as const;
}
function list(item: Record<string, unknown>) {
  return { type: "array", items: closed(item) } as const;
}

export const ANALYSIS_JSON_SCHEMA = closed({
  language: { ...str, description: "BCP-47 code of the language the summary is written in, e.g. en, es, pt" },
  executiveSummary: { ...str, description: "3-6 sentence summary of the meeting" },
  keyPoints: { type: "array", items: str },
  topics: list({ title: str, firstSegment: str, lastSegment: str }),
  decisions: list({ text: str, evidence: refs }),
  actionItems: list({ text: str, owner: strOrNull, dueDate: { ...strOrNull, description: "YYYY-MM-DD, only if stated" }, evidence: refs }),
  openQuestions: list({ text: str, resolved: { type: "boolean" }, evidence: refs }),
  risks: list({ text: str, severity: { type: "string", enum: ["low", "medium", "high"] }, evidence: refs }),
  commitments: list({ text: str, committedBy: strOrNull, dueDate: { ...strOrNull, description: "YYYY-MM-DD, only if stated" }, evidence: refs }),
});

// --- Resolved analysis: refs mapped to real segments, unsupported items dropped ---
export interface Evidence {
  segmentId: string;
  startMs: number;
}
interface Item {
  text: string;
  evidence: Evidence[];
}

export interface MeetingAnalysis {
  language: string;
  executiveSummary: string;
  keyPoints: string[];
  topics: Array<{ title: string; startMs: number; endMs: number }>;
  decisions: Item[];
  actionItems: Array<Item & { owner: string | null; dueDate: string | null }>;
  openQuestions: Array<Item & { resolved: boolean }>;
  risks: Array<Item & { severity: "low" | "medium" | "high" }>;
  commitments: Array<Item & { committedBy: string | null; dueDate: string | null }>;
  /** Items discarded because none of their cited refs exist in the transcript. */
  droppedUnsupportedItems: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: string | null): string | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}
function clean(text: string | null): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Maps the model's refs back to segments. Every insight must be grounded:
 * an item none of whose refs resolve is dropped (and counted) rather than
 * shown without evidence.
 */
export function resolveAnalysis(raw: RawAnalysis, segments: AnalysisSegment[]): MeetingAnalysis {
  const byRef = new Map(segments.map((s) => [s.ref.toUpperCase(), s]));
  let dropped = 0;
  const resolveRefs = (refs: string[]): Evidence[] => {
    const seen = new Set<string>();
    const out: Evidence[] = [];
    for (const ref of refs) {
      const segment = byRef.get(ref.trim().toUpperCase());
      if (segment && !seen.has(segment.segmentId)) {
        seen.add(segment.segmentId);
        out.push({ segmentId: segment.segmentId, startMs: segment.startMs });
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  };
  function grounded<T extends { text: string; evidence: string[] }, R>(items: T[], map: (item: T, evidence: Evidence[]) => R): R[] {
    const out: R[] = [];
    for (const item of items) {
      const ev = resolveRefs(item.evidence);
      if (ev.length === 0 || !item.text.trim()) {
        dropped++;
        continue;
      }
      out.push(map(item, ev));
    }
    return out;
  }

  const topics = raw.topics.flatMap((topic) => {
    const first = byRef.get(topic.firstSegment.trim().toUpperCase());
    const last = byRef.get(topic.lastSegment.trim().toUpperCase());
    if (!first || !last || !topic.title.trim()) {
      dropped++;
      return [];
    }
    return [{ title: topic.title.trim(), startMs: Math.min(first.startMs, last.startMs), endMs: Math.max(first.endMs, last.endMs) }];
  });

  return {
    language: raw.language.trim() || "und",
    executiveSummary: raw.executiveSummary.trim(),
    keyPoints: raw.keyPoints.map((p) => p.trim()).filter(Boolean),
    topics: topics.sort((a, b) => a.startMs - b.startMs),
    decisions: grounded(raw.decisions, (d, ev) => ({ text: d.text.trim(), evidence: ev })),
    actionItems: grounded(raw.actionItems, (a, ev) => ({
      text: a.text.trim(),
      owner: clean(a.owner),
      dueDate: validDate(a.dueDate),
      evidence: ev,
    })),
    openQuestions: grounded(raw.openQuestions, (q, ev) => ({ text: q.text.trim(), resolved: q.resolved, evidence: ev })),
    risks: grounded(raw.risks, (r, ev) => ({ text: r.text.trim(), severity: r.severity, evidence: ev })),
    commitments: grounded(raw.commitments, (c, ev) => ({
      text: c.text.trim(),
      committedBy: clean(c.committedBy),
      dueDate: validDate(c.dueDate),
      evidence: ev,
    })),
    droppedUnsupportedItems: dropped,
  };
}

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** One line per segment: `[S12 0:03:14 Maria] text`. Newlines inside text are flattened so refs stay unambiguous. */
export function renderTranscript(segments: AnalysisSegment[]): string {
  return segments
    .map((s) => `[${s.ref} ${formatTimestamp(s.startMs)} ${s.speaker.replace(/[\]\n]/g, " ")}] ${s.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}
