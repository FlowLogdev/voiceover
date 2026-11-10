import { prisma } from "@voiceover/database";
import type { TranscriptEventBase } from "@voiceover/transcription";

export type FinalTranscript = TranscriptEventBase;

/**
 * Durable store for final transcript segments. Partials are live-only; a
 * final is upserted by (track, provider segment id), so a re-delivered final
 * revises the stored row instead of duplicating it.
 */
export interface TranscriptStore {
  saveFinal(recordingTrackId: string, segment: FinalTranscript, provider: string): Promise<void>;
}

/** Default speaker label when there is no diarization, by capture track. */
const TRACK_SPEAKER_LABEL: Record<string, string> = {
  local_mic: "Microphone",
  remote_tab: "Tab audio",
  bot_mixed: "Meeting audio",
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

interface TrackContext {
  meetingId: string;
  starterName: string | null;
}

/**
 * Speaker attribution:
 * - provider diarization label present -> one Speaker per (track, label),
 *   numbered "Speaker 1", "Speaker 2", ... in order of first appearance;
 * - otherwise -> one Speaker per capture track ("Microphone" is named after
 *   the user who recorded it). That is attribution by audio source, not
 *   diarization, and is labelled as such.
 * Speakers can be renamed afterwards; renames are never overwritten here.
 */
export class PrismaTranscriptStore implements TranscriptStore {
  private readonly contexts = new Map<string, Promise<TrackContext>>();
  private readonly speakers = new Map<string, Promise<string>>();

  async saveFinal(recordingTrackId: string, segment: FinalTranscript, provider: string): Promise<void> {
    const context = await this.context(recordingTrackId);
    const speakerId = await this.speaker(recordingTrackId, context, segment);
    const fields = {
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      languageCode: segment.languageCode,
      confidence: segment.confidence ?? null,
    };
    await prisma.transcriptSegment.upsert({
      where: { recordingTrackId_externalSegmentId: { recordingTrackId, externalSegmentId: segment.segmentId } },
      create: {
        ...fields,
        meetingId: context.meetingId,
        speakerId,
        sourceTrack: segment.sourceTrack,
        recordingTrackId,
        externalSegmentId: segment.segmentId,
        isFinal: true,
        provider,
      },
      update: { ...fields, revisionNumber: { increment: 1 } },
    });
  }

  private context(recordingTrackId: string): Promise<TrackContext> {
    let pending = this.contexts.get(recordingTrackId);
    if (!pending) {
      pending = prisma.recordingTrack
        .findUniqueOrThrow({
          where: { id: recordingTrackId },
          select: { recordingSession: { select: { meetingId: true, startedBy: { select: { name: true } } } } },
        })
        .then((row) => ({
          meetingId: row.recordingSession.meetingId,
          starterName: row.recordingSession.startedBy?.name ?? null,
        }));
      pending.catch(() => this.contexts.delete(recordingTrackId));
      this.contexts.set(recordingTrackId, pending);
    }
    return pending;
  }

  private speaker(recordingTrackId: string, context: TrackContext, segment: FinalTranscript): Promise<string> {
    const externalKey = segment.speakerLabel
      ? `${recordingTrackId}:asr:${segment.speakerLabel}`
      : `${recordingTrackId}:track`;
    let pending = this.speakers.get(externalKey);
    if (!pending) {
      pending = this.findOrCreateSpeaker(context, externalKey, segment);
      pending.catch(() => this.speakers.delete(externalKey));
      this.speakers.set(externalKey, pending);
    }
    return pending;
  }

  private async findOrCreateSpeaker(context: TrackContext, externalKey: string, segment: FinalTranscript): Promise<string> {
    const where = { meetingId_externalKey: { meetingId: context.meetingId, externalKey } };
    const existing = await prisma.speaker.findUnique({ where, select: { id: true } });
    if (existing) return existing.id;

    let label: string;
    let displayName: string | null = null;
    if (segment.speakerLabel) {
      const numbered = await prisma.speaker.count({
        where: { meetingId: context.meetingId, externalKey: { contains: ":asr:" } },
      });
      label = `Speaker ${numbered + 1}`;
    } else {
      label = TRACK_SPEAKER_LABEL[segment.sourceTrack] ?? segment.sourceTrack;
      if (segment.sourceTrack === "local_mic") displayName = context.starterName;
    }
    try {
      const created = await prisma.speaker.create({
        data: { meetingId: context.meetingId, externalKey, label, displayName },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return (await prisma.speaker.findUniqueOrThrow({ where, select: { id: true } })).id;
    }
  }
}

/** For DB-free tests. */
export class InMemoryTranscriptStore implements TranscriptStore {
  readonly segments = new Map<string, FinalTranscript & { recordingTrackId: string; provider: string; revision: number }>();

  async saveFinal(recordingTrackId: string, segment: FinalTranscript, provider: string): Promise<void> {
    const key = `${recordingTrackId}:${segment.segmentId}`;
    const previous = this.segments.get(key);
    this.segments.set(key, { ...segment, recordingTrackId, provider, revision: (previous?.revision ?? 0) + 1 });
  }

  forTrack(recordingTrackId: string) {
    return [...this.segments.values()].filter((s) => s.recordingTrackId === recordingTrackId);
  }
}
