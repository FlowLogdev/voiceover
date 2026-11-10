import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasAtLeastRole } from "@voiceover/auth";
import { forOrganization, prisma } from "@voiceover/database";
import {
  BotLeaveError,
  InvalidMeetingUrlError,
  parseMeetingUrl,
  type BotSessionManager,
  type MeetingBotProvider,
} from "@voiceover/meeting-bot";
import { createBotSessionRequestSchema, type BotSessionDTO } from "@voiceover/types";
import { httpError } from "../http-error.js";
import { requireAuth, requireOrganization, type AuthContext } from "../plugins/auth-context.js";
import { assertCurrentNotice, consentCreateData } from "../recording/consent.js";
import {
  BOT_TRACK,
  NON_TERMINAL_BOT_STATUSES,
  sessionInclude,
  toBotSessionRecord,
  type SessionRow,
} from "../meeting-bot/prisma-bot-session-repository.js";

const DEFAULT_BOT_NAME = "VoiceOver Notetaker";
/** How far ahead a join can be scheduled. Calendar-driven scheduling (Phase 7) can revisit. */
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;
/** Clock-skew allowance for a "join now" request whose joinAt is slightly in the past. */
const PAST_JOIN_TOLERANCE_MS = 5 * 60 * 1000;

const orgParams = z.object({ organizationId: z.string().uuid() });
const meetingParams = orgParams.extend({ meetingId: z.string().uuid() });
const sessionParams = orgParams.extend({ sessionId: z.string().uuid() });

function toDTO(row: SessionRow): BotSessionDTO {
  const record = toBotSessionRecord(row);
  return {
    id: record.id,
    meetingId: row.meetingId,
    recordingTrackId: record.recordingTrackId,
    provider: row.botProvider ?? "unknown",
    platform: record.platform,
    meetingUrl: record.meetingUrl,
    botName: record.botName,
    status: record.status,
    scheduledJoinAt: record.scheduledJoinAt?.toISOString() ?? null,
    joinAttempts: record.joinAttempts,
    startedAt: record.startedAt?.toISOString() ?? null,
    endedAt: record.endedAt?.toISOString() ?? null,
    failureReason: record.failureReason,
  };
}

/** Bot sessions have no organizationId column — tenancy is enforced through the meeting. */
function findOrgBotSession(organizationId: string, sessionId: string) {
  return prisma.recordingSession.findFirst({
    where: { id: sessionId, method: "BOT", meeting: { organizationId, deletedAt: null } },
    include: sessionInclude,
  });
}

function requireMember(auth: AuthContext, organizationId: string): void {
  const membership = requireOrganization(auth, organizationId);
  if (!hasAtLeastRole(membership.role, "MEMBER")) {
    throw httpError(403, "Guests cannot invite or remove meeting bots");
  }
}

export async function botSessionRoutes(
  fastify: FastifyInstance,
  options: { manager: BotSessionManager; provider: MeetingBotProvider },
) {
  fastify.post("/organizations/:organizationId/meetings/:meetingId/bot-sessions", async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireMember(auth, organizationId);
    const body = createBotSessionRequestSchema.parse(request.body);
    assertCurrentNotice(body.consent);

    let parsedUrl;
    try {
      parsedUrl = parseMeetingUrl(body.meetingUrl);
    } catch (error) {
      if (error instanceof InvalidMeetingUrlError) throw httpError(400, error.message);
      throw error;
    }

    let scheduledJoinAt: Date | null = null;
    if (body.joinAt) {
      const joinAt = new Date(body.joinAt);
      const delta = joinAt.getTime() - Date.now();
      if (delta < -PAST_JOIN_TOLERANCE_MS) throw httpError(400, "joinAt is in the past");
      if (delta > MAX_SCHEDULE_AHEAD_MS) throw httpError(400, "joinAt is more than 90 days ahead");
      scheduledJoinAt = delta > 0 ? joinAt : null;
    }

    const meeting = await forOrganization(organizationId).meeting.findFirst({
      where: { id: meetingId, deletedAt: null },
      select: { id: true, platform: true, recordingMethod: true },
    });
    if (!meeting) throw httpError(404, "Meeting not found");

    const active = await prisma.recordingSession.findFirst({
      where: { meetingId, method: "BOT", botJoinStatus: { in: NON_TERMINAL_BOT_STATUSES } },
      select: { id: true },
    });
    if (active) throw httpError(409, `Meeting already has an active bot session (${active.id})`);

    const sessionId = randomUUID();
    await prisma.$transaction([
      prisma.recordingSession.create({
        data: {
          id: sessionId,
          meetingId,
          method: "BOT",
          status: "PENDING",
          botProvider: options.provider.name,
          botJoinStatus: "SCHEDULED",
          botMeetingUrl: parsedUrl.normalizedUrl,
          botName: body.botName ?? DEFAULT_BOT_NAME,
          botScheduledJoinAt: scheduledJoinAt,
          startedByUserId: auth.userId,
          tracks: { create: { sourceTrack: BOT_TRACK, storagePrefix: `recordings/${sessionId}/${BOT_TRACK}` } },
        },
      }),
      prisma.recordingConsent.create({
        data: consentCreateData({ meetingId, recordingSessionId: sessionId, userId: auth.userId, consent: body.consent }),
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
      prisma.meeting.update({
        where: { id: meetingId },
        data: {
          platform: meeting.platform ?? parsedUrl.platform,
          recordingMethod: meeting.recordingMethod ?? "BOT",
        },
      }),
      prisma.auditLog.create({
        data: {
          organizationId,
          userId: auth.userId,
          action: "BOT_INVITED",
          metadata: {
            recordingSessionId: sessionId,
            meetingId,
            platform: parsedUrl.platform,
            provider: options.provider.name,
            scheduledJoinAt: scheduledJoinAt?.toISOString() ?? null,
          },
        },
      }),
    ]);

    await options.manager.start(sessionId);
    const row = await findOrgBotSession(organizationId, sessionId);
    return reply.status(201).send(toDTO(row!));
  });

  fastify.get("/organizations/:organizationId/meetings/:meetingId/bot-sessions", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const rows = await prisma.recordingSession.findMany({
      where: { meetingId, method: "BOT", meeting: { organizationId, deletedAt: null } },
      include: sessionInclude,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDTO);
  });

  fastify.get("/organizations/:organizationId/bot-sessions/:sessionId", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, sessionId } = sessionParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const row = await findOrgBotSession(organizationId, sessionId);
    if (!row) throw httpError(404, "Bot session not found");
    return toDTO(row);
  });

  fastify.post("/organizations/:organizationId/bot-sessions/:sessionId/leave", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, sessionId } = sessionParams.parse(request.params);
    requireMember(auth, organizationId);
    const before = await findOrgBotSession(organizationId, sessionId);
    if (!before) throw httpError(404, "Bot session not found");
    const wasActive = NON_TERMINAL_BOT_STATUSES.includes(toBotSessionRecord(before).status);

    try {
      await options.manager.leave(sessionId);
    } catch (error) {
      if (error instanceof BotLeaveError) throw httpError(502, error.message);
      throw error;
    }

    if (wasActive) {
      await prisma.auditLog.create({
        data: {
          organizationId,
          userId: auth.userId,
          action: "BOT_LEFT",
          metadata: { recordingSessionId: sessionId, reason: "requested" },
        },
      });
    }
    const row = await findOrgBotSession(organizationId, sessionId);
    return toDTO(row!);
  });
}
