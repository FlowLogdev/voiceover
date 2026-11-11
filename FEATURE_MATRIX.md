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
| Browser capture | Server-issued recording sessions/tracks (`POST /organizations/:org/meetings/:meeting/recording-sessions`, stop) and an ownership check on the upload socket: track must be a server-issued BROWSER track, in a session the *same user* started, still active, with consent in effect, in an org they're still MEMBER+ of; frames' `sourceTrack` must match the track; bot tracks can't be written by clients | Implemented and tested (API); extension side awaiting real-Chrome run | Socket protocol: 5 new DB-free unit tests via an injected authorizer (4004 / 4003 / 4009 / fail-closed 1011 / sourceTrack mismatch / live socket closed on stop). The Prisma-backed check itself: `recording-sessions.integration.test.ts` (starter can upload; same-org colleague 4003; other org 4004; unknown id 4004; bot track 4004; guest can't start). Passed in CI against real Postgres (run 42925780623). Extension now obtains its track from the server (typechecks + builds; not yet run in real Chrome) |
| Meeting bot | `MeetingBotProvider` interface, meeting-URL allowlist, lifecycle state machine, admission retry policy, `BotSessionManager` (scheduled join, retry/backoff, leave-on-request, stale/out-of-order event filtering, restart `restore()`), `TestDoubleMeetingBotProvider` (`packages/meeting-bot`) | Implemented and tested | 35 unit tests on a deterministic fake clock: URL validation incl. lookalike hosts, no-regression transitions, backoff math, scheduled join, >24.8-day schedules not firing early, reject->retry->admit, give-up, non-retryable failure, dispatch-error retry, leave mid-call / before join / idempotent / provider failure, superseded-bot events ignored, meeting ended, restart re-arm, pre-live audio buffering |
| Meeting bot | Bot audio through the shared ingestion pipeline (`TrackIngestion`: chunk store -> ASR -> transcript bus) — same code path as browser capture | Implemented and tested | API unit test runs test-double bot -> manager -> real `TrackIngestion` -> test-double ASR with no DB: chunks contiguous from sequence 0, `transcript.final` on `bot_mixed` |
| Meeting bot | Bot session REST API (invite/list/get/leave), transcript-watch WebSocket, Prisma persistence, audit log, tenancy | Implemented and tested | `bot-sessions.integration.test.ts`: full invite -> IN_CALL -> live transcript -> leave flow, scheduling + 409 on a second active bot, URL/joinAt validation, cross-org 403/404/4004 isolation. **Passes in CI against real Postgres** (run for commit 50c238a); not run against a local DB (no Docker here). Bot provider is still the test double |
| Meeting bot | Web UI: create meeting, send/schedule/remove bot, live status + transcript (`/meetings/[id]`) | Implemented awaiting external validation | Builds, typechecks, lints. Not yet clicked through in a real browser (no live DB locally) |
| Meeting bot | Real Recall.ai-class adapter + provider webhook endpoint with signature verification | Blocked by external dependency | Needs provider account + API key. The adapter only has to implement `MeetingBotProvider` and map its webhook vocabulary onto `BotProviderEvent` |
| Meeting bot | Durable scheduling across multiple API replicas | Not implemented | Join timers are in-process and re-armed by `restore()` at boot — correct for a single API process only. Move to BullMQ delayed jobs in `apps/worker`; `TranscriptBus` needs Redis pub/sub for the same reason |
| Transcription | VAD segmenter + `AsrProvider`/`AsrSession` interface + `TestDoubleAsrProvider` (`packages/transcription`) | Implemented and tested | 29 unit tests pass headlessly: RMS energy/speech classification, segment start/continue/end boundaries (including "brief pause doesn't split a segment"), deterministic partial→final event sequencing, per-session language reporting, finalize()-flushes-open-segment |
| Transcription | Live `transcript.partial` / `transcript.final` / `language.detected` events over the recording-audio WebSocket | Implemented and tested | 2 new `apps/api` integration tests (loud audio → events arrive; silent audio → no events) pass against a real listening server; additionally **manually verified against the actually-running dev server** over a real TCP socket using the exact client protocol the web/extension use — ack, language.detected, and incrementing transcript.partial all arrived correctly and in order |
| Transcription | Chrome extension popup renders the live transcript | Implemented awaiting external validation | Build/typecheck clean; relies on the same not-yet-run-in-a-real-browser caveat as the rest of the extension (see Browser capture row above) |
| Transcription | `apps/web` `/recorder/[trackId]` manual-verification page | Implemented awaiting external validation | Builds, typechecks, server-renders correctly (checked directly). The Chrome browser automation extension was not connected in this environment, so nobody has actually clicked its buttons in a live browser tab — the identical WebSocket protocol was verified via a scripted client instead. |
| Transcription | Real streaming ASR (EN/ES/PT) | Blocked by external dependency | Needs provider selection + API key — everything above is built against the interface so swapping in a real adapter shouldn't require touching call sites |
| Transcription | Speaker attribution: provider diarization labels -> per-meeting "Speaker N" (one per track+label), else one speaker per capture source ("Microphone" named after the recording user, "Tab audio", "Meeting audio"); rename via `PATCH .../speakers/:id` (MEMBER+) | Implemented awaiting external validation | Plumbing tested end to end with a diarizing ASR double in `meeting-detail.integration.test.ts` (CI only). **No real diarization yet**: the test-double ASR emits no labels, so today every transcript is attributed by source, and the UI says so. Real diarization needs an ASR provider that returns speaker labels (`AsrEvent.speakerLabel`) |
| Transcription | Persisting final transcript segments (`TranscriptSegment`), idempotent per (track, provider segment id); partials stay live-only; a persistence failure is logged and never interrupts the live feed | Implemented and tested | 2 new DB-free unit tests (finals only, in order, revisions upsert; failure path). Prisma store: `meeting-detail.integration.test.ts`, passed in CI against real Postgres (run 42928231745) |
| Recording | Finalization worker (`apps/worker`): for each ended session, stream-assembles a playable WAV per track from its chunks (gaps filled with silence so transcript timestamps stay aligned, checksums verified), records duration / chunk / gap counts, rebuilds the meeting's language timeline, marks COMPLETE; Postgres-leased claims (multi-worker safe, crash takeover), settle delay, exponential retry, permanent failures fail fast | Implemented and tested | Pure parts unit-tested (assembly: ordering, gap alignment, odd bytes, bounded silence blocks, mixed rates; language runs; retry policy). DB orchestration: `finalizer.integration.test.ts`, 6 tests (happy path + idempotent rerun, empty track, settle, 5 concurrent claimers -> 1, lease takeover, retry -> FAILED, corrupt/mixed -> FAILED at once). Passed in CI against real Postgres |
| Recording | Meeting detail API (`GET .../meetings/:id`, `GET .../transcript`), playback streaming with HTTP Range (`GET .../recording-tracks/:id/playback`), web meeting page with synced player/transcript (click-to-seek, playhead highlight), speaker rename, language timeline | Implemented and tested (API); web page awaiting a real-browser run | Range parsing unit-tested; routes + tenancy in `meeting-detail.integration.test.ts`, passed in CI. Web page builds/typechecks; not yet clicked through in a real browser. Playback is cookie-authenticated per request; signed object-store URLs are Phase 10 |
| AI intelligence | Summaries/decisions/action items/risks | Blocked by external dependency | Needs LLM provider key |
| AI intelligence | Ask VoiceOver (chat + semantic search) | Blocked by external dependency | Needs LLM provider key + pgvector |
| Integrations | Google/Outlook Calendar | Blocked by external dependency | Needs OAuth credentials |
| Integrations | Slack, webhooks | Not implemented | Phase 7 |
| Exports | TXT/PDF/DOCX/JSON/SRT/VTT/CSV | Not implemented | Phase 7 |
| Billing | Stripe products/metering/quotas | Blocked by external dependency | Needs Stripe account |
| Admin | Platform cost/profitability dashboard | Not implemented | Phase 9 |
| Consent | Recording consent: every recording (browser or bot) requires the starting user's attestation against a versioned notice (`RECORDING_CONSENT_NOTICE`; stale versions rejected), stored as a `RecordingConsent` row + `CONSENT_GRANTED` audit | Implemented and tested (API, CI vs real Postgres); web/extension UI not yet clicked through | Integration tests (CI): missing / `attested: false` / outdated-notice requests rejected with nothing created, for both bot invite and browser recording; consent row + audit written on success |
| Consent | Withdraw consent (`POST .../meetings/:meeting/consents/revoke`, any org member incl. guests): revokes all consent on the meeting, cancels browser sessions and closes their live upload sockets, removes/cancels bots, drops bot audio server-side even if the provider fails to remove the bot, `CONSENT_REVOKED` audit | Implemented and tested (API, CI vs real Postgres) | Integration test (CI): a guest revokes with a live browser upload + an in-call bot: socket closed 4003, browser session CANCELED, bot LEFT, no further bot chunks stored, reconnect refused, fresh attestation needed to record again. Live-socket cut-off is in-process (single API replica), the DB check on reconnect is not |
| Consent | Bot discloses that it's recording on joining | Implemented (contract), awaiting real adapter | `JoinMeetingRequest.recordingNotice` (default `BOT_RECORDING_ANNOUNCEMENT`) is passed on every join attempt (unit-tested); the test double just records it. A real adapter must post it in meeting chat / use the platform's recording banner |
| Consent | Per-participant consent (each attendee acknowledges), jurisdiction-aware defaults, deleting already-captured audio on revocation | Not implemented | Today's basis is organizer attestation only. The notice wording is a product control, **not legal advice: needs counsel review before launch** |
| Security | Encryption, signed URLs, audit log | Not implemented | Begins Phase 1, expands through later phases. Audit log now covers recording start/stop, bot invite/leave, consent grant/revoke |
| Testing | Unit/integration/API/WS/Playwright/extension/billing/security suite | Not implemented | Built alongside each phase, not after |

## Known, stated limitations (not to be silently glossed over)

- Audio storage is still local disk (`@voiceover/storage` `LocalDiskObjectStore`, default
  repo-root `.data/audio`), with no encryption at rest. The API and worker must share it
  (same machine/volume). An S3 adapter implements the same `ObjectStore` interface.
- Chunks stored before Phase 5 (absolute file paths, no sample rate) are not finalizable;
  such sessions fail finalization with a clear reason. Dev data only.

- Meeting-bot transcript text is placeholder output from the test-double ASR fed
  *synthetic* audio from the test-double bot provider — no real meeting is joined yet.
  The meeting page says so.
- Fixed in Phase 4: the dashboard's Log out button had never worked from a browser
  (bodyless POST sent with `Content-Type: application/json` -> Fastify 400).

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
