import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasAtLeastRole } from "@voiceover/auth";
import { forOrganization, prisma } from "@voiceover/database";
import type { ObjectStore } from "@voiceover/storage";
import {
  renameSpeakerRequestSchema,
  type MeetingDetailDTO,
  type MeetingTranscriptDTO,
  type SpeakerDTO,
} from "@voiceover/types";
import { httpError } from "../http-error.js";
import { requireAuth, requireOrganization } from "../plugins/auth-context.js";

const orgParams = z.object({ organizationId: z.string().uuid() });
const meetingParams = orgParams.extend({ meetingId: z.string().uuid() });
const speakerParams = meetingParams.extend({ speakerId: z.string().uuid() });
const trackParams = orgParams.extend({ recordingTrackId: z.string().uuid() });

function toSpeakerDTO(s: { id: string; label: string; displayName: string | null; externalKey: string | null }): SpeakerDTO {
  return {
    id: s.id,
    label: s.label,
    displayName: s.displayName,
    attribution: s.externalKey?.includes(":asr:") ? "diarization" : "source",
  };
}

/**
 * Parses a single-range `Range: bytes=...` header against an object of
 * `size` bytes. Returns null for "no/unsupported range -> send everything",
 * or "unsatisfiable" for a 416.
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multi-range or malformed: ignore, serve the full body
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Meeting detail page data: meeting + speakers + recording tracks, the
 * persisted transcript, speaker rename, and playback audio for finalized
 * tracks. Every lookup is scoped through the meeting's organization.
 */
export async function meetingDetailRoutes(fastify: FastifyInstance, options: { objectStore: ObjectStore }) {
  fastify.get("/organizations/:organizationId/meetings/:meetingId", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const meeting = await forOrganization(organizationId).meeting.findFirst({
      where: { id: meetingId, deletedAt: null },
      select: {
        id: true,
        title: true,
        platform: true,
        startedAt: true,
        endedAt: true,
        recordingMethod: true,
        speakers: { orderBy: { createdAt: "asc" }, select: { id: true, label: true, displayName: true, externalKey: true } },
        recordingSessions: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            method: true,
            status: true,
            failureReason: true,
            tracks: {
              orderBy: { createdAt: "asc" },
              select: { id: true, sourceTrack: true, durationMs: true, missingChunkCount: true, playbackStorageKey: true },
            },
          },
        },
      },
    });
    if (!meeting) throw httpError(404, "Meeting not found");

    const response: MeetingDetailDTO = {
      id: meeting.id,
      title: meeting.title,
      platform: meeting.platform,
      startedAt: meeting.startedAt?.toISOString() ?? null,
      endedAt: meeting.endedAt?.toISOString() ?? null,
      recordingMethod: meeting.recordingMethod,
      speakers: meeting.speakers.map(toSpeakerDTO),
      tracks: meeting.recordingSessions.flatMap((session) =>
        session.tracks.map((track) => ({
          id: track.id,
          recordingSessionId: session.id,
          method: session.method,
          sourceTrack: track.sourceTrack,
          sessionStatus: session.status,
          durationMs: track.durationMs,
          missingChunkCount: track.missingChunkCount,
          playbackAvailable: track.playbackStorageKey !== null,
          failureReason: session.failureReason,
        })),
      ),
    };
    return response;
  });

  fastify.get("/organizations/:organizationId/meetings/:meetingId/transcript", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId } = meetingParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const meeting = await forOrganization(organizationId).meeting.findFirst({
      where: { id: meetingId, deletedAt: null },
      select: {
        transcriptSegments: {
          where: { isFinal: true },
          orderBy: [{ startMs: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            recordingTrackId: true,
            sourceTrack: true,
            speakerId: true,
            startMs: true,
            endMs: true,
            text: true,
            languageCode: true,
            provider: true,
          },
        },
        languageSegments: { orderBy: { startMs: "asc" }, select: { languageCode: true, startMs: true, endMs: true } },
      },
    });
    if (!meeting) throw httpError(404, "Meeting not found");
    const response: MeetingTranscriptDTO = { segments: meeting.transcriptSegments, languages: meeting.languageSegments };
    return response;
  });

  fastify.patch("/organizations/:organizationId/meetings/:meetingId/speakers/:speakerId", async (request) => {
    const auth = requireAuth(request);
    const { organizationId, meetingId, speakerId } = speakerParams.parse(request.params);
    const membership = requireOrganization(auth, organizationId);
    if (!hasAtLeastRole(membership.role, "MEMBER")) throw httpError(403, "Guests cannot rename speakers");
    const body = renameSpeakerRequestSchema.parse(request.body);
    const speaker = await prisma.speaker.findFirst({
      where: { id: speakerId, meetingId, meeting: { organizationId, deletedAt: null } },
      select: { id: true },
    });
    if (!speaker) throw httpError(404, "Speaker not found");
    const updated = await prisma.speaker.update({
      where: { id: speaker.id },
      data: { displayName: body.displayName },
      select: { id: true, label: true, displayName: true, externalKey: true },
    });
    return toSpeakerDTO(updated);
  });

  fastify.get("/organizations/:organizationId/recording-tracks/:recordingTrackId/playback", async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId, recordingTrackId } = trackParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const track = await prisma.recordingTrack.findFirst({
      where: { id: recordingTrackId, recordingSession: { meeting: { organizationId, deletedAt: null } } },
      select: { playbackStorageKey: true },
    });
    if (!track) throw httpError(404, "Recording track not found");
    if (!track.playbackStorageKey) throw httpError(404, "Playback is not available until the recording is finalized");

    const size = await options.objectStore.size(track.playbackStorageKey);
    if (size === null) throw httpError(404, "Playback file is missing");

    const range = parseByteRange(request.headers.range, size);
    // Authenticated per request with the session cookie; signed, short-lived
    // object-store URLs replace this once real object storage exists (Phase 10).
    reply.header("Content-Type", "audio/wav").header("Accept-Ranges", "bytes").header("Cache-Control", "private, no-store");
    if (range === "unsatisfiable") {
      return reply.status(416).header("Content-Range", `bytes */${size}`).send();
    }
    if (range) {
      return reply
        .status(206)
        .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
        .header("Content-Length", range.end - range.start + 1)
        .send(options.objectStore.read(track.playbackStorageKey, range));
    }
    return reply.header("Content-Length", size).send(options.objectStore.read(track.playbackStorageKey));
  });
}
