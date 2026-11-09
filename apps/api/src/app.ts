import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { ZodIssue } from "zod";
import { TestDoubleAsrProvider, type AsrProvider } from "@voiceover/transcription";
import { authContextPlugin } from "./plugins/auth-context.js";
import { authRoutes } from "./routes/auth.js";
import { meetingRoutes } from "./routes/meetings.js";
import { recordingWsRoutes } from "./routes/recording-ws.js";
import { PrismaFileChunkStore } from "./recording/prisma-file-chunk-store.js";
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
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const chunkStore = options.chunkStore ?? new PrismaFileChunkStore(env.AUDIO_STORAGE_DIR);
  // No real streaming ASR provider is selected/provisioned yet (see
  // ARCHITECTURE.md section 5) — this is a deterministic test double, not
  // real transcription. Swap behind the same AsrProvider interface once one is.
  const asrProvider = options.asrProvider ?? new TestDoubleAsrProvider();

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
  await app.register(recordingWsRoutes, { chunkStore, asrProvider });

  return app;
}
