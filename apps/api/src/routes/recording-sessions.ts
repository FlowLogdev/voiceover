import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasAtLeastRole } from "@voiceover/auth";
import { forOrganization, prisma } from "@voiceover/database";
import type { BotSessionManager } from "@voiceover/meeting-bot";
import {
  createRecordingSessionRequestSchema,
  type RecordingConsentDTO,
  type RecordingSessionDTO,
} from "@voiceover/types";
import { httpError } from "../http-error.js";
import { requireAuth, requireOrganization, type AuthContext } from "../plugins/auth-context.js";
import {
  ACTIVE_BROWSER_SESSION_STATUSES,
  assertCurrentNotice,
  consentCreateData,
  revokeMeetingConsent,
} from "../recording/consent.js";
import { UPLOAD_CLOSE_STOPPED, type RecordingControl } from "../recording/recording-control.js";

const orgParams = z.object({ organizationId: z.string().uuid() });
const meetingParams = orgParams.extend({ meetingId: z.string().uuid() });
const sessionParams = orgParams.extend({ sessionId: z.string().uuid() });

const sessionSelect = {
  id: true,
  meetingId: true,
  method: true,
  status: true,
  startedAt: true,
  endedAt: true,
  tracks: { select: { id: true, sourceTrack: true }, orderBy: { createdAt: "asc" as const } },
} as const;

interface SessionRow {
  id: string;
  meetingId: string;
  method: "BROWSER" | "BOT";
  status: RecordingSessionDTO["status"];
  startedAt: Date | null;
  endedAt: Date | null;
  tracks: Array<{ id: string; sourceTrack: string }>;
}

function toDTO(row: SessionRow): RecordingSessionDTO {
  return {
    id: row.id,
    meetingId: row.meetingId,
    method: row.method,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    tracks: row.tracks,
  };
}

function requireMember(auth: AuthContext, organizationId: string): void {
  const membership = requireOrganization(auth, organizationId);
  if (!hasAtLeastRole(membership.role, "MEMBER")) throw httpError(403, "Guests cannot start recordings");
}

async function requireMeeting(organizationId: string, meetingId: string) {
  const meeting = await forOrganization(organizationId).meeting.findFirst({
    where: { id: meetingId, deletedAt: null },
    select: { id: true, recordingMethod: true, startedAt: true },
  });
  if (!meeting) throw httpError(404, "Meeting not found");
  return meeting;
}

/**
 * Browser-capture recording sessions. The server issues the session and its
 * track ids (the extension used to mint its own), records the starting user's
 * consent attestation, and the upload socket only accepts audio for a track
 * whose session that same user started and that is still active.
 *
 * Also the meeting-level consent endpoints, which cover bot sessions too.
 */
export async function recordingSessionRoutes(
  fastify: FastifyInstance,
  options: { manager: BotSessionManager; control: RecordingControl },
) {
  fastify.post("/organizations/:organizationId/meetings/:meetingId/recording-sessions", async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireMember(auth, organizationId);
    const body = createRecordingSessionRequestSchema.parse(request.body);
    assertCurrentNotice(body.consent);
    const meeting = await requireMeeting(organizationId, meetingId);

    const sessionId = randomUUID();
    const sourceTracks = [...new Set(body.sourceTracks ?? ["remote_tab"])];
    const now = new Date();
    const [session] = await prisma.$transaction([
      prisma.recordingSession.create({
        data: {
          id: sessionId,
          meetingId,
          method: "BROWSER",
          status: "RECORDING",
          startedAt: now,
          startedByUserId: auth.userId,
          tracks: {
            create: sourceTracks.map((sourceTrack) => ({
              sourceTrack,
              storagePrefix: `recordings/${sessionId}/${sourceTrack}`,
            })),
          },
        },
        select: sessionSelect,
      }),
      prisma.recordingConsent.create({
        data: consentCreateData({ meetingId, recordingSessionId: sessionId, userId: auth.userId, consent: body.consent }),
      }),
      prisma.meeting.update({
        where: { id: meetingId },
        data: { recordingMethod: meeting.recordingMethod ?? "BROWSER", startedAt: meeting.startedAt ?? now },
      }),
      prisma.auditLog.create({
        data: {
          organizationId,
          userId: auth.userId,
          action: "CONSENT_GRANTED",
          metadata: {
            meetingId,
            recordingSessionId: sessionId,
            basis: "ORGANIZER_ATTESTATION",
            noticeVersion: body.consent.noticeVersion,
          },
        },
      }),
      prisma.auditLog.create({
        data: {
          organizationId,
          userId: auth.userId,
          action: "RECORDING_STARTED",
          metadata: { meetingId, recordingSessionId: sessionId, method: "BROWSER", sourceTracks },
        },
      }),
    ]);
    return reply.status(201).send(toDTO(session));
  });

  fastify.get("/organizations/:organizationId/meetings/:meetingId/recording-sessions", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const rows = await prisma.recordingSession.findMany({
      where: { meetingId, meeting: { organizationId, deletedAt: null } },
      select: sessionSelect,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDTO);
  });

  // Any member, guests included, may stop a recording: stopping is always the safe direction.
  fastify.post("/organizations/:organizationId/recording-sessions/:sessionId/stop", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, sessionId } = sessionParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const where = { id: sessionId, method: "BROWSER" as const, meeting: { organizationId, deletedAt: null } };
    const before = await prisma.recordingSession.findFirst({ where, select: sessionSelect });
    if (!before) throw httpError(404, "Recording session not found");

    if ((ACTIVE_BROWSER_SESSION_STATUSES as readonly string[]).includes(before.status)) {
      await prisma.$transaction([
        prisma.recordingSession.update({ where: { id: sessionId }, data: { status: "FINALIZING", endedAt: new Date() } }),
        prisma.auditLog.create({
          data: {
            organizationId,
            userId: auth.userId,
            action: "RECORDING_STOPPED",
            metadata: { recordingSessionId: sessionId },
          },
        }),
      ]);
    }
    options.control.stopTracks(
      before.tracks.map((t) => t.id),
      UPLOAD_CLOSE_STOPPED,
      "Recording stopped",
    );
    const row = await prisma.recordingSession.findFirst({ where, select: sessionSelect });
    return toDTO(row!);
  });

  fastify.get("/organizations/:organizationId/meetings/:meetingId/consents", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireOrganization(auth, organizationId);
    await requireMeeting(organizationId, meetingId);
    const rows = await prisma.recordingConsent.findMany({ where: { meetingId }, orderBy: { grantedAt: "desc" } });
    return rows.map(
      (c): RecordingConsentDTO => ({
        id: c.id,
        recordingSessionId: c.recordingSessionId,
        userId: c.userId,
        basis: c.basis,
        noticeVersion: c.noticeVersion,
        grantedAt: c.grantedAt.toISOString(),
        revokedAt: c.revokedAt?.toISOString() ?? null,
      }),
    );
  });

  // Any member, guests included, may withdraw consent and stop all recording on the meeting.
  fastify.post("/organizations/:organizationId/meetings/:meetingId/consents/revoke", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireOrganization(auth, organizationId);
    await requireMeeting(organizationId, meetingId);
    return revokeMeetingConsent({
      organizationId,
      meetingId,
      userId: auth.userId,
      manager: options.manager,
      control: options.control,
    });
  });
}
