# Manual test plan — Chrome extension browser capture (Phase 2)

Per `FEATURE_MATRIX.md`: this feature is **implemented, not yet manually
verified in a real Chrome browser**. Automated tools in this environment
cannot load an unpacked MV3 extension, grant `tabCapture` permission (which
requires a real user gesture in an actual browser), or join a live tab with
audio — so the steps below are a human checklist, not something that has been
executed. Do not treat this as "passed" until someone has actually run it.

## Setup

1. `pnpm --filter @voiceover/chrome-extension build` (produces `apps/chrome-extension/dist`).
2. `docker compose up -d` (Postgres/Redis/MinIO), then `pnpm db:push` and `pnpm db:seed`.
3. Start the API: `pnpm --filter @voiceover/api dev` (port 4000).
4. Start the web app: `pnpm --filter @voiceover/web dev` (port 3000).
5. In Chrome, go to `chrome://extensions`, enable Developer Mode, click
   "Load unpacked", select `apps/chrome-extension/dist`.
6. In a normal browser tab, sign up / log in at `http://localhost:3000` so the
   browser holds a `voiceover_session` cookie for `localhost` (the extension's
   WebSocket connection relies on the ordinary browser cookie jar — see
   `ARCHITECTURE.md` and the auth note in `recording-ws.ts`).

## Test cases

1. **Happy path**: open a tab playing audio (e.g. a YouTube video, as a stand-in
   for a live meeting), click the extension icon, click Start.
   - Expect: a permission/activation prompt if first use, then the badge shows
     "REC" and turns red, the popup shows "Recording (mm:ss)" counting up, and
     you can still hear the tab's audio (playback must not be muted).
   - Expect: `apps/api` logs show incoming WS connections and `chunk`/`ack`
     exchanges roughly once per second.
2. **Pause/resume**: click Pause mid-recording — badge turns amber, audio
   playback continues, no new chunks sent. Click Resume — chunks resume,
   badge goes back to red.
3. **Stop**: click Stop — badge clears, offscreen document closes
   (`chrome://extensions` → service worker inspector should show no lingering
   offscreen context), WebSocket closes cleanly on the server side.
4. **Popup closed during recording**: start recording, close the popup
   (click elsewhere). Reopen the popup — it should still show "Recording"
   with the correct elapsed time (status persisted via `chrome.storage.session`
   and the badge stays visible the whole time the popup is closed).
5. **No active session**: log out of the web app (clearing the cookie), then
   try to start a recording. Expect the WS connection to be closed by the
   server with code 4001 and the popup to surface an error state.
6. **Tab closed mid-recording**: start recording, close the captured tab.
   Expect `getUserMedia`'s track to end, triggering a clear failure/stopped
   state rather than a silent hang — if it doesn't, this is a real gap to fix,
   not something to paper over.
7. **Known, expected limitation**: this only works against the Chrome *web*
   tab for Meet/Teams/Zoom. Repeating this test against the Teams or Zoom
   **desktop app** is expected to fail — `tabCapture` cannot see non-browser
   process audio. That is a documented limitation, not a bug to chase here.

## What's intentionally out of scope for this pass

- Tenant/track-ownership verification on the ingestion WebSocket (any valid
  session can currently push chunks to any `recordingTrackId` — there's no
  recording-session/track creation endpoint yet to check ownership against).
  Do not point this at a shared/production environment.
- Real object storage (chunks land on local disk under `AUDIO_STORAGE_DIR`,
  not S3 — see the comment in `prisma-file-chunk-store.ts`).
- Resampling/downsampling: chunks are stored at the tab's native sample rate
  (commonly 48kHz), not resampled for ASR yet.
