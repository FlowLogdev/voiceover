import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasAtLeastRole } from "@voiceover/auth";
import { enqueueMeetingAnalysis, forOrganization, prisma } from "@voiceover/database";
import {
  insightKindSchema,
  updateInsightRequestSchema,
  updateSummaryRequestSchema,
  type EvidenceDTO,
  type InsightKind,
  type MeetingInsightsDTO,
  type UpdateInsightRequest,
} from "@voiceover/types";
import { httpError } from "../http-error.js";
import { requireAuth, requireOrganization, type AuthContext } from "../plugins/auth-context.js";

const meetingParams = z.object({ organizationId: z.string().uuid(), meetingId: z.string().uuid() });
const itemParams = meetingParams.extend({ kind: insightKindSchema, itemId: z.string().uuid() });

/** Which edit fields each kind accepts. */
const EDITABLE: Record<InsightKind, Array<keyof UpdateInsightRequest>> = {
  decisions: ["text"],
  "action-items": ["text", "ownerName", "dueDate", "isDone"],
  questions: ["text", "isResolved"],
  risks: ["text", "severity"],
  commitments: ["text", "committedBy", "dueDate", "isFulfilled"],
};

function requireMember(auth: AuthContext, organizationId: string): void {
  const membership = requireOrganization(auth, organizationId);
  if (!hasAtLeastRole(membership.role, "MEMBER")) throw httpError(403, "Guests cannot change meeting insights");
}

async function requireMeeting(organizationId: string, meetingId: string): Promise<void> {
  const meeting = await forOrganization(organizationId).meeting.findFirst({
    where: { id: meetingId, deletedAt: null },
    select: { id: true },
  });
  if (!meeting) throw httpError(404, "Meeting not found");
}

const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
const toDate = (day: string | null | undefined) => (day === undefined ? undefined : day === null ? null : new Date(`${day}T00:00:00Z`));

interface ItemRow {
  id: string;
  text: string;
  origin: "AI" | "USER";
  editedAt: Date | null;
  evidenceSegmentIds: string[];
  createdAt: Date;
}

/**
 * AI meeting insights: read them (with evidence that links back to the
 * transcript and audio), queue a (re)analysis, and edit or delete items.
 * Edits mark an item as human-owned, so regeneration keeps it.
 */
export async function insightRoutes(fastify: FastifyInstance) {
  fastify.get("/organizations/:organizationId/meetings/:meetingId/insights", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireOrganization(auth, organizationId);
    await requireMeeting(organizationId, meetingId);

    const where = { meetingId };
    const [latestRun, summary, topics, decisions, actionItems, questions, risks, commitments] = await Promise.all([
      prisma.meetingAnalysisRun.findFirst({ where, orderBy: { createdAt: "desc" } }),
      prisma.summary.findFirst({ where: { meetingId, kind: "executive" }, orderBy: { generatedAt: "desc" } }),
      prisma.topic.findMany({ where, orderBy: { startMs: "asc" } }),
      prisma.decision.findMany({ where }),
      prisma.actionItem.findMany({ where }),
      prisma.question.findMany({ where }),
      prisma.risk.findMany({ where }),
      prisma.commitment.findMany({ where }),
    ]);

    const segmentIds = [...new Set([decisions, actionItems, questions, risks, commitments].flat().flatMap((i) => i.evidenceSegmentIds))];
    const segments = await prisma.transcriptSegment.findMany({
      where: { id: { in: segmentIds }, meetingId },
      select: { id: true, startMs: true, recordingTrackId: true },
    });
    const bySegment = new Map(segments.map((s) => [s.id, s]));
    const evidence = (ids: string[]): EvidenceDTO[] =>
      ids
        .map((id) => bySegment.get(id))
        .filter((s): s is NonNullable<typeof s> => s !== undefined)
        .map((s) => ({ segmentId: s.id, startMs: s.startMs, recordingTrackId: s.recordingTrackId }))
        .sort((a, b) => a.startMs - b.startMs);
    // In meeting order (by first evidence), user-created items without evidence last.
    const ordered = <T extends ItemRow>(rows: T[]) =>
      rows
        .map((row) => ({ row, ev: evidence(row.evidenceSegmentIds) }))
        .sort((a, b) => (a.ev[0]?.startMs ?? Infinity) - (b.ev[0]?.startMs ?? Infinity) || a.row.createdAt.getTime() - b.row.createdAt.getTime());
    const base = (row: ItemRow, ev: EvidenceDTO[]) => ({ id: row.id, text: row.text, origin: row.origin, edited: row.editedAt !== null, evidence: ev });

    const response: MeetingInsightsDTO = {
      latestRun: latestRun && {
        id: latestRun.id,
        status: latestRun.status,
        trigger: latestRun.trigger,
        provider: latestRun.provider,
        modelName: latestRun.modelName,
        error: latestRun.error,
        droppedItemCount: latestRun.droppedItemCount,
        createdAt: latestRun.createdAt.toISOString(),
        completedAt: latestRun.completedAt?.toISOString() ?? null,
      },
      summary: summary && {
        content: summary.content,
        keyPoints: summary.keyPoints,
        language: summary.language,
        modelName: summary.modelName,
        generatedAt: summary.generatedAt.toISOString(),
        edited: summary.editedAt !== null,
      },
      topics: topics.map((t) => ({ id: t.id, title: t.title, startMs: t.startMs, endMs: t.endMs })),
      decisions: ordered(decisions).map(({ row, ev }) => base(row, ev)),
      actionItems: ordered(actionItems).map(({ row, ev }) => ({
        ...base(row, ev),
        ownerName: row.ownerName,
        dueDate: isoDay(row.dueDate),
        isDone: row.isDone,
      })),
      questions: ordered(questions).map(({ row, ev }) => ({ ...base(row, ev), isResolved: row.isResolved })),
      risks: ordered(risks).map(({ row, ev }) => ({
        ...base(row, ev),
        severity: row.severity === "low" || row.severity === "medium" || row.severity === "high" ? row.severity : null,
      })),
      commitments: ordered(commitments).map(({ row, ev }) => ({
        ...base(row, ev),
        committedBy: row.committedBy,
        dueDate: isoDay(row.dueDate),
        isFulfilled: row.isFulfilled,
      })),
    };
    return response;
  });

  // Queue a (re)analysis; the worker runs it. 202 + run id, or 409 with the run already in flight.
  fastify.post("/organizations/:organizationId/meetings/:meetingId/analysis", async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireMember(auth, organizationId);
    await requireMeeting(organizationId, meetingId);
    const result = await enqueueMeetingAnalysis({ meetingId, trigger: "manual", requestedByUserId: auth.userId });
    if (result.enqueued) return reply.status(202).send({ runId: result.runId });
    if (result.reason === "already_queued") {
      return reply.status(409).send({ error: "An analysis of this meeting is already queued or running", runId: result.runId });
    }
    throw httpError(400, "This meeting has no transcript to analyze yet");
  });

  fastify.patch("/organizations/:organizationId/meetings/:meetingId/summary", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireMember(auth, organizationId);
    await requireMeeting(organizationId, meetingId);
    const { content } = updateSummaryRequestSchema.parse(request.body);
    const existing = await prisma.summary.findFirst({ where: { meetingId, kind: "executive" }, orderBy: { generatedAt: "desc" } });
    if (!existing) throw httpError(404, "This meeting has no summary yet");
    await prisma.summary.update({ where: { id: existing.id }, data: { content, editedAt: new Date() } });
    return { ok: true };
  });

  fastify.patch("/organizations/:organizationId/meetings/:meetingId/insights/:kind/:itemId", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId, kind, itemId } = itemParams.parse(request.params);
    requireMember(auth, organizationId);
    await requireMeeting(organizationId, meetingId);
    const body = updateInsightRequestSchema.parse(request.body);
    const fields = Object.keys(body) as Array<keyof UpdateInsightRequest>;
    if (fields.length === 0) throw httpError(400, "Nothing to update");
    const invalid = fields.filter((f) => !EDITABLE[kind].includes(f));
    if (invalid.length > 0) throw httpError(400, `${kind} do not have: ${invalid.join(", ")}`);

    const where = { id: itemId, meetingId };
    const editedAt = new Date();
    let count: number;
    switch (kind) {
      case "decisions":
        ({ count } = await prisma.decision.updateMany({ where, data: { text: body.text, editedAt } }));
        break;
      case "action-items":
        ({ count } = await prisma.actionItem.updateMany({
          where,
          data: { text: body.text, ownerName: body.ownerName, dueDate: toDate(body.dueDate), isDone: body.isDone, editedAt },
        }));
        break;
      case "questions":
        ({ count } = await prisma.question.updateMany({ where, data: { text: body.text, isResolved: body.isResolved, editedAt } }));
        break;
      case "risks":
        ({ count } = await prisma.risk.updateMany({ where, data: { text: body.text, severity: body.severity, editedAt } }));
        break;
      case "commitments":
        ({ count } = await prisma.commitment.updateMany({
          where,
          data: { text: body.text, committedBy: body.committedBy, dueDate: toDate(body.dueDate), isFulfilled: body.isFulfilled, editedAt },
        }));
        break;
    }
    if (count === 0) throw httpError(404, "Item not found");
    return { ok: true };
  });

  fastify.delete("/organizations/:organizationId/meetings/:meetingId/insights/:kind/:itemId", async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId, kind, itemId } = itemParams.parse(request.params);
    requireMember(auth, organizationId);
    await requireMeeting(organizationId, meetingId);
    const where = { id: itemId, meetingId };
    const { count } = await {
      decisions: () => prisma.decision.deleteMany({ where }),
      "action-items": () => prisma.actionItem.deleteMany({ where }),
      questions: () => prisma.question.deleteMany({ where }),
      risks: () => prisma.risk.deleteMany({ where }),
      commitments: () => prisma.commitment.deleteMany({ where }),
    }[kind]();
    if (count === 0) throw httpError(404, "Item not found");
    return reply.status(204).send();
  });
}
