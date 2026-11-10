import type { FastifyInstance } from "fastify";
import type { AudioChunkFrame } from "@voiceover/audio";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@voiceover/auth";
import type { AsrProvider } from "@voiceover/transcription";
import { clientMessageSchema, type ServerMessage } from "@voiceover/types";
import type { ChunkStore } from "../recording/chunk-store.js";
import type { RecordingControl } from "../recording/recording-control.js";
import { TrackIngestion, type TranscriptBus } from "../recording/track-ingestion.js";
import type { UploadAuthorizer } from "../recording/upload-authorizer.js";
import { env } from "../env.js";

/** Close code when the ownership check itself couldn't run (DB down etc.). Clients may retry. */
const CLOSE_AUTHORIZATION_UNAVAILABLE = 1011;

/**
 * Browser-capture audio upload. Close codes:
 *   4001 unauthenticated
 *   4003 not the user who started this recording, or consent not in effect / revoked
 *   4004 track not found (or belongs to another organization: same answer, so ids can't be probed)
 *   4009 recording session stopped / not active
 *   1011 authorization check unavailable (retryable)
 */
export async function recordingWsRoutes(
  fastify: FastifyInstance,
  options: {
    chunkStore: ChunkStore;
    asrProvider: AsrProvider;
    transcriptBus: TranscriptBus;
    uploadAuthorizer: UploadAuthorizer;
    recordingControl: RecordingControl;
  },
) {
  fastify.get(
    "/recording-tracks/:recordingTrackId/audio",
    { websocket: true },
    (socket, request) => {
      const { recordingTrackId } = request.params as { recordingTrackId: string };
      const { recordingControl } = options;

      function sendMessage(message: ServerMessage) {
        socket.send(JSON.stringify(message));
      }

      // One ingestion pipeline (chunk store -> ASR -> transcript events) per
      // connection: the same TrackIngestion the meeting bot path uses.
      // Transcription runs against a deterministic test double, not a real
      // ASR provider (ARCHITECTURE.md section 5). Transcript segments are
      // relayed live only, not yet persisted (Phase 5).
      const ingestion = new TrackIngestion(recordingTrackId, options);
      ingestion.onTranscript((message) => sendMessage(message));

      let expectedSourceTrack: string | null = null;

      async function handleRawMessage(raw: Buffer) {
        // Covers frames already in flight when a stop/revoke closed the socket.
        if (recordingControl.isStopped(recordingTrackId)) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          sendMessage({ type: "error", message: "Invalid JSON" });
          return;
        }

        const result = clientMessageSchema.safeParse(parsed);
        if (!result.success) {
          sendMessage({ type: "error", message: "Invalid message shape" });
          return;
        }

        const msg = result.data;
        if (msg.sourceTrack !== expectedSourceTrack) {
          sendMessage({
            type: "error",
            message: `sourceTrack "${msg.sourceTrack}" does not match this recording track ("${expectedSourceTrack}")`,
          });
          return;
        }
        const frame: AudioChunkFrame = {
          sequenceNumber: msg.sequenceNumber,
          startMs: msg.startMs,
          endMs: msg.endMs,
          sourceTrack: msg.sourceTrack,
          sampleRate: msg.sampleRate,
          bytes: Buffer.from(msg.bytesBase64, "base64"),
          checksum: msg.checksum,
        };

        const ingested = await ingestion.ingest(frame, () =>
          sendMessage({ type: "ack", sequenceNumber: frame.sequenceNumber }),
        );
        if (!ingested.ok) {
          sendMessage({ type: "error", message: ingested.error });
        }
      }

      // Buffer messages that arrive while the (async) auth + ownership check
      // below is still pending, so a client that sends immediately after the
      // socket opens can't have its first chunk silently dropped. Nothing is
      // stored until the check passes; on failure the buffer is discarded.
      const pending: Buffer[] = [];
      let authorized = false;
      let closed = false;
      let unregister: (() => void) | null = null;
      socket.on("message", (raw: Buffer) => {
        if (authorized) {
          void handleRawMessage(raw);
        } else {
          pending.push(raw);
        }
      });

      socket.on("close", () => {
        closed = true;
        pending.length = 0;
        unregister?.();
        ingestion.finalize();
      });

      const token = request.cookies[SESSION_COOKIE_NAME];
      if (!token) {
        socket.close(4001, "Authentication required");
        return;
      }

      // Ownership: the track must be a server-issued browser track in a
      // session this user started, still active, with consent in effect (see
      // PrismaUploadAuthorizer). Checked once per connection; an open socket
      // is closed immediately on stop/consent revocation via RecordingControl.
      void (async () => {
        let userId: string;
        try {
          ({ userId } = await verifySessionToken(token, env.SESSION_SECRET));
        } catch {
          socket.close(4001, "Authentication required");
          return;
        }

        let decision;
        try {
          decision = await options.uploadAuthorizer.authorize(userId, recordingTrackId);
        } catch (error) {
          request.log.error(error, "Upload authorization check failed");
          socket.close(CLOSE_AUTHORIZATION_UNAVAILABLE, "Authorization check unavailable");
          return;
        }
        if (closed) return;
        if (!decision.ok) {
          socket.close(decision.closeCode, decision.reason);
          return;
        }

        if (recordingControl.isStopped(recordingTrackId)) {
          socket.close(4009, "Recording session is not active"); // stopped while we were checking
          return;
        }
        expectedSourceTrack = decision.sourceTrack;
        unregister = recordingControl.registerUpload(recordingTrackId, (code, reason) => socket.close(code, reason));
        authorized = true;
        for (const raw of pending.splice(0)) {
          void handleRawMessage(raw);
        }
      })();
    },
  );
}
