import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Repo-root `.data/audio`, resolved from this file (src/ and dist/ sit at the
 * same depth), so the API and the worker share one store by default whatever
 * directory each is started from. Set AUDIO_STORAGE_DIR to override.
 */
const DEFAULT_AUDIO_STORAGE_DIR = fileURLToPath(new URL("../../../.data/audio", import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  SESSION_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-me-please"),
  APP_URL: z.string().default("http://localhost:3000"),
  // Local-disk placeholder for S3-compatible storage (see @voiceover/storage).
  AUDIO_STORAGE_DIR: z.string().default(DEFAULT_AUDIO_STORAGE_DIR),
  // Only "test-double" has an adapter so far; empty/unset means test-double.
  MEETING_BOT_PROVIDER: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

function computeEnv(): Env {
  return envSchema.parse({
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    SESSION_SECRET: process.env.SESSION_SECRET,
    APP_URL: process.env.APP_URL,
    AUDIO_STORAGE_DIR: process.env.AUDIO_STORAGE_DIR || undefined,
    MEETING_BOT_PROVIDER: process.env.MEETING_BOT_PROVIDER || undefined,
  });
}

/**
 * Re-parses `process.env` on every property access instead of caching a
 * singleton at module-load time. A plain `export const env = envSchema.parse(...)`
 * bakes in whatever `process.env` held the instant this module was first
 * imported — since ES module imports are evaluated before the importing
 * module's own top-level code runs, anything that sets `process.env.X` in a
 * test's `beforeEach` (a common pattern) would silently have no effect.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return computeEnv()[prop as keyof Env];
  },
});
