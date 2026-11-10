import type { FastifyInstance } from "fastify";
import type { AudioChunkFrame } from "@voiceover/audio";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@voiceover/auth";
import type { AsrProvider } from "@voiceover/transcription";
import { clientMessageSchema, type ServerMessage } from "@voiceover/types";
import type { ChunkStore } from "../recording/chunk-store.js";
import { TrackIngestion, type TranscriptBus } from "../recording/track-ingestion.js";
import { env } from "../env.js";

export async function recordingWsRoutes(
  fastify: FastifyInstance,
  options: { chunkStore: ChunkStore; asrProvider: AsrProvider; transcriptBus: TranscriptBus },
) {
  fastify.get(
    "/recording-tracks/:recordingTrackId/audio",
    { websocket: true },
    (socket, request) => {
      const { recordingTrackId } = request.params as { recordingTrackId: string };

      function sendMessage(message: ServerMessage) {
        socket.send(JSON.stringify(message));
      }

      // One ingestion pipeline (chunk store -> ASR -> transcript events) per
      // connection — the same TrackIngestion the meeting bot path uses.
      // Transcription runs against a deterministic test double, not a real
      // ASR provider (ARCHITECTURE.md section 5). Transcript segments are
      // relayed live only, not yet persisted: TranscriptSegment requires a
      // real meetingId, and this browser path's recordingTrackId is still
      // client-generated (the Phase 2 gap tracked in FEATURE_MATRIX.md).
      const ingestion = new TrackIngestion(recordingTrackId, options);
      ingestion.onTranscript((message) => sendMessage(message));

      async function handleRawMessage(raw: Buffer) {
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

      // Buffer messages that arrive while the (async) auth check below is
      // still pending, so a client that sends immediately after the socket
      // opens can't have its first chunk silently dropped by a listener
      // that wasn't attached yet.
      const pending: Buffer[] = [];
      let authorized = false;
      socket.on("message", (raw: Buffer) => {
        if (authorized) {
          void handleRawMessage(raw);
        } else {
          pending.push(raw);
        }
      });

      socket.on("close", () => {
        ingestion.finalize();
      });

      // Auth note: verifies the session JWT only — deliberately does not
      // depend on the membership DB lookup that the global auth-context hook
      // performs, so this long-lived ingestion connection doesn't need a DB
      // round trip on every (re)connect. Tenant/track-ownership verification
      // (does this user's org own this recordingTrackId?) is not yet wired
      // up — that depends on the recording-session/track creation endpoints,
      // which are a follow-on piece of Phase 2 not built in this pass.
      // Tracked in FEATURE_MATRIX.md.
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (!token) {
        socket.close(4001, "Authentication required");
        return;
      }
      void verifySessionToken(token, env.SESSION_SECRET)
        .then(() => {
          authorized = true;
          for (const raw of pending.splice(0)) {
            void handleRawMessage(raw);
          }
        })
        .catch(() => {
          socket.close(4001, "Authentication required");
        });
    },
  );
}
