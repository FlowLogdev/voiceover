import { z } from "zod";

export const insightKindSchema = z.enum(["decisions", "action-items", "questions", "risks", "commitments"]);
export type InsightKind = z.infer<typeof insightKindSchema>;

export const evidenceSchema = z.object({
  segmentId: z.string().uuid(),
  startMs: z.number().int(),
  /** Track to seek for playback; null if the segment no longer exists. */
  recordingTrackId: z.string().uuid().nullable(),
});
export type EvidenceDTO = z.infer<typeof evidenceSchema>;

const itemBase = {
  id: z.string().uuid(),
  text: z.string(),
  origin: z.enum(["AI", "USER"]),
  /** Edited by a person: kept as-is when the analysis is regenerated. */
  edited: z.boolean(),
  evidence: z.array(evidenceSchema),
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const decisionSchema = z.object(itemBase);
export const actionItemSchema = z.object({ ...itemBase, ownerName: z.string().nullable(), dueDate: isoDate.nullable(), isDone: z.boolean() });
export const questionSchema = z.object({ ...itemBase, isResolved: z.boolean() });
export const riskSchema = z.object({ ...itemBase, severity: z.enum(["low", "medium", "high"]).nullable() });
export const commitmentSchema = z.object({ ...itemBase, committedBy: z.string().nullable(), dueDate: isoDate.nullable(), isFulfilled: z.boolean() });

export const analysisRunSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETE", "FAILED"]),
  trigger: z.string(),
  provider: z.string().nullable(),
  modelName: z.string().nullable(),
  error: z.string().nullable(),
  droppedItemCount: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type AnalysisRunDTO = z.infer<typeof analysisRunSchema>;

export const meetingInsightsSchema = z.object({
  /** The most recent analysis run, whatever its state. */
  latestRun: analysisRunSchema.nullable(),
  summary: z
    .object({
      content: z.string(),
      keyPoints: z.array(z.string()),
      language: z.string().nullable(),
      modelName: z.string(),
      generatedAt: z.string().datetime(),
      edited: z.boolean(),
    })
    .nullable(),
  topics: z.array(z.object({ id: z.string().uuid(), title: z.string(), startMs: z.number().int(), endMs: z.number().int() })),
  decisions: z.array(decisionSchema),
  actionItems: z.array(actionItemSchema),
  questions: z.array(questionSchema),
  risks: z.array(riskSchema),
  commitments: z.array(commitmentSchema),
});
export type MeetingInsightsDTO = z.infer<typeof meetingInsightsSchema>;

/** Edit an insight. Only the fields that apply to its kind are accepted. */
export const updateInsightRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    ownerName: z.string().trim().max(200).nullable(),
    committedBy: z.string().trim().max(200).nullable(),
    dueDate: isoDate.nullable(),
    isDone: z.boolean(),
    isResolved: z.boolean(),
    isFulfilled: z.boolean(),
    severity: z.enum(["low", "medium", "high"]).nullable(),
  })
  .partial()
  .strict();
export type UpdateInsightRequest = z.infer<typeof updateInsightRequestSchema>;

export const updateSummaryRequestSchema = z.object({ content: z.string().trim().min(1).max(20_000) }).strict();

export const askRequestSchema = z.object({
  question: z.string().trim().min(3).max(500),
  /** Limit the search to one meeting; omit to search all of the organization's meetings. */
  meetingId: z.string().uuid().optional(),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

export const askResponseSchema = z.object({
  answer: z.string(),
  insufficientEvidence: z.boolean(),
  citations: z.array(
    z.object({
      meetingId: z.string().uuid(),
      meetingTitle: z.string(),
      segmentId: z.string().uuid(),
      startMs: z.number().int(),
      speaker: z.string(),
      text: z.string(),
    }),
  ),
  /** Null when no excerpts matched, so no model was called. */
  model: z.string().nullable(),
  retrievedExcerpts: z.number().int(),
});
export type AskResponse = z.infer<typeof askResponseSchema>;
