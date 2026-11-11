import { LlmError, type AnalysisSegment, type LlmProvider, type MeetingAnalysis } from "@voiceover/ai";
import { prisma } from "@voiceover/database";
import { retryDelayMs, type ClaimScope } from "./finalizer.js";

export interface AnalysisRunnerOptions {
  llm: LlmProvider;
  now?: () => Date;
  /** LLM calls on long meetings can take minutes; the lease must outlast one. */
  leaseMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
}

export type AnalysisOutcome =
  | { runId: string; status: "COMPLETE" }
  | { runId: string; status: "RETRY"; error: string; retryAt: Date }
  | { runId: string; status: "FAILED"; error: string }
  | { runId: string; status: "LEASE_LOST" };

class LeaseLostError extends Error {}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Runs queued meeting analyses (MeetingAnalysisRun) through the configured
 * LLM provider and stores the results. Claimed with a lease in Postgres like
 * recording finalization; the final write is fenced on (status, attempts),
 * so a worker whose lease expired mid-call can't overwrite the run another
 * worker took over.
 *
 * Regeneration never destroys human work: AI items nobody edited are
 * replaced; edited or user-created items are kept, and a new AI item whose
 * text matches a kept one is skipped.
 */
export class AnalysisRunner {
  private readonly llm: LlmProvider;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly log: NonNullable<AnalysisRunnerOptions["log"]>;

  constructor(options: AnalysisRunnerOptions) {
    this.llm = options.llm;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 15 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 60_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30 * 60_000;
    this.log = options.log ?? ((level, message, error) => console[level](message, error ?? ""));
  }

  async claimNext(scope: ClaimScope & { runIds?: string[] } = {}): Promise<{ runId: string; attempts: number } | null> {
    const now = this.now();
    const candidates = await prisma.meetingAnalysisRun.findMany({
      where: {
        ...(scope.runIds ? { id: { in: scope.runIds } } : {}),
        OR: [
          { status: "PENDING", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
          { status: "RUNNING", lockedUntil: { lt: now } }, // a crashed worker's run
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 10,
      select: { id: true, status: true, lockedUntil: true, attempts: true },
    });
    for (const c of candidates) {
      const claimed = await prisma.meetingAnalysisRun.updateMany({
        where: { id: c.id, status: c.status, lockedUntil: c.lockedUntil, attempts: c.attempts },
        data: {
          status: "RUNNING",
          lockedUntil: new Date(now.getTime() + this.leaseMs),
          attempts: c.attempts + 1,
          startedAt: now,
        },
      });
      if (claimed.count === 1) return { runId: c.id, attempts: c.attempts + 1 };
    }
    return null;
  }

  async runOnce(scope: { runIds?: string[] } = {}): Promise<AnalysisOutcome[]> {
    const outcomes: AnalysisOutcome[] = [];
    for (let claim = await this.claimNext(scope); claim; claim = await this.claimNext(scope)) {
      outcomes.push(await this.runClaimed(claim.runId, claim.attempts));
    }
    return outcomes;
  }

  async runClaimed(runId: string, attempts: number): Promise<AnalysisOutcome> {
    try {
      const run = await prisma.meetingAnalysisRun.findUniqueOrThrow({
        where: { id: runId },
        select: { meetingId: true, meeting: { select: { title: true } } },
      });
      const rows = await prisma.transcriptSegment.findMany({
        where: { meetingId: run.meetingId, isFinal: true },
        orderBy: [{ startMs: "asc" }, { createdAt: "asc" }],
        select: { id: true, startMs: true, endMs: true, text: true, speaker: { select: { label: true, displayName: true } } },
      });
      const segments: AnalysisSegment[] = rows.map((row, i) => ({
        ref: `S${i + 1}`,
        segmentId: row.id,
        startMs: row.startMs,
        endMs: row.endMs,
        speaker: row.speaker?.displayName ?? row.speaker?.label ?? "Unknown speaker",
        text: row.text,
      }));
      if (segments.length === 0) throw new LlmError("Meeting has no transcript to analyze", false);

      const { result, model } = await this.llm.analyzeMeeting({ title: run.meeting.title, segments });
      await this.store(runId, attempts, run.meetingId, result, model, segments.length);
      this.log("info", `Analysis ${runId} complete (${model})`);
      return { runId, status: "COMPLETE" };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.log("warn", `Analysis ${runId}: lease lost to another worker; discarding this result`);
        return { runId, status: "LEASE_LOST" };
      }
      return this.fail(runId, attempts, error);
    }
  }

  private async fail(runId: string, attempts: number, error: unknown): Promise<AnalysisOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    // LLM errors say whether a retry can help; anything else (DB blips, I/O) is assumed transient.
    const retryable = error instanceof LlmError ? error.retryable : true;
    const fence = { id: runId, status: "RUNNING" as const, attempts };
    if (!retryable || attempts >= this.maxAttempts) {
      const reason = retryable ? `Failed after ${attempts} attempts: ${message}` : message;
      await prisma.meetingAnalysisRun.updateMany({
        where: fence,
        data: { status: "FAILED", error: reason, lockedUntil: null, completedAt: this.now() },
      });
      this.log("error", `Analysis ${runId} failed`, error);
      return { runId, status: "FAILED", error: reason };
    }
    const retryAt = new Date(this.now().getTime() + retryDelayMs(attempts, this.baseRetryDelayMs, this.maxRetryDelayMs));
    await prisma.meetingAnalysisRun.updateMany({
      where: fence,
      data: { status: "PENDING", error: message, lockedUntil: retryAt },
    });
    this.log("warn", `Analysis ${runId} attempt ${attempts} failed; retrying at ${retryAt.toISOString()}`, error);
    return { runId, status: "RETRY", error: message, retryAt };
  }

  private async store(
    runId: string,
    attempts: number,
    meetingId: string,
    analysis: MeetingAnalysis,
    model: string,
    segmentCount: number,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Fence first: only the holder of this attempt may write.
      const fenced = await tx.meetingAnalysisRun.updateMany({
        where: { id: runId, status: "RUNNING", attempts },
        data: {
          status: "COMPLETE",
          provider: this.llm.name,
          modelName: model,
          segmentCount,
          droppedItemCount: analysis.droppedUnsupportedItems,
          error: null,
          lockedUntil: null,
          completedAt: this.now(),
        },
      });
      if (fenced.count !== 1) throw new LeaseLostError();

      const keepWhere = { meetingId, OR: [{ origin: "USER" as const }, { editedAt: { not: null } }] };
      const replaceWhere = { meetingId, origin: "AI" as const, editedAt: null };
      const [keptDecisions, keptActions, keptQuestions, keptRisks, keptCommitments] = await Promise.all([
        tx.decision.findMany({ where: keepWhere, select: { text: true } }),
        tx.actionItem.findMany({ where: keepWhere, select: { text: true } }),
        tx.question.findMany({ where: keepWhere, select: { text: true } }),
        tx.risk.findMany({ where: keepWhere, select: { text: true } }),
        tx.commitment.findMany({ where: keepWhere, select: { text: true } }),
      ]);
      await tx.decision.deleteMany({ where: replaceWhere });
      await tx.actionItem.deleteMany({ where: replaceWhere });
      await tx.question.deleteMany({ where: replaceWhere });
      await tx.risk.deleteMany({ where: replaceWhere });
      await tx.commitment.deleteMany({ where: replaceWhere });
      await tx.topic.deleteMany({ where: { meetingId } });

      const fresh = <T extends { text: string }>(items: T[], kept: Array<{ text: string }>) => {
        const existing = new Set(kept.map((k) => normalize(k.text)));
        return items.filter((item) => !existing.has(normalize(item.text)));
      };
      const provenance = (evidence: Array<{ segmentId: string }>) => ({
        meetingId,
        analysisRunId: runId,
        origin: "AI" as const,
        sourceSegmentId: evidence[0]?.segmentId ?? null,
        evidenceSegmentIds: evidence.map((e) => e.segmentId),
      });

      await tx.decision.createMany({
        data: fresh(analysis.decisions, keptDecisions).map((d) => ({ ...provenance(d.evidence), text: d.text })),
      });
      await tx.actionItem.createMany({
        data: fresh(analysis.actionItems, keptActions).map((a) => ({
          ...provenance(a.evidence),
          text: a.text,
          ownerName: a.owner,
          dueDate: a.dueDate ? new Date(`${a.dueDate}T00:00:00Z`) : null,
        })),
      });
      await tx.question.createMany({
        data: fresh(analysis.openQuestions, keptQuestions).map((q) => ({ ...provenance(q.evidence), text: q.text, isResolved: q.resolved })),
      });
      await tx.risk.createMany({
        data: fresh(analysis.risks, keptRisks).map((r) => ({ ...provenance(r.evidence), text: r.text, severity: r.severity })),
      });
      await tx.commitment.createMany({
        data: fresh(analysis.commitments, keptCommitments).map((c) => ({
          ...provenance(c.evidence),
          text: c.text,
          committedBy: c.committedBy,
          dueDate: c.dueDate ? new Date(`${c.dueDate}T00:00:00Z`) : null,
        })),
      });
      await tx.topic.createMany({ data: analysis.topics.map((t) => ({ ...t, meetingId, analysisRunId: runId })) });

      // An edited summary is the user's; leave it. Otherwise replace it.
      const editedSummary = await tx.summary.findFirst({ where: { meetingId, kind: "executive", editedAt: { not: null } } });
      if (!editedSummary) {
        await tx.summary.deleteMany({ where: { meetingId, kind: "executive" } });
        await tx.summary.create({
          data: {
            meetingId,
            kind: "executive",
            content: analysis.executiveSummary,
            keyPoints: analysis.keyPoints,
            language: analysis.language,
            modelName: model,
            analysisRunId: runId,
          },
        });
      }
    });
  }
}
