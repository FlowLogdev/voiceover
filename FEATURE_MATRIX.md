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
| Transcription | ASRProvider interface + test-double adapter | Not implemented | Phase 3 |
| Transcription | Real streaming ASR (EN/ES/PT) | Blocked by external dependency | Needs provider selection + API key |
| Transcription | Diarization/speaker attribution | Not implemented | Phase 5, depends on ASR provider capabilities |
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
- Turborepo defaults to strict env-var filtering between tasks (`envMode: "strict"`);
  this repo sets `envMode: "loose"` in `turbo.json` so a task actually sees whatever
  env vars the invoking shell has (CI's `DATABASE_URL`/`SESSION_SECRET` were silently
  stripped before this was set, which took three failed CI runs to track down — see
  git history around the "turbo's strict env mode" commit for the full story).
