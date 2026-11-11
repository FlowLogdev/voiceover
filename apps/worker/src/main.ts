import { createLlmProvider } from "@voiceover/ai";
import { prisma } from "@voiceover/database";
import { LocalDiskObjectStore } from "@voiceover/storage";
import { env } from "./env.js";
import { AnalysisRunner } from "./analysis-runner.js";
import { RecordingFinalizer } from "./finalizer.js";

/**
 * Worker process: finalizes ended recordings (RecordingFinalizer), then runs
 * the AI analyses they queue (AnalysisRunner). Safe to run several copies;
 * jobs are claimed with leases in Postgres.
 */
const finalizer = new RecordingFinalizer({ objectStore: new LocalDiskObjectStore(env.AUDIO_STORAGE_DIR) });
// Throws at startup for an unknown LLM_PROVIDER rather than silently running the test double.
const llm = createLlmProvider({ provider: env.LLM_PROVIDER, model: env.LLM_MODEL, effort: env.LLM_EFFORT });
const analysis = new AnalysisRunner({ llm });

let stopping = false;
let wake: (() => void) | null = null;

async function loop(): Promise<void> {
  console.info(`Worker started; audio store at ${env.AUDIO_STORAGE_DIR}; LLM provider ${llm.name}`);
  while (!stopping) {
    // Each pass is independent: a failure in one (e.g. the database briefly unreachable) doesn't skip the other.
    for (const [name, pass] of [
      ["Finalization", () => finalizer.runOnce()],
      ["Analysis", () => analysis.runOnce()],
    ] as const) {
      if (stopping) break;
      try {
        await pass();
      } catch (error) {
        console.error(`${name} pass failed`, error);
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, env.FINALIZE_POLL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  await prisma.$disconnect();
  console.info("Worker stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Finish the session in hand, then exit; an interrupted one is re-claimed when its lease expires.
    stopping = true;
    wake?.();
  });
}

void loop();
