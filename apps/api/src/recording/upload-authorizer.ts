import { hasAtLeastRole } from "@voiceover/auth";
import { prisma } from "@voiceover/database";
import { UPLOAD_CLOSE_CONSENT, UPLOAD_CLOSE_STOPPED } from "./recording-control.js";

export const UPLOAD_CLOSE_NOT_FOUND = 4004;
export const UPLOAD_CLOSE_FORBIDDEN = 4003;

export type UploadAuthorization =
  | { ok: true; recordingSessionId: string; sourceTrack: string }
  | { ok: false; closeCode: number; reason: string };

/**
 * Decides whether `userId` may stream audio into `recordingTrackId` over the
 * browser-capture upload socket. Injectable so the socket's protocol tests
 * can run without a database.
 */
export interface UploadAuthorizer {
  authorize(userId: string, recordingTrackId: string): Promise<UploadAuthorization>;
}

const ACTIVE_STATUSES = new Set(["RECORDING", "PAUSED"]);

/**
 * Track must be a server-issued BROWSER track (bot tracks are written
 * server-side only), on a live meeting in an org the user is still a MEMBER+
 * of, in a session *this user* started, that is still recording, with consent
 * still in effect. Cross-org and nonexistent tracks get the same answer, so
 * the socket can't be used to probe for other tenants' track ids.
 */
export class PrismaUploadAuthorizer implements UploadAuthorizer {
  async authorize(userId: string, recordingTrackId: string): Promise<UploadAuthorization> {
    const notFound: UploadAuthorization = { ok: false, closeCode: UPLOAD_CLOSE_NOT_FOUND, reason: "Recording track not found" };
    const track = await prisma.recordingTrack.findUnique({
      where: { id: recordingTrackId },
      select: {
        sourceTrack: true,
        recordingSession: {
          select: {
            id: true,
            method: true,
            status: true,
            startedByUserId: true,
            meeting: { select: { organizationId: true, deletedAt: true } },
            consents: { where: { granted: true, revokedAt: null }, select: { id: true }, take: 1 },
          },
        },
      },
    });
    const session = track?.recordingSession;
    if (!track || !session || session.method !== "BROWSER" || session.meeting.deletedAt) return notFound;

    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: session.meeting.organizationId },
      select: { role: true },
    });
    if (!membership) return notFound;
    if (!hasAtLeastRole(membership.role, "MEMBER") || session.startedByUserId !== userId) {
      return { ok: false, closeCode: UPLOAD_CLOSE_FORBIDDEN, reason: "Only the user who started this recording can upload to it" };
    }
    if (!ACTIVE_STATUSES.has(session.status)) {
      return { ok: false, closeCode: UPLOAD_CLOSE_STOPPED, reason: "Recording session is not active" };
    }
    if (session.consents.length === 0) {
      return { ok: false, closeCode: UPLOAD_CLOSE_CONSENT, reason: "Recording consent is not in effect" };
    }
    return { ok: true, recordingSessionId: session.id, sourceTrack: track.sourceTrack };
  }
}
