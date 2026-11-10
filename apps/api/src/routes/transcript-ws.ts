import type { FastifyInstance } from "fastify";
import { prisma } from "@voiceover/database";
import type { TranscriptBus } from "../recording/track-ingestion.js";

/**
 * Read-only live transcript feed for any recording track the caller's
 * organization owns — e.g. the web UI watching a meeting bot that's uploading
 * server-side. Unlike the ingestion socket this needs the full auth context
 * (memberships), since the ownership check is track -> session -> meeting ->
 * organization.
 *
 * Close codes: 4001 unauthenticated, 4004 track not found / not yours.
 */
export async function transcriptWsRoutes(fastify: FastifyInstance, options: { transcriptBus: TranscriptBus }) {
  fastify.get("/recording-tracks/:recordingTrackId/transcript", { websocket: true }, (socket, request) => {
    const { recordingTrackId } = request.params as { recordingTrackId: string };
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    socket.on("close", () => {
      closed = true;
      unsubscribe?.();
    });

    const auth = request.auth;
    if (!auth) {
      socket.close(4001, "Authentication required");
      return;
    }

    const organizationIds = auth.memberships.map((m) => m.organizationId);
    void prisma.recordingTrack
      .findFirst({
        where: {
          id: recordingTrackId,
          recordingSession: { meeting: { organizationId: { in: organizationIds }, deletedAt: null } },
        },
        select: { id: true },
      })
      .catch(() => null)
      .then((track) => {
        if (closed) return;
        if (!track) {
          socket.close(4004, "Recording track not found");
          return;
        }
        unsubscribe = options.transcriptBus.subscribe(recordingTrackId, (message) => {
          socket.send(JSON.stringify(message));
        });
        socket.send(JSON.stringify({ type: "subscribed", recordingTrackId }));
      });
  });
}
