# VoiceOver AI — Architecture

## 1. Scope and honesty note

This is a large, multi-quarter commercial build (real-time multilingual ASR, a Chrome
extension with tab-capture audio pipelines, third-party meeting-bot integration, billing,
multi-tenant data isolation). No single development session produces a finished,
production-hardened version of all of this. This document describes the target
architecture; `FEATURE_MATRIX.md` tracks, truthfully, what is actually implemented and
tested versus scaffolded versus blocked on external credentials.

## 2. Monorepo layout

```
apps/web               Next.js App Router — marketing site + authenticated dashboard
apps/api               Fastify API — REST + authenticated WebSocket, long-running process
apps/worker            BullMQ worker — ASR orchestration, diarization, AI analysis, exports
apps/chrome-extension  Manifest V3 extension — tabCapture, offscreen doc, live transcript UI
packages/database      Prisma schema, migrations, seed data, tenant-scoped query helpers
packages/types         Shared TypeScript types/DTOs/zod schemas used by web/api/worker/extension
packages/auth          Session/JWT helpers, RBAC policy checks, tenant context
packages/ai            LLM provider adapter (OpenAI/Anthropic), prompt templates, structured output
packages/transcription ASR provider adapter interface + implementations, diarization glue
packages/audio         Audio chunking, VAD, resampling, format conversion shared by extension/worker
packages/ui            Shared design-system components (shadcn/ui based)
packages/config        Shared eslint/tsconfig/tailwind config
packages/testing        Shared test fixtures/mocks (fake audio, fake transcripts, fake tenants)
infra/docker           docker-compose for Postgres, Redis, MinIO (S3-compatible), local dev
infra/deployment       Container build/deploy configs for api/worker (not serverless)
docs/*                 Architecture, API, security, testing, deployment reference docs
```

Why container-hosted API/worker instead of pure serverless: the capture pipeline holds
long-lived WebSocket connections and streams audio continuously for the duration of a
meeting (up to hours). That workload does not fit cleanly into short-lived serverless
function invocations, so `apps/api` and `apps/worker` run as long-lived Node processes
(Docker locally; any container host in production). `apps/web` is a normal Next.js app
and can be deployed to Vercel; it talks to `apps/api` over HTTPS/WSS, it does not itself
hold audio connections.

## 3. Core request/data flow

```
Chrome extension (tabCapture)        Meeting bot provider (Recall.ai-class adapter)
        |                                         |
        v                                         v
   AudioWorklet -> PCM chunks              Bot audio webhook/stream
        |                                         |
        +-------------------+--------------------+
                             v
                  WebSocket ingestion (apps/api)
                             |
                             v
                 Chunk store (object storage) + queue (BullMQ/Redis)
                             |
                             v
                  apps/worker: VAD -> streaming ASR -> language
                  detection -> diarization -> transcript segments
                             |
                             v
                     Postgres (packages/database)
                             |
                  +----------+-----------+
                  v                      v
         Live transcript via WS   AI analysis job (summary, decisions,
         back to web/extension    action items, embeddings via pgvector)
```

Both capture modes (`BrowserCaptureProvider`, `MeetingBotCaptureProvider`) implement the
same `CaptureProvider` contract (`initialize/start/pause/resume/stop/getStatus/
subscribeToAudio/subscribeToTranscript/cleanup`) so everything downstream of ingestion —
storage, transcript, AI analysis, playback, billing — is capture-method-agnostic.

## 4. Tenancy and security model

- Every tenant-scoped table carries `organization_id`; all Prisma queries go through a
  tenant-scoped client wrapper in `packages/database` that injects the tenant filter —
  application code cannot accidentally query cross-tenant.
- RBAC roles: `owner`, `admin`, `member`, `guest` at the organization level; meeting-level
  share grants are additive on top of role.
- Postgres row-level security is enabled as defense-in-depth in addition to the
  application-level tenant filter (belt-and-suspenders, not either/or).
- Audio and transcript objects are stored in S3-compatible storage with
  per-object encryption and short-lived signed URLs for playback/export; nothing is
  served as a long-lived public URL.
- Audit log entries are written for recording start/stop, bot invite, export, share,
  deletion, and billing plan changes.

## 5. External dependencies requiring credentials (not yet provisioned)

| Dependency | Purpose | Status |
| --- | --- | --- |
| Streaming ASR provider (e.g. Deepgram/AssemblyAI/Google STT) | real-time multilingual transcription | Not selected — needs benchmark against EN/ES/PT + diarization + cost |
| Meeting bot provider (Recall.ai or equivalent) | bot joins Zoom/Teams/Meet | Not provisioned — needs account + current API validation |
| LLM provider (OpenAI and/or Anthropic) | summaries, action items, chat | Not provisioned |
| Stripe | billing/subscriptions/metering | Not provisioned |
| Google/Microsoft OAuth | login + calendar integration | Not provisioned |
| S3-compatible object storage | audio/export storage | MinIO used locally; production bucket not provisioned |
| Managed Postgres/Redis | production data stores | Local Docker only so far |

Each adapter is built against a typed interface so these can be plugged in without
touching calling code, and each is documented with the exact environment variables and
setup steps needed in `.env.example` and `docs/deployment`.

## 6. What "done" means per phase

See `IMPLEMENTATION_PLAN.md` for phases and `FEATURE_MATRIX.md` for per-feature status
using the four honest states: **Implemented and tested**, **Implemented awaiting
external validation**, **Blocked by external dependency**, **Not implemented**.
