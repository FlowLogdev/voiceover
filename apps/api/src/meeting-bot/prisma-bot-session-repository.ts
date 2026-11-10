import { prisma, type RecordingSessionStatus } from "@voiceover/database";
import {
  parseMeetingUrl,
  type BotSessionPatch,
  type BotSessionRecord,
  type BotSessionRepository,
  type BotStatus,
} from "@voiceover/meeting-bot";

export const BOT_TRACK = "bot_mixed";
export const NON_TERMINAL_BOT_STATUSES: BotStatus[] = ["SCHEDULED", "JOINING", "WAITING_ROOM", "IN_CALL"];

export const sessionInclude = {
  tracks: { where: { sourceTrack: BOT_TRACK }, select: { id: true }, take: 1 },
} as const;

export type SessionRow = NonNullable<Awaited<ReturnType<typeof findRow>>>;

function findRow(id: string) {
  return prisma.recordingSession.findFirst({ where: { id, method: "BOT" }, include: sessionInclude });
}

export function toBotSessionRecord(row: SessionRow): BotSessionRecord {
  const track = row.tracks[0];
  if (!track || !row.botMeetingUrl || !row.botJoinStatus) {
    throw new Error(`Recording session ${row.id} is not a well-formed bot session`);
  }
  return {
    id: row.id,
    recordingTrackId: track.id,
    meetingUrl: row.botMeetingUrl,
    platform: parseMeetingUrl(row.botMeetingUrl).platform,
    botName: row.botName ?? "VoiceOver Notetaker",
    status: row.botJoinStatus,
    providerBotId: row.botExternalId,
    scheduledJoinAt: row.botScheduledJoinAt,
    joinAttempts: row.botJoinAttempts,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    failureReason: row.failureReason,
  };
}

/**
 * The generic recording-session status is derived from the bot status so the
 * rest of the system (playback, finalisation, billing) can stay
 * capture-method-agnostic. A bot that left after being in the call goes to
 * FINALIZING — the finalisation job that moves it to COMPLETE is Phase 5.
 */
function recordingStatusFor(record: BotSessionRecord): RecordingSessionStatus {
  switch (record.status) {
    case "SCHEDULED":
    case "JOINING":
    case "WAITING_ROOM":
      return "PENDING";
    case "IN_CALL":
      return "RECORDING";
    case "LEFT":
      return record.startedAt ? "FINALIZING" : "CANCELED";
    case "ADMISSION_REJECTED":
    case "FAILED":
      return record.startedAt ? "FINALIZING" : "FAILED";
  }
}

export class PrismaBotSessionRepository implements BotSessionRepository {
  async get(id: string): Promise<BotSessionRecord | null> {
    const row = await findRow(id);
    return row ? toBotSessionRecord(row) : null;
  }

  async update(id: string, patch: BotSessionPatch): Promise<BotSessionRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Bot session ${id} not found`);
    const next: BotSessionRecord = { ...current, ...patch };
    const row = await prisma.recordingSession.update({
      where: { id },
      data: {
        botJoinStatus: next.status,
        status: recordingStatusFor(next),
        botExternalId: next.providerBotId,
        botScheduledJoinAt: next.scheduledJoinAt,
        botJoinAttempts: next.joinAttempts,
        botMeetingUrl: next.meetingUrl,
        botName: next.botName,
        startedAt: next.startedAt,
        endedAt: next.endedAt,
        failureReason: next.failureReason,
      },
      include: sessionInclude,
    });
    return toBotSessionRecord(row);
  }

  async listNonTerminal(): Promise<BotSessionRecord[]> {
    const rows = await prisma.recordingSession.findMany({
      where: { method: "BOT", botJoinStatus: { in: NON_TERMINAL_BOT_STATUSES } },
      include: sessionInclude,
    });
    return rows.map(toBotSessionRecord);
  }
}
