import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { ZodIssue } from "zod";
import { TestDoubleAsrProvider, type AsrProvider } from "@voiceover/transcription";
import { prisma } from "@voiceover/database";
import {
  AdmissionRetryPolicy,
  BotSessionManager,
  TestDoubleMeetingBotProvider,
  type BotSessionRepository,
  type BotStatusChange,
  type MeetingBotProvider,
} from "@voiceover/meeting-bot";
import { authContextPlugin } from "./plugins/auth-context.js";
import { authRoutes } from "./routes/auth.js";
import { meetingRoutes } from "./routes/meetings.js";
import { recordingWsRoutes } from "./routes/recording-ws.js";
import { botSessionRoutes } from "./routes/bot-sessions.js";
import { transcriptWsRoutes } from "./routes/transcript-ws.js";
import { recordingSessionRoutes } from "./routes/recording-sessions.js";
import { RecordingControl } from "./recording/recording-control.js";
import { PrismaUploadAuthorizer, type UploadAuthorizer } from "./recording/upload-authorizer.js";
import { BotIngestionSink } from "./meeting-bot/bot-audio-sink.js";
import { PrismaBotSessionRepository } from "./meeting-bot/prisma-bot-session-repository.js";
import { TrackIngestion, TranscriptBus } from "./recording/track-ingestion.js";
import { PrismaFileChunkStore } from "./recording/prisma-file-chunk-store.js";
import { PrismaTranscriptStore, type TranscriptStore } from "./recording/transcript-store.js";
import { meetingDetailRoutes } from "./routes/meeting-detail.js";
import { LocalDiskObjectStore, type ObjectStore } from "@voiceover/storage";
import type { ChunkStore } from "./recording/chunk-store.js";
import { env } from "./env.js";

/**
 * Duck-typed check instead of `instanceof ZodError`: zod ships internal v3/v4
 * compat shims where the class identity doesn't reliably survive crossing a
 * package boundary, so `instanceof` can silently fail even for a genuine
 * ZodError raised inside another workspace package.
 */
function isZodError(error: unknown): error is { name: "ZodError"; issues: ZodIssue[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

export interface BuildAppOptions {
  chunkStore?: ChunkStore;
  asrProvider?: AsrProvider;
  meetingBotProvider?: MeetingBotProvider;
  botSessionRepository?: BotSessionRepository;
  botRetryPolicy?: AdmissionRetryPolicy;
  /** Recorded audio (chunks, playback files). Defaults to local disk at AUDIO_STORAGE_DIR. */
  objectStore?: ObjectStore;
  /** Final transcript segments. Defaults to Postgres. */
  transcriptStore?: TranscriptStore;
  /** Who may upload to which browser-capture track. Defaults to the Prisma-backed ownership check. */
  uploadAuthorizer?: UploadAuthorizer;
}

declare module "fastify" {
  interface FastifyInstance {
    botSessionManager: BotSessionManager;
    transcriptBus: TranscriptBus;
    recordingControl: RecordingControl;
  }
}

function createMeetingBotProvider(): MeetingBotProvider {
  // No real meeting-bot provider is provisioned yet (ARCHITECTURE.md section
  // 5). Fail loudly rather than silently running the simulator if someone
  // configures a provider name we don't have an adapter for.
  const configured = env.MEETING_BOT_PROVIDER;
  if (configured && configured !== "test-double") {
    throw new Error(`MEETING_BOT_PROVIDER="${configured}" has no adapter yet — only "test-double" is implemented`);
  }
  return new TestDoubleMeetingBotProvider();
}

/**
 * Audit-logs bot exits the user didn't ask for (meeting ended, removed by
 * host). User-requested leaves are logged by the leave route itself, with
 * the acting user attached.
 */
async function auditProviderInitiatedLeave({ previous, session }: BotStatusChange): Promise<void> {
  if (session.status !== "LEFT" || session.failureReason === null || previous === "LEFT") return;
  const row = await prisma.recordingSession.findUnique({
    where: { id: session.id },
    select: { meeting: { select: { organizationId: true } } },
  });
  if (!row) return;
  await prisma.auditLog.create({
    data: {
      organizationId: row.meeting.organizationId,
      action: "BOT_LEFT",
      metadata: { recordingSessionId: session.id, reason: session.failureReason },
    },
  });
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const objectStore = options.objectStore ?? new LocalDiskObjectStore(env.AUDIO_STORAGE_DIR);
  const chunkStore = options.chunkStore ?? new PrismaFileChunkStore(objectStore);
  const transcriptStore = options.transcriptStore ?? new PrismaTranscriptStore();
  // No real streaming ASR provider is selected/provisioned yet (see
  // ARCHITECTURE.md section 5) — this is a deterministic test double, not
  // real transcription. Swap behind the same AsrProvider interface once one is.
  const asrProvider = options.asrProvider ?? new TestDoubleAsrProvider();
  const transcriptBus = new TranscriptBus();
  const recordingControl = new RecordingControl();
  const meetingBotProvider = options.meetingBotProvider ?? createMeetingBotProvider();
  const botSessionManager = new BotSessionManager({
    provider: meetingBotProvider,
    repository: options.botSessionRepository ?? new PrismaBotSessionRepository(),
    retryPolicy: options.botRetryPolicy,
    audioSink: new BotIngestionSink(
      (recordingTrackId) =>
        new TrackIngestion(recordingTrackId, {
          chunkStore,
          asrProvider,
          transcriptBus,
          transcriptStore,
          logError: (error, message) => app.log.error(error, message),
        }),
      (recordingTrackId) => recordingControl.isStopped(recordingTrackId),
    ),
    onStatusChange: auditProviderInitiatedLeave,
    logError: (error, message) => app.log.error(error, message),
  });
  app.decorate("botSessionManager", botSessionManager);
  app.decorate("transcriptBus", transcriptBus);
  app.decorate("recordingControl", recordingControl);
  app.addHook("onClose", async () => botSessionManager.shutdown());

  await app.register(cors, { origin: env.APP_URL, credentials: true });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(authContextPlugin);

  app.get("/health", async () => ({ status: "ok" }));

  // Must be set before registering route plugins: Fastify's encapsulation
  // means a child context captures the error handler in effect at the time
  // it boots, so setting this afterward would silently not apply to routes
  // registered via `app.register(...)`.
  app.setErrorHandler((error, _request, reply) => {
    if (isZodError(error)) {
      return reply.status(400).send({ error: "Validation error", issues: error.issues });
    }
    const err = error as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      app.log.error(err);
    }
    return reply.status(statusCode).send({ error: err.message });
  });

  await app.register(authRoutes);
  await app.register(meetingRoutes);
  await app.register(recordingWsRoutes, {
    chunkStore,
    asrProvider,
    transcriptBus,
    transcriptStore,
    uploadAuthorizer: options.uploadAuthorizer ?? new PrismaUploadAuthorizer(),
    recordingControl,
  });
  await app.register(transcriptWsRoutes, { transcriptBus });
  await app.register(botSessionRoutes, { manager: botSessionManager, provider: meetingBotProvider });
  await app.register(recordingSessionRoutes, { manager: botSessionManager, control: recordingControl });
  await app.register(meetingDetailRoutes, { objectStore });

  return app;
}
