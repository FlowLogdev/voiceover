import { prisma } from "@voiceover/database";
import { BotLeaveError, type BotSessionManager } from "@voiceover/meeting-bot";
import { RECORDING_CONSENT_NOTICE, type ConsentAttestation, type RevokeConsentResponse } from "@voiceover/types";
import { httpError } from "../http-error.js";
import { NON_TERMINAL_BOT_STATUSES } from "../meeting-bot/prisma-bot-session-repository.js";
import { UPLOAD_CLOSE_CONSENT, type RecordingControl } from "./recording-control.js";

export const ACTIVE_BROWSER_SESSION_STATUSES = ["PENDING", "RECORDING", "PAUSED"] as const;

/**
 * Rejects an attestation made against anything but the notice currently in
 * force: a stale client must not record against wording the user never saw.
 */
export function assertCurrentNotice(consent: ConsentAttestation): void {
  if (consent.noticeVersion !== RECORDING_CONSENT_NOTICE.version) {
    throw httpError(400, "The recording consent notice has changed. Review and confirm it again");
  }
}

export function consentCreateData(args: {
  meetingId: string;
  recordingSessionId: string;
  userId: string;
  consent: ConsentAttestation;
}) {
  return {
    meetingId: args.meetingId,
    recordingSessionId: args.recordingSessionId,
    userId: args.userId,
    basis: "ORGANIZER_ATTESTATION" as const,
    noticeVersion: args.consent.noticeVersion,
    granted: true,
  };
}

/**
 * Withdraws every consent in force on a meeting and stops all recording on it:
 * browser sessions are canceled and their live upload sockets closed; bots are
 * told to leave (scheduled ones are canceled). Bot audio is dropped
 * server-side immediately, even if the provider fails to remove the bot.
 * Such failures are reported, not swallowed. Already-captured audio is kept;
 * deleting it is a separate, explicit action.
 */
export async function revokeMeetingConsent(args: {
  organizationId: string;
  meetingId: string;
  userId: string;
  manager: BotSessionManager;
  control: RecordingControl;
}): Promise<RevokeConsentResponse> {
  const { organizationId, meetingId, userId, manager, control } = args;
  const now = new Date();
  const reason = "Recording consent revoked";

  const revoked = await prisma.recordingConsent.updateMany({
    where: { meetingId, granted: true, revokedAt: null },
    data: { revokedAt: now, revokedByUserId: userId },
  });

  const browserSessions = await prisma.recordingSession.findMany({
    where: { meetingId, method: "BROWSER", status: { in: [...ACTIVE_BROWSER_SESSION_STATUSES] } },
    select: { id: true, tracks: { select: { id: true } } },
  });
  if (browserSessions.length > 0) {
    await prisma.recordingSession.updateMany({
      where: { id: { in: browserSessions.map((s) => s.id) } },
      data: { status: "CANCELED", endedAt: now, failureReason: reason },
    });
  }

  const botSessions = await prisma.recordingSession.findMany({
    where: { meetingId, method: "BOT", botJoinStatus: { in: NON_TERMINAL_BOT_STATUSES } },
    select: { id: true, tracks: { select: { id: true } } },
  });

  // Cut audio off first, then ask bots to leave.
  control.stopTracks(
    [...browserSessions, ...botSessions].flatMap((s) => s.tracks.map((t) => t.id)),
    UPLOAD_CLOSE_CONSENT,
    reason,
  );

  const botLeaveFailures: RevokeConsentResponse["botLeaveFailures"] = [];
  let stoppedBotSessions = 0;
  for (const bot of botSessions) {
    try {
      await manager.leave(bot.id);
      stoppedBotSessions++;
      await prisma.auditLog.create({
        data: {
          organizationId,
          userId,
          action: "BOT_LEFT",
          metadata: { recordingSessionId: bot.id, reason: "consent_revoked" },
        },
      });
    } catch (error) {
      if (!(error instanceof BotLeaveError)) throw error;
      botLeaveFailures.push({ recordingSessionId: bot.id, error: error.message });
    }
  }

  await prisma.auditLog.create({
    data: {
      organizationId,
      userId,
      action: "CONSENT_REVOKED",
      metadata: {
        meetingId,
        revokedConsents: revoked.count,
        stoppedBrowserSessions: browserSessions.map((s) => s.id),
        stoppedBotSessions: botSessions.map((s) => s.id),
        botLeaveFailures,
      },
    },
  });

  return {
    revokedConsents: revoked.count,
    stoppedBrowserSessions: browserSessions.length,
    stoppedBotSessions,
    botLeaveFailures,
  };
}
