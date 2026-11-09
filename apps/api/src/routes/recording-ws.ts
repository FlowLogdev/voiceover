import type { FastifyInstance } from "fastify";
import { verifyChunkFrame, type AudioChunkFrame } from "@voiceover/audio";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@voiceover/auth";
import type { AsrEvent, AsrProvider, AsrSession } from "@voiceover/transcription";
import { clientMessageSchema, type ServerMessage } from "@voiceover/types";
import type { ChunkStore } from "../recording/chunk-store.js";
import { env } from "../env.js";

/** Decodes base64 PCM16LE bytes into an Int16Array with a guaranteed-aligned,
 * freshly-allocated backing buffer — `Buffer.from(base64)` can return a view
 * into a shared, arbitrarily-offset pool, and `Int16Array` requires its
 * buffer offset to be a multiple of 2, so reusing that buffer directly risks
 * a RangeError for a subset of base64 inputs. */
function decodePcm16(bytesBase64: string): Int16Array {
  const raw = Buffer.from(bytesBase64, "base64");
  const aligned = new Uint8Array(raw.length);
  aligned.set(raw);
  return new Int16Array(aligned.buffer);
}

function toServerMessage(event: AsrEvent): ServerMessage | null {
  switch (event.type) {
    case "partial":
      return {
        type: "transcript.partial",
        segmentId: event.segmentId,
        sourceTrack: event.sourceTrack,
        startMs: event.startMs,
        endMs: event.endMs,
        text: event.text,
        languageCode: event.languageCode,
      };
    case "final":
      return {
        type: "transcript.final",
        segmentId: event.segmentId,
        sourceTrack: event.sourceTrack,
        startMs: event.startMs,
        endMs: event.endMs,
        text: event.text,
        languageCode: event.languageCode,
      };
    case "language_detected":
      return {
        type: "language.detected",
        sourceTrack: event.sourceTrack,
        languageCode: event.languageCode,
        confidence: event.confidence,
      };
    default:
      return null;
  }
}

export async function recordingWsRoutes(
  fastify: FastifyInstance,
  options: { chunkStore: ChunkStore; asrProvider: AsrProvider },
) {
  fastify.get(
    "/recording-tracks/:recordingTrackId/audio",
    { websocket: true },
    (socket, request) => {
      const { recordingTrackId } = request.params as { recordingTrackId: string };

      function sendMessage(message: ServerMessage) {
        socket.send(JSON.stringify(message));
      }

      // One ASR session per connection/track, created lazily from the first
      // chunk's sourceTrack. Transcription here runs against a deterministic
      // test double, not a real ASR provider — see ARCHITECTURE.md section 5
      // and packages/transcription's test-double-provider.ts. Transcript
      // segments are relayed live over this socket only; they are not yet
      // persisted (TranscriptSegment requires a real meetingId, which
      // doesn't exist until the recording-session/track creation endpoint —
      // the Phase 2 gap already tracked in FEATURE_MATRIX.md — is built).
      let asrSession: AsrSession | null = null;

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

        if (!verifyChunkFrame(frame)) {
          sendMessage({ type: "error", message: `Checksum mismatch for sequence ${frame.sequenceNumber}` });
          return;
        }

        await options.chunkStore.saveChunk(recordingTrackId, frame);
        sendMessage({ type: "ack", sequenceNumber: frame.sequenceNumber });

        if (!asrSession) {
          asrSession = options.asrProvider.createSession({ sourceTrack: msg.sourceTrack });
          asrSession.onEvent((event) => {
            const serverMessage = toServerMessage(event);
            if (serverMessage) sendMessage(serverMessage);
          });
        }
        asrSession.pushAudio({
          sequenceNumber: msg.sequenceNumber,
          startMs: msg.startMs,
          endMs: msg.endMs,
          sampleRate: msg.sampleRate,
          samples: decodePcm16(msg.bytesBase64),
        });
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
        asrSession?.finalize();
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
