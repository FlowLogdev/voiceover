# VoiceOver AI — Feature Matrix

Status values: **Implemented and tested**, **Implemented awaiting external validation**,
**Blocked by external dependency**, **Not implemented**. Updated as work proceeds —
nothing is marked tested without an actual test run.

| Area | Feature | Status | Notes |
| --- | --- | --- | --- |
| Foundation | Monorepo (pnpm/Turborepo), shared config | Implemented and tested | `pnpm install` + `turbo build` run clean |
| Foundation | Prisma schema + seed script, synced via `prisma db push` against a real Postgres | Implemented and tested | Verified in CI (GitHub Actions) against a real `pgvector/pgvector:pg16` service container — schema pushes clean, migrations not yet committed (see note below). Still not run against Docker in this local dev environment (Docker isn't installed here). |
| Foundation | docker-compose (Postgres/Redis/MinIO) | Blocked by external dependency, locally | Compose file written but unverified **in this sandbox** — `docker` isn't installed here. The equivalent Postgres service is verified working in CI; MinIO/Redis aren't exercised by CI yet. Needs Docker Desktop locally to validate the full compose stack. |
| Auth | Password hashing (scrypt), session JWT issuance/verification | Implemented and tested | 9 unit tests in `packages/auth` pass (`pnpm --filter @voiceover/auth test`): correct/incorrect password, salt uniqueness, token round-trip, cross-secret rejection |
| Auth | RBAC role comparison helpers | Implemented and tested | Unit tested in `packages/auth/src/rbac.test.ts` |
| Auth | Email/password signup+login API routes, session cookie | Implemented and tested | Unit tests (no DB) confirm health check, input validation (400), and auth-required (401) paths. `auth.integration.test.ts` (signup, wrong-password rejection, cross-tenant 403) now **passes in CI against a real Postgres service** — first real validation of the DB-backed path. Still not run against a live DB in this local sandbox (no Docker here). |
| Auth | Google/Microsoft OAuth | Blocked by external dependency | Needs OAuth client IDs/secrets |
| Auth | Tenant isolation (API-level, `forOrganization` scoping + 403 on cross-tenant access) | Implemented and tested | Covered by the same CI-passing integration test above: a user in org A gets 403 reading org B's meetings, 200 reading their own (empty) list. |
| Dashboard | Web app shell (Next.js): home, signup, login, dashboard/meetings-list pages | Implemented awaiting external validation | `next build` succeeds, all pages prerender, `tsc --noEmit` passes, and a live smoke test confirms the dev server serves pages and the API's CORS config correctly allows credentialed cross-origin requests from it. The full signup→dashboard flow against a real backend is **not yet verified** (no live DB in this environment). |
| Browser capture | Audio chunking/checksum, WAV header builder, IndexedDB chunk buffer, resumable-upload retry/backoff logic (`packages/audio`) | Implemented and tested | 14 unit tests pass headlessly (no browser needed — IndexedDB via `fake-indexeddb`): PCM conversion/clamping, checksum tamper detection, WAV header fields, chunk ordering, disconnect/reconnect replay, retry backoff |
| Browser capture | Audio ingestion WebSocket (`/recording-tracks/:id/audio`): JSON chunk protocol, checksum verification, idempotent dedupe-by-sequence, ack/error replies | Implemented and tested | 3 integration tests in `apps/api` using a real `ws` client against a real listening server (in-memory chunk store, no DB needed for this protocol layer): rejects missing-cookie connections (4001), acks + dedupes a replayed chunk, rejects a tampered checksum |
| Browser capture | Chrome extension (MV3): background service worker, offscreen document (tabCapture + AudioWorklet + Web Audio playback passthrough), popup UI (start/pause/resume/stop, badge indicator, elapsed time), WebSocket upload client | Implemented awaiting external validation | `tsc --noEmit` and `esbuild` build both pass, producing a loadable unpacked-extension `dist/`. **Not run in an actual Chrome browser** — this environment has no GUI browser and `tabCapture` requires a real user gesture, so this cannot be automated here. See `docs/testing/chrome-extension-manual-test-plan.md` for the checklist a human needs to run. |
| Browser capture | Recording-session/track creation API (so a `recordingTrackId` is server-issued and tenant-owned, not client-generated) | Not implemented | Currently the extension mints its own UUID client-side and the ingestion WS doesn't check tenant/track ownership — flagged explicitly in code and the manual test plan. Needed before this is anything more than a local dev slice. |
| Meeting bot | MeetingBotProvider interface | Not implemented | Phase 4 |
| Meeting bot | Recall.ai-class adapter | Blocked by external dependency | Needs provider account + API validation |
| Transcription | VAD segmenter + `AsrProvider`/`AsrSession` interface + `TestDoubleAsrProvider` (`packages/transcription`) | Implemented and tested | 29 unit tests pass headlessly: RMS energy/speech classification, segment start/continue/end boundaries (including "brief pause doesn't split a segment"), deterministic partial→final event sequencing, per-session language reporting, finalize()-flushes-open-segment |
| Transcription | Live `transcript.partial` / `transcript.final` / `language.detected` events over the recording-audio WebSocket | Implemented and tested | 2 new `apps/api` integration tests (loud audio → events arrive; silent audio → no events) pass against a real listening server; additionally **manually verified against the actually-running dev server** over a real TCP socket using the exact client protocol the web/extension use — ack, language.detected, and incrementing transcript.partial all arrived correctly and in order |
| Transcription | Chrome extension popup renders the live transcript | Implemented awaiting external validation | Build/typecheck clean; relies on the same not-yet-run-in-a-real-browser caveat as the rest of the extension (see Browser capture row above) |
| Transcription | `apps/web` `/recorder/[trackId]` manual-verification page | Implemented awaiting external validation | Builds, typechecks, server-renders correctly (checked directly). The Chrome browser automation extension was not connected in this environment, so nobody has actually clicked its buttons in a live browser tab — the identical WebSocket protocol was verified via a scripted client instead. |
| Transcription | Real streaming ASR (EN/ES/PT) | Blocked by external dependency | Needs provider selection + API key — everything above is built against the interface so swapping in a real adapter shouldn't require touching call sites |
| Transcription | Diarization/speaker attribution | Not implemented | Phase 5, depends on ASR provider capabilities |
| Transcription | Persisting transcript segments to `TranscriptSegment` | Not implemented | Currently relayed live only, no DB write — needs a real `meetingId`, which doesn't exist until the recording-session/track creation endpoint (Phase 2 gap, see above) is built |
| AI intelligence | Summaries/decisions/action items/risks | Blocked by external dependency | Needs LLM provider key |
| AI intelligence | Ask VoiceOver (chat + semantic search) | Blocked by external dependency | Needs LLM provider key + pgvector |
| Integrations | Google/Outlook Calendar | Blocked by external dependency | Needs OAuth credentials |
| Integrations | Slack, webhooks | Not implemented | Phase 7 |
| Exports | TXT/PDF/DOCX/JSON/SRT/VTT/CSV | Not implemented | Phase 7 |
| Billing | Stripe products/metering/quotas | Blocked by external dependency | Needs Stripe account |
| Admin | Platform cost/profitability dashboard | Not implemented | Phase 9 |
| Security | Encryption, signed URLs, audit log | Not implemented | Begins Phase 1, expands through later phases |
| Testing | Unit/integration/API/WS/Playwright/extension/billing/security suite | Not implemented | Built alongside each phase, not after |

## Known, stated limitations (not to be silently glossed over)

- Chrome `tabCapture` cannot capture native Teams or Zoom **desktop app** audio — only
  the web/browser versions of those platforms. A separate desktop capture app would be
  a distinct, later effort.
- No feature in this matrix is marked "Implemented and tested" without an actual test
  run recorded in that phase's PR/commit description.
- Pricing in the master spec is explicitly a business hypothesis, not a validated margin
  — the admin cost dashboard (Phase 9) exists specifically to validate or correct it.
- No real migration has been committed yet — `pnpm db:push` (schema sync, no migration
  history) is used in CI in its place. Generate a real one with `pnpm db:migrate` once
  Docker is available locally, then switch CI back to `pnpm db:migrate deploy`.
- Dependabot flagged 22 advisories after the first push; 21 are resolved (`zod` bumped
  3→4, `vitest`/`vite`/`esbuild` bumped to current majors, `postcss`/`deepmerge-ts`
  overridden via `pnpm-workspace.yaml`, each change re-verified against the full
  typecheck/lint/build/test suite). One (`minimatch`, moderate, pulled in transitively
  by eslint's own internals) is deliberately **not** overridden — minimatch@11 dropped
  its CommonJS default export, which breaks eslint's own `require()` of it and takes
  `eslint .` / `next build`'s lint step down with it. It's a lint-only, dev-time
  dependency never shipped to production or exposed to untrusted input. Revisit once
  eslint's dependency tree itself moves off the old minimatch major.
- Turborepo defaults to strict env-var filtering between tasks (`envMode: "strict"`);
  this repo sets `envMode: "loose"` in `turbo.json` so a task actually sees whatever
  env vars the invoking shell has (CI's `DATABASE_URL`/`SESSION_SECRET` were silently
  stripped before this was set, which took three failed CI runs to track down — see
  git history around the "turbo's strict env mode" commit for the full story).
- Next.js's webpack build doesn't resolve the NodeNext-style `.js`-suffixed relative
  imports our packages use (e.g. `export { x } from "./pcm.js"` pointing at `pcm.ts`) for
  any *value*-level import from a workspace package — only type-only imports, which get
  erased before bundling, worked by accident until `apps/web` needed a real runtime
  import from `@voiceover/audio`. Fixed with a `resolve.extensionAlias` entry in
  `apps/web/next.config.ts`; worth remembering if a new workspace package import into
  `apps/web` ever produces a "Module not found: Can't resolve './something.js'" error.
