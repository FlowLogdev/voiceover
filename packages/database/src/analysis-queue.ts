import { prisma } from "./client.js";

export type EnqueueAnalysisResult =
  | { enqueued: true; runId: string }
  | { enqueued: false; reason: "already_queued"; runId: string }
  | { enqueued: false; reason: "no_transcript" };

/**
 * Queues an AI analysis of a meeting, unless one is already pending or
 * running (then that run will see the newest transcript anyway). A
 * transaction-scoped advisory lock on the meeting makes check-then-insert
 * atomic, so concurrent callers (two recordings finalizing at once, a user
 * clicking regenerate twice) can't queue duplicates.
 */
export async function enqueueMeetingAnalysis(args: {
  meetingId: string;
  trigger: "recording_finalized" | "manual";
  requestedByUserId?: string | null;
}): Promise<EnqueueAnalysisResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`analysis:${args.meetingId}`}))`;
    const active = await tx.meetingAnalysisRun.findFirst({
      where: { meetingId: args.meetingId, status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true },
    });
    if (active) return { enqueued: false, reason: "already_queued", runId: active.id };
    const hasTranscript = await tx.transcriptSegment.findFirst({
      where: { meetingId: args.meetingId, isFinal: true },
      select: { id: true },
    });
    if (!hasTranscript) return { enqueued: false, reason: "no_transcript" };
    const run = await tx.meetingAnalysisRun.create({
      data: { meetingId: args.meetingId, trigger: args.trigger, requestedByUserId: args.requestedByUserId ?? null },
      select: { id: true },
    });
    return { enqueued: true, runId: run.id };
  });
}
