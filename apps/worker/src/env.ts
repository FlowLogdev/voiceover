import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Same default as the API (repo-root `.data/audio`), so both share one store out of the box. */
const DEFAULT_AUDIO_STORAGE_DIR = fileURLToPath(new URL("../../../.data/audio", import.meta.url));

const envSchema = z.object({
  AUDIO_STORAGE_DIR: z.string().default(DEFAULT_AUDIO_STORAGE_DIR),
  /** How often to look for sessions to finalize when idle. */
  FINALIZE_POLL_MS: z.coerce.number().int().positive().default(5_000),
  /** "anthropic" or unset/"test-double" (see @voiceover/ai createLlmProvider). */
  LLM_PROVIDER: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_EFFORT: z.string().optional(),
});

export const env = envSchema.parse({
  AUDIO_STORAGE_DIR: process.env.AUDIO_STORAGE_DIR || undefined,
  FINALIZE_POLL_MS: process.env.FINALIZE_POLL_MS || undefined,
  LLM_PROVIDER: process.env.LLM_PROVIDER || undefined,
  LLM_MODEL: process.env.LLM_MODEL || undefined,
  LLM_EFFORT: process.env.LLM_EFFORT || undefined,
});
