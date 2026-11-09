import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, "dist");
const watch = process.argv.includes("--watch");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync(join(__dirname, "public"), outdir, { recursive: true });

const entryPoints = {
  background: "src/background/service-worker.ts",
  offscreen: "src/offscreen/offscreen.ts",
  popup: "src/popup/popup.ts",
  worklet: "src/worklet/pcm-capture-processor.ts",
};

const options = {
  entryPoints,
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir,
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await build(options);
}
