import { prisma } from "@voiceover/database";
import { LocalDiskObjectStore } from "@voiceover/storage";
import { env } from "./env.js";
import { RecordingFinalizer } from "./finalizer.js";

/**
 * Worker process: finalizes ended recordings (see RecordingFinalizer). Safe to
 * run several copies; sessions are claimed with a lease in Postgres.
 */
const finalizer = new RecordingFinalizer({ objectStore: new LocalDiskObjectStore(env.AUDIO_STORAGE_DIR) });

let stopping = false;
let wake: (() => void) | null = null;

async function loop(): Promise<void> {
  console.info(`Worker started; audio store at ${env.AUDIO_STORAGE_DIR}`);
  while (!stopping) {
    try {
      await finalizer.runOnce();
    } catch (error) {
      // e.g. the database is briefly unreachable: keep polling.
      console.error("Finalization pass failed", error);
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
