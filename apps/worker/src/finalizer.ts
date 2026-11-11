import { fnv1aChecksum, planTrackAssembly, streamTrackAssembly, TrackAssemblyError } from "@voiceover/audio";
import { enqueueMeetingAnalysis, prisma } from "@voiceover/database";
import { InvalidStorageKeyError, storageKeys, type ObjectStore } from "@voiceover/storage";
import { mergeLanguageSegments } from "@voiceover/transcription";

/** A finalization failure that retrying cannot fix (corrupt or unusable data). */
export class PermanentFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentFinalizationError";
  }
}

/** Exponential backoff after `attempt` failed attempts (1-based), capped. */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

/** Restricts which sessions a call may claim (tests sharing a database use this). */
export interface ClaimScope {
  sessionIds?: string[];
}

export function isPermanent(error: unknown): boolean {
  return (
    error instanceof PermanentFinalizationError ||
    error instanceof TrackAssemblyError ||
    error instanceof InvalidStorageKeyError
  );
}

export interface RecordingFinalizerOptions {
  objectStore: ObjectStore;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** How long a claim is held before another worker may take the session over (crash recovery). */
  leaseMs?: number;
  /** Attempts before a session is marked FAILED. */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt, capped at maxRetryDelayMs. */
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /**
   * Wait this long after a session ends before finalizing, so the last
   * in-flight chunks and the ASR's final flush have landed.
   */
  settleMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, error?: unknown) => void;
}

export type FinalizeOutcome =
  | { sessionId: string; status: "COMPLETE" }
  | { sessionId: string; status: "RETRY"; error: string; retryAt: Date }
  | { sessionId: string; status: "FAILED"; error: string };

/**
 * Finalizes recording sessions that have ended (status FINALIZING), using
 * Postgres as the job queue: a session is claimed with a compare-and-set on
 * its lease (`finalizeLockedUntil`), so any number of workers can run and
 * a crashed worker's claim simply expires. Every step is idempotent, so a
 * session that is retried or taken over is safe to process again.
 *
 * Per session:
 * 1. every track: assemble a playable WAV from its chunks (streamed, gaps
 *    filled with silence so transcript timestamps stay aligned), verifying
 *    each chunk's checksum, and record duration / chunk / gap counts;
 * 2. recompute the meeting's language timeline from its final segments;
 * 3. mark the session COMPLETE (or retry with backoff / FAILED).
 *
 * (The architecture names BullMQ for jobs; neither local dev nor CI has
 * Redis, and a lease on the row it concerns needs no second source of truth.
 * Revisit if job volume or fan-out grows.)
 */
export class RecordingFinalizer {
  private readonly objectStore: ObjectStore;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly settleMs: number;
  private readonly log: NonNullable<RecordingFinalizerOptions["log"]>;

  constructor(options: RecordingFinalizerOptions) {
    this.objectStore = options.objectStore;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 30_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30 * 60_000;
    this.settleMs = options.settleMs ?? 5_000;
    this.log = options.log ?? ((level, message, error) => console[level](message, error ?? ""));
  }

  /** Claims the next finalizable session, or null if none is due. */
  async claimNext(scope: ClaimScope = {}): Promise<string | null> {
    const now = this.now();
    const candidates = await prisma.recordingSession.findMany({
      where: {
        status: "FINALIZING",
        ...(scope.sessionIds ? { id: { in: scope.sessionIds } } : {}),
        AND: [
          { OR: [{ finalizeLockedUntil: null }, { finalizeLockedUntil: { lt: now } }] },
          { OR: [{ endedAt: null }, { endedAt: { lte: new Date(now.getTime() - this.settleMs) } }] },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: 10,
      select: { id: true, finalizeLockedUntil: true },
    });
    for (const candidate of candidates) {
      // Compare-and-set on the lease value we saw: exactly one worker wins.
      const claimed = await prisma.recordingSession.updateMany({
        where: { id: candidate.id, status: "FINALIZING", finalizeLockedUntil: candidate.finalizeLockedUntil },
        data: { finalizeLockedUntil: new Date(now.getTime() + this.leaseMs), finalizeAttempts: { increment: 1 } },
      });
      if (claimed.count === 1) return candidate.id;
    }
    return null;
  }

  /** Claims and finalizes sessions until none is due. */
  async runOnce(scope: ClaimScope = {}): Promise<FinalizeOutcome[]> {
    const outcomes: FinalizeOutcome[] = [];
    for (let sessionId = await this.claimNext(scope); sessionId; sessionId = await this.claimNext(scope)) {
      outcomes.push(await this.finalizeClaimed(sessionId));
    }
    return outcomes;
  }

  /** Finalizes a session this worker has already claimed. */
  async finalizeClaimed(sessionId: string): Promise<FinalizeOutcome> {
    try {
      await this.finalize(sessionId);
      await prisma.recordingSession.update({
        where: { id: sessionId },
        data: { status: "COMPLETE", finalizedAt: this.now(), finalizeLockedUntil: null },
      });
      this.log("info", `Finalized recording session ${sessionId}`);
      await this.queueAnalysis(sessionId);
      return { sessionId, status: "COMPLETE" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { finalizeAttempts } = await prisma.recordingSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { finalizeAttempts: true },
      });
      if (isPermanent(error) || finalizeAttempts >= this.maxAttempts) {
        const reason = isPermanent(error)
          ? `Finalization failed: ${message}`
          : `Finalization failed after ${finalizeAttempts} attempts: ${message}`;
        await prisma.recordingSession.update({
          where: { id: sessionId },
          data: { status: "FAILED", failureReason: reason, finalizeLockedUntil: null },
        });
        this.log("error", `Recording session ${sessionId} failed finalization`, error);
        return { sessionId, status: "FAILED", error: reason };
      }
      const delay = retryDelayMs(finalizeAttempts, this.baseRetryDelayMs, this.maxRetryDelayMs);
      const retryAt = new Date(this.now().getTime() + delay);
      // Re-leasing until retryAt doubles as the backoff: nobody claims it before then.
      await prisma.recordingSession.update({ where: { id: sessionId }, data: { finalizeLockedUntil: retryAt } });
      this.log("warn", `Finalizing ${sessionId} failed (attempt ${finalizeAttempts}), retrying at ${retryAt.toISOString()}`, error);
      return { sessionId, status: "RETRY", error: message, retryAt };
    }
  }

  /** A finished recording means a (possibly longer) transcript: queue an AI analysis. Never fails finalization. */
  private async queueAnalysis(sessionId: string): Promise<void> {
    try {
      const { meetingId } = await prisma.recordingSession.findUniqueOrThrow({ where: { id: sessionId }, select: { meetingId: true } });
      const result = await enqueueMeetingAnalysis({ meetingId, trigger: "recording_finalized" });
      if (result.enqueued) this.log("info", `Queued analysis ${result.runId} for meeting ${meetingId}`);
    } catch (error) {
      this.log("warn", `Could not queue analysis after finalizing ${sessionId}`, error);
    }
  }

  private async finalize(sessionId: string): Promise<void> {
    const session = await prisma.recordingSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { meetingId: true, endedAt: true, tracks: { select: { id: true } } },
    });
    for (const track of session.tracks) await this.finalizeTrack(track.id);
    await this.rebuildLanguageTimeline(session.meetingId);
    if (session.endedAt) {
      await prisma.meeting.updateMany({
        where: { id: session.meetingId, OR: [{ endedAt: null }, { endedAt: { lt: session.endedAt } }] },
        data: { endedAt: session.endedAt },
      });
    }
  }

  private async finalizeTrack(recordingTrackId: string): Promise<void> {
    const chunks = await prisma.audioChunk.findMany({
      where: { recordingTrackId },
      orderBy: { sequenceNumber: "asc" },
      select: { sequenceNumber: true, startMs: true, sampleRate: true, byteSize: true, storageKey: true, checksum: true },
    });
    if (chunks.length === 0) {
      // E.g. a bot that left before any audio: nothing to play back, not an error.
      await prisma.recordingTrack.update({
        where: { id: recordingTrackId },
        data: { chunkCount: 0, missingChunkCount: 0, durationMs: 0, playbackStorageKey: null, playbackSampleRate: null },
      });
      return;
    }
    const legacy = chunks.find((c) => c.sampleRate === null);
    if (legacy) {
      throw new PermanentFinalizationError(
        `Chunk ${legacy.sequenceNumber} has no recorded sample rate (stored before Phase 5)`,
      );
    }

    const plan = planTrackAssembly(
      chunks.map((c) => ({ sequenceNumber: c.sequenceNumber, startMs: c.startMs, sampleRate: c.sampleRate!, byteLength: c.byteSize })),
    );
    const bySequence = new Map(chunks.map((c) => [c.sequenceNumber, c]));
    const playbackKey = storageKeys.playback(recordingTrackId);
    const written = await this.objectStore.putStream(
      playbackKey,
      streamTrackAssembly(plan, async (sequenceNumber) => {
        const row = bySequence.get(sequenceNumber)!;
        const bytes = await this.objectStore.get(row.storageKey);
        if (fnv1aChecksum(bytes) !== row.checksum) {
          throw new PermanentFinalizationError(`Chunk ${sequenceNumber} does not match its checksum`);
        }
        return bytes;
      }),
    );
    if (written !== plan.byteLength) {
      throw new PermanentFinalizationError(`Playback file is ${written} bytes, planned ${plan.byteLength}`);
    }

    await prisma.recordingTrack.update({
      where: { id: recordingTrackId },
      data: {
        durationMs: plan.durationMs,
        chunkCount: plan.chunkCount,
        missingChunkCount: plan.missingSequenceNumbers.length,
        playbackStorageKey: playbackKey,
        playbackSampleRate: plan.sampleRate,
      },
    });
    if (plan.missingSequenceNumbers.length > 0) {
      this.log("warn", `Track ${recordingTrackId}: ${plan.missingSequenceNumbers.length} missing chunk(s) filled with silence`);
    }
  }

  private async rebuildLanguageTimeline(meetingId: string): Promise<void> {
    const segments = await prisma.transcriptSegment.findMany({
      where: { meetingId, isFinal: true },
      select: { startMs: true, endMs: true, languageCode: true },
    });
    const runs = mergeLanguageSegments(segments);
    await prisma.$transaction([
      prisma.languageSegment.deleteMany({ where: { meetingId } }),
      prisma.languageSegment.createMany({ data: runs.map((run) => ({ ...run, meetingId })) }),
    ]);
  }
}
