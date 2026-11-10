# VoiceOver AI — Implementation Plan

Phases follow the master spec's execution plan. Each phase ends with something runnable
and testable, not just files on disk. Status is tracked honestly in `FEATURE_MATRIX.md`.

## Phase 0 — Foundation (this session)
- pnpm + Turborepo monorepo, directory layout, shared tsconfig/eslint/tailwind config.
- `packages/database`: full Prisma schema from spec section 7, initial migration, seed script.
- `docker-compose.yml`: Postgres, Redis, MinIO for local dev.
- `.env.example` documenting every required variable, with no real secrets.
- `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `FEATURE_MATRIX.md` (this document set).
- CI skeleton (lint + typecheck + unit tests) in `.github/workflows`.

## Phase 1 — Auth, tenancy, dashboard shell
- `apps/api`: Fastify app, health check, session auth (email/password to start; OAuth
  stubs behind feature flags pending Google/Microsoft client credentials).
- `packages/auth`: session issuance, RBAC middleware, tenant context propagation.
- `apps/web`: Next.js app with sign up/login, organization creation, empty dashboard,
  meetings list (empty state), settings shell.
- Tests: API auth integration tests, tenant-isolation test (user A cannot read org B's data).

## Phase 2 — Browser capture vertical slice (the spec's "first task") — done, pending a human's manual browser test
- `packages/audio`: PCM16 conversion, FNV-1a chunk checksums, WAV header builder, an
  IndexedDB-backed `ChunkBuffer`, and a transport-agnostic `ResumableUploader` with
  disconnect/retry/backoff. **14 unit tests, all passing**, no browser required
  (IndexedDB polyfilled via `fake-indexeddb` for the test run).
- `apps/api`: `/recording-tracks/:id/audio` WebSocket — JSON chunk protocol, checksum
  verification, idempotent-by-sequence-number storage via a pluggable `ChunkStore`
  (in-memory for tests, a local-disk-backed Prisma store as a stand-in for S3 in
  production — see the comment in `prisma-file-chunk-store.ts`). **3 integration tests**
  against a real listening server with a real `ws` client, all passing.
- `apps/chrome-extension`: MV3 background service worker (tabCapture + offscreen
  document lifecycle + badge indicator), offscreen document (AudioWorklet PCM capture,
  Web Audio passthrough so the user still hears the tab, WebSocket upload), and a
  popup (start/pause/resume/stop + elapsed time). Builds clean with `esbuild`,
  typechecks clean, produces a loadable unpacked-extension `dist/`.
- Two real bugs found and fixed while building this: a zod `ZodError` `instanceof`
  check that silently failed across the package boundary, and a Fastify error-handler
  registration-order bug that caused encapsulated route plugins to ignore the global
  error handler entirely (both now covered by tests that would catch a regression).
- **Not done**: a live run in an actual Chrome browser (this environment has no GUI
  browser, and `tabCapture` requires a real user gesture) — see
  `docs/testing/chrome-extension-manual-test-plan.md` for the checklist a human needs
  to run before this is called verified. Also not done: a server-side recording-session/
  track creation endpoint, so `recordingTrackId` is currently client-generated and the
  ingestion WebSocket does not yet check tenant/track ownership — tracked in
  `FEATURE_MATRIX.md`, needed before this touches anything beyond local dev.
- Explicitly out of scope here, not silently ignored: native Teams/Zoom **desktop app**
  audio (`tabCapture` only sees browser tabs) and real S3-compatible object storage.

## Phase 3 — Streaming transcription — done, against a test double, not real ASR
- `packages/transcription`: energy-based `VadSegmenter` (real segmentation logic, not a
  stub) plus an `AsrProvider`/`AsrSession` interface and a `TestDoubleAsrProvider` that
  runs real VAD over real audio but emits clearly-labeled placeholder text instead of
  actual speech-to-text — no provider is selected/credentialed yet (ARCHITECTURE.md
  section 5). **29 unit tests**, all passing, no network/browser required.
- `apps/api`'s `/recording-tracks/:id/audio` WebSocket now runs each connection's audio
  through one `AsrSession` and relays `transcript.partial` / `transcript.final` /
  `language.detected` events live over the same socket (protocol extended in
  `packages/types/recording-ws.ts`). **2 new integration tests** confirm loud audio
  produces transcript events and silent audio produces none.
- `apps/chrome-extension`: the offscreen document relays these events to the
  background service worker, which keeps a capped rolling transcript buffer; the popup
  renders it live (partial lines in italics, final lines solid). Build/typecheck clean.
- `apps/web`: a `/recorder/[trackId]` page (linked from the dashboard) connects to the
  same WebSocket and lets a human send synthetic speech/silence chunks and watch the
  live transcript — a manual verification tool, not a real recording UI. Needed a
  webpack `resolve.extensionAlias` fix in `next.config.ts` (NodeNext-style `.js` import
  specifiers pointing at `.ts` files aren't resolved by webpack by default — this was
  the first *value-level* cross-package import into the web bundle, so it hadn't
  surfaced before).
- **Manually verified against the actually-running dev servers** (not just the
  in-process vitest harness): booted real `apps/api`/`apps/web` processes, generated a
  valid session token, and drove the WebSocket protocol exactly as the browser page
  does — confirmed ack, language.detected, and incrementing transcript.partial events
  all arrive correctly in order. The Chrome browser automation extension was not
  connected in this environment, so the page itself could not be driven interactively
  by a real browser; the page does server-render correctly (checked directly) and the
  identical protocol was exercised over a real socket, but nobody has clicked the
  actual buttons in an actual browser tab yet.
- No persistence yet: transcript segments are relayed live only, not written to
  `TranscriptSegment` — that needs a real `meetingId`, which doesn't exist until the
  recording-session/track creation endpoint (the Phase 2 gap) is built.

## Phase 4 — Meeting bot adapter — done, against a test double, not a real bot provider
- `packages/meeting-bot` (new): the provider-agnostic `MeetingBotProvider` contract,
  plus everything that should behave identically whichever provider is plugged in:
  - `parseMeetingUrl` — an allowlist (https only, no credentials/ports, exact
    Zoom/Meet/Teams hosts and meeting-path shapes; lookalike hosts rejected), since a
    bot provider will send a real headless browser to whatever URL it's handed.
  - Bot lifecycle state machine (`SCHEDULED -> JOINING -> WAITING_ROOM -> IN_CALL ->
    LEFT`, plus `ADMISSION_REJECTED` / `FAILED`) that refuses regressions, so duplicate
    or out-of-order provider webhooks can't move a bot backwards.
  - `AdmissionRetryPolicy` — exponential-backoff re-dispatch after the host doesn't
    admit the bot, the meeting hasn't started, or the provider API errors; non-retryable
    failures (e.g. meeting locked) fail immediately.
  - `BotSessionManager` — scheduled join (timers chained in <=24.8-day steps: a plain
    `setTimeout` beyond 2^31-1 ms fires *immediately*), retries, leave-on-request
    (idempotent; a provider failure keeps the bot's status and surfaces as 502),
    stale-bot event filtering after a retry, per-session serialisation of all
    mutations, and `restore()` to re-arm timers/audio routing after a restart.
  - `TestDoubleMeetingBotProvider` — simulates the provider-side lifecycle on timers
    and emits clearly-synthetic square-wave audio while "in the call". **35 unit
    tests** on a deterministic fake clock, no network needed.
- One real race found and fixed while testing: a provider can deliver the first audio
  frames in the same tick as (or before) the `in_call` event, which the manager applies
  asynchronously — frame 0 was silently dropped. Pre-live frames are now held in a
  bounded per-session buffer and replayed in order (or discarded if the bot never gets in).
- `apps/api`: browser-capture ingestion extracted into a shared `TrackIngestion`
  (checksum -> chunk store -> ASR -> transcript events) that the bot path uses verbatim,
  plus an in-process `TranscriptBus`. Side fix: a replayed chunk (client retry after a
  lost ack) is no longer fed to ASR twice. New routes: invite
  (`POST /organizations/:org/meetings/:meeting/bot-sessions`, MEMBER+), list, get, and
  leave; a read-only `/recording-tracks/:id/transcript` WebSocket with a
  track -> meeting -> organization ownership check; `BOT_INVITED` / `BOT_LEFT` audit
  entries (including provider-initiated exits). Prisma: bot columns on
  `RecordingSession`, `WAITING_ROOM` added to `BotJoinStatus`. Setting
  `MEETING_BOT_PROVIDER` to anything other than `test-double` fails startup loudly
  instead of silently simulating. **6 new API unit tests** (incl. a no-DB
  bot -> pipeline -> transcript run) and **4 DB-backed integration tests** (CI only).
- `apps/web`: create a meeting from the dashboard; `/meetings/[id]` sends, schedules
  and removes a bot, polls its status, and shows the live transcript.
- Two pre-existing bugs fixed along the way: the web API client sent
  `Content-Type: application/json` on bodyless POSTs, which Fastify rejects with 400 —
  so **Log out never worked from the browser** (confirmed against the real app); and
  `forOrganization()` injected a `where` clause into `create` calls, which take no
  `where` (fixed defensively — not reproducible locally without a DB; meeting creation
  through it is now exercised by the CI integration tests).
- **Not done / blocked**: a real Recall.ai-class adapter (needs an account + API key —
  deliberately not written from memory of their API, since it couldn't be validated);
  the provider webhook endpoint + signature verification that adapter needs; durable
  scheduling (timers are in-process and re-armed by `restore()` on boot — fine for one
  API replica, not several; move to BullMQ delayed jobs in `apps/worker`);
  `TranscriptBus` is likewise single-process; transcript persistence and finalisation
  (Phase 5).

## Phase 5 — Unified persistence, playback, diarization
- `recording_sessions`/`recording_tracks` finalization job in `apps/worker`.
- Synchronized audio player + transcript UI in `apps/web` meeting detail page.
- Diarization/speaker attribution, speaker rename.

## Phase 6 — AI meeting intelligence
- `packages/ai`: LLM adapter, structured-output schemas for summary/decisions/action
  items/risks/questions, each citing transcript segment + timestamp.
- Regeneration, editing, evidence links.
- pgvector embeddings + cross-meeting semantic search ("Ask VoiceOver").

## Phase 7 — Collaboration, calendar, integrations, exports
- Google Calendar / Outlook Calendar OAuth, Slack, webhooks.
- Exports: TXT, PDF, DOCX, JSON, SRT, VTT, action-item CSV.
- Sharing, comments, bookmarks, retention settings.

## Phase 8 — Billing and quotas
- Stripe products/prices for Free/Pro/Business/Enterprise, metered browser/bot minutes.
- Server-side hard quota enforcement, overage billing, webhook handling.
- Usage dashboard for end users.

## Phase 9 — Platform admin and cost monitoring
- MRR, active subscriptions, churn, cost-per-hour, contribution margin dashboard.
- Per-provider cost tracking (ASR, LLM, bot, storage, network).

## Phase 10 — Hardening and verification
- Full test matrix from spec section 11 (unit/integration/API/WS/Playwright/extension/
  billing/security), manual test plans for anything needing live external accounts,
  deployment docs, security review.

## Sequencing note

Phases 3 and 4 (ASR and bot provider) are explicitly blocked on the user selecting and
provisioning paid third-party accounts. Phases 0–2, 5 (partially), 6 (interface + prompts),
7 (export formats, UI), and most of the data/auth/billing scaffolding can proceed without
those credentials, so work continues there while those decisions are pending, per the
master instructions.
