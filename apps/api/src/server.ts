import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Re-arm scheduled bot joins / in-call audio routing lost on the last
// restart. Not fatal: a DB hiccup here shouldn't take the API down, but it
// does mean scheduled bots won't join until the next successful restore.
try {
  await app.botSessionManager.restore();
} catch (error) {
  app.log.error(error, "Failed to restore meeting bot sessions");
}
