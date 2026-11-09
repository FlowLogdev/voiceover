import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createMeetingRequestSchema, type MeetingSummaryDTO } from "@voiceover/types";
import { forOrganization } from "@voiceover/database";
import { requireAuth, requireOrganization } from "../plugins/auth-context.js";

const organizationParamSchema = z.object({ organizationId: z.string().uuid() });

export async function meetingRoutes(fastify: FastifyInstance) {
  fastify.get("/organizations/:organizationId/meetings", async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId } = organizationParamSchema.parse(request.params);
    requireOrganization(auth, organizationId);

    const db = forOrganization(organizationId);
    const meetings = await db.meeting.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        platform: true,
        startedAt: true,
        endedAt: true,
        recordingMethod: true,
      },
    });

    const response: MeetingSummaryDTO[] = meetings.map((m) => ({
      id: m.id,
      title: m.title,
      platform: m.platform,
      startedAt: m.startedAt?.toISOString() ?? null,
      endedAt: m.endedAt?.toISOString() ?? null,
      recordingMethod: m.recordingMethod,
    }));
    return reply.send(response);
  });

  fastify.post("/organizations/:organizationId/meetings", async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId } = organizationParamSchema.parse(request.params);
    requireOrganization(auth, organizationId);
    const body = createMeetingRequestSchema.parse(request.body);

    const db = forOrganization(organizationId);
    const meeting = await db.meeting.create({
      data: {
        organizationId,
        hostUserId: auth.userId,
        title: body.title,
        platform: body.platform,
        scheduledStart: body.scheduledStart ? new Date(body.scheduledStart) : undefined,
        scheduledEnd: body.scheduledEnd ? new Date(body.scheduledEnd) : undefined,
        recordingMethod: body.recordingMethod,
      },
    });

    return reply.status(201).send({ id: meeting.id });
  });
}
