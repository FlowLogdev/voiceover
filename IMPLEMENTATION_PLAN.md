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
  to run before this is called verified. (The client-generated `recordingTrackId` /
  missing ownership check gap noted here originally was closed after Phase 4, see
  "Recording ownership + consent" below.)
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

## Recording ownership + consent (between Phases 4 and 5)
Closed two gaps in already-shipped code before connecting any real provider:
- **Upload ownership.** Browser recordings now start with
  `POST /organizations/:org/meetings/:meeting/recording-sessions`, which issues the
  session + track ids server-side (the extension used to mint its own UUID, and the
  upload socket accepted audio for any track id from any logged-in user). The socket
  now checks, per connection: server-issued BROWSER track (bot tracks are
  server-written only), live meeting, caller still MEMBER+ in that org, caller is the
  user who started the session, session still RECORDING/PAUSED, consent in effect;
  and every frame's `sourceTrack` must match the track. Cross-org and unknown ids get
  the same 4004, so ids can't be probed. A DB failure fails closed (1011). Stop ends
  the session and closes live sockets immediately.
- **Consent.** Nothing read or wrote `RecordingConsent` before. Now every recording
  (browser or bot) requires an explicit attestation against a versioned notice
  (`RECORDING_CONSENT_NOTICE` in `@voiceover/types`; outdated versions rejected), shown
  as a required checkbox in the web app and extension popup, stored with the session
  and audited. Any org member, guests included, can withdraw consent for a meeting,
  which stops everything recording on it at once (browser sockets closed, bots
  removed, bot audio dropped server-side even if the provider fails to remove the bot).
  Bots are handed a `recordingNotice` to post on joining. The extension also now
  stops capturing when the server closes its upload (it used to keep buffering).
- **Not done:** per-participant consent, jurisdiction-aware rules, deleting captured
  audio on revocation; the notice wording needs legal review. In-process live-socket
  cut-off needs Redis pub/sub for multiple API replicas (same as `TranscriptBus`).

## Phase 5 — Unified persistence, playback, diarization — done, diarization plumbing only (no real diarizing ASR yet)
- **Transcript persistence**: `TrackIngestion` (the one ingestion path for browser capture
  and bots) persists every final segment through a `TranscriptStore`, upserted by
  (track, provider segment id) so revisions don't duplicate; serialised per track; a
  persistence failure is logged and never interrupts the live feed.
- **Speakers**: provider diarization labels (new optional `AsrEvent.speakerLabel`) become
  per-meeting "Speaker 1, 2, ..."; without labels, one speaker per capture source
  ("Microphone" is named after the recording user). Rename via
  `PATCH .../meetings/:id/speakers/:speakerId`. The test-double ASR emits no labels, so
  in practice attribution is by source until a real provider is chosen, and the UI says so.
- **Storage**: new `@voiceover/storage` (`ObjectStore`, `LocalDiskObjectStore`): relative,
  validated keys (no path traversal), atomic writes, streamed writes and ranged reads.
  Chunk rows now record their sample rate. Default root is repo-root `.data/audio` for
  both API and worker (it used to be relative to the API's working directory, which the
  worker couldn't resolve).
- **Finalization worker** (`apps/worker`, was empty): claims FINALIZING sessions with a
  lease in Postgres (compare-and-set; any number of workers; crashed claims expire), waits
  a settle period after the session ends, then per track streams a WAV from the chunks
  (silence for missing chunks so transcript timestamps stay aligned; checksums verified;
  never the whole recording in memory), records duration/chunk/gap counts, rebuilds the
  meeting's language timeline, and marks the session COMPLETE. Transient failures retry
  with exponential backoff, then FAILED; corrupt or unusable data fails at once.
  *Deviation from ARCHITECTURE.md*: Postgres leases instead of BullMQ (no Redis in dev or
  CI, and the job is a property of a row that already exists). Revisit for higher volume.
- **API**: meeting detail (speakers + tracks with playback status), persisted transcript +
  language runs, and playback streaming with HTTP Range support, all scoped by organization.
- **Web**: the meeting page shows players per finalized track, the transcript with speaker
  names (click a line to seek, the line under the playhead is highlighted), inline
  speaker rename, the language timeline, and finalization progress.
- Tests: 21 new unit tests (storage 5, assembly 6, language runs 2, persistence 2,
  Range 2, retry policy 2, plus updates); integration (CI only): 6 worker, 3 API.
- Bug found by the new integration tests and fixed: chunks on one track were ingested
  concurrently, so against real Postgres a slower save let chunk N+1 reach ASR before
  chunk N (segment timing shifted by a chunk). Ingest is now serialised per track, with a
  regression test using a store that saves later chunks faster. All of the above passed in
  CI against real Postgres (run 42928231745).
- **Not done**: real diarization (needs an ASR provider that returns speaker labels);
  waveform view; speaker -> participant linking; transcript editing (`TranscriptRevision`);
  S3 storage and signed playback URLs (Phase 10); resampling mixed-rate tracks.

## Phase 6 — AI meeting intelligence — done against a test double; the Claude adapter is built but has never been called (no key)
- `packages/ai`: provider-agnostic `LlmProvider` (`analyzeMeeting`, `answerQuestion`), a
  Claude adapter on the official SDK (`@anthropic-ai/sdk`, pinned 1.3.0), and a
  deterministic test double (default; clearly labelled placeholder output, no network).
  The adapter streams, uses structured outputs (`output_config.format` JSON schema, then
  re-validated with zod), sends effort explicitly (`high` by default; `LLM_EFFORT`),
  keeps the system prompt byte-stable and cacheable, and opts into server-side refusal
  fallbacks (`fallbacks: "default"`); the model that actually answered is recorded.
  Default model `claude-opus-5-5` (`LLM_MODEL` to override). Refusals, truncation and
  malformed output become typed errors with a retry decision; an over-long transcript
  fails instead of being truncated. The transcript is framed as data, not instructions.
- **Grounding**: the model sees each line as `[S12 0:03:14 Maria] ...` and must cite refs;
  refs are mapped back to segment ids, and any item whose refs don't resolve is dropped
  and counted. Every stored insight carries `evidenceSegmentIds`.
- **Worker**: `AnalysisRunner` runs `MeetingAnalysisRun` jobs (Postgres lease, backoff,
  fenced completion so a worker that lost its lease can't overwrite). A run is queued
  automatically when a recording finalizes, or on demand; an advisory lock keeps it to
  one queued run per meeting. Regeneration replaces AI items nobody touched and keeps
  edited / user-created items (skipping regenerated duplicates) and an edited summary.
- **API**: insights with evidence (segment, time, track), queue analysis (202/409/400),
  edit/check off/delete items and edit the summary (MEMBER+). **Ask VoiceOver**:
  answers from the org's own transcripts with citations; Postgres full-text retrieval;
  no model call when nothing matches; per-user rate limit.
- **Web**: insights panel on the meeting page (evidence chips seek the player, inline
  edit, check-off, regenerate, run status); `/ask` page; removed the dashboard's stale
  "live recorder (test)" link, which used a client-made track id the server now refuses.
- Tests: 12 `packages/ai` + 4 API unit tests; integration (CI only): 5 worker, 3 API.
- **Not done / blocked**: a real Claude call (needs an API key); embeddings / semantic
  search (needs an embeddings provider); an org-level AI on/off switch and subprocessor
  paperwork; creating insights by hand (only edit/delete); a GIN index for full-text
  search (fine at current volume; add a migration once migrations exist); deleted AI
  items can reappear on regeneration.

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
