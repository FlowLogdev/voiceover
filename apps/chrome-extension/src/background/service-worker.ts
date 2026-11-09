import type {
  CaptureStatus,
  OffscreenCommand,
  OffscreenEvent,
  PopupRequest,
  TranscriptLine,
} from "../shared/messages.js";
import { WS_BASE_URL } from "../shared/messages.js";

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const MAX_TRANSCRIPT_LINES = 200;

type BaseStatus = Omit<CaptureStatus, "transcriptLines">;

let currentBaseStatus: BaseStatus = { state: "idle", startedAt: null };
let transcriptLines: TranscriptLine[] = [];
/** Generated client-side for this vertical slice — a real recording-session/
 * track creation API (see IMPLEMENTATION_PLAN.md Phase 2 follow-on) should
 * replace this with a server-issued id before any audio is treated as real
 * production data. */
let currentRecordingTrackId: string | null = null;

function fullStatus(): CaptureStatus {
  return { ...currentBaseStatus, transcriptLines };
}

function setBaseStatus(status: BaseStatus) {
  currentBaseStatus = status;
  void chrome.storage.session.set({ captureStatus: fullStatus() });
  updateBadge(status);
}

function upsertTranscriptLine(line: TranscriptLine) {
  const index = transcriptLines.findIndex((existing) => existing.segmentId === line.segmentId);
  if (index >= 0) {
    transcriptLines[index] = line;
  } else {
    transcriptLines.push(line);
  }
  if (transcriptLines.length > MAX_TRANSCRIPT_LINES) {
    transcriptLines = transcriptLines.slice(-MAX_TRANSCRIPT_LINES);
  }
  void chrome.storage.session.set({ captureStatus: fullStatus() });
}

function updateBadge(status: BaseStatus) {
  if (status.state === "recording") {
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    chrome.action.setBadgeText({ text: "REC" });
  } else if (status.state === "paused") {
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    chrome.action.setBadgeText({ text: "II" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture and process tab audio for live meeting transcription.",
  });
}

async function closeOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab to capture");
  }
  return tab;
}

async function startCapture(): Promise<void> {
  transcriptLines = [];
  setBaseStatus({ state: "starting", startedAt: null });

  const tab = await getActiveTab();
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Failed to obtain capture stream"));
        return;
      }
      resolve(id);
    });
  });

  await ensureOffscreenDocument();

  currentRecordingTrackId = crypto.randomUUID();
  const command: OffscreenCommand = {
    type: "init-capture",
    streamId,
    recordingTrackId: currentRecordingTrackId,
    wsUrl: `${WS_BASE_URL}/recording-tracks/${currentRecordingTrackId}/audio`,
  };
  await chrome.runtime.sendMessage(command);
}

async function sendOffscreenCommand(command: OffscreenCommand): Promise<void> {
  await chrome.runtime.sendMessage(command);
}

chrome.runtime.onMessage.addListener((message: PopupRequest | OffscreenEvent, _sender, sendResponse) => {
  void (async () => {
    if (message.type === "offscreen-status") {
      setBaseStatus(message.status);
      return;
    }
    if (message.type === "transcript-line") {
      upsertTranscriptLine(message.line);
      return;
    }

    switch (message.type) {
      case "start":
        try {
          await startCapture();
        } catch (error) {
          setBaseStatus({ state: "error", startedAt: null, error: (error as Error).message });
        }
        sendResponse(fullStatus());
        return;
      case "pause":
        await sendOffscreenCommand({ type: "pause-capture" });
        sendResponse(fullStatus());
        return;
      case "resume":
        await sendOffscreenCommand({ type: "resume-capture" });
        sendResponse(fullStatus());
        return;
      case "stop":
        await sendOffscreenCommand({ type: "stop-capture" });
        await closeOffscreenDocument();
        currentRecordingTrackId = null;
        setBaseStatus({ state: "idle", startedAt: null });
        sendResponse(fullStatus());
        return;
      case "get-status":
        sendResponse(fullStatus());
        return;
    }
  })();
  return true; // keep the message channel open for the async sendResponse above
});

// Restore badge state if the service worker was restarted mid-recording.
void chrome.storage.session.get("captureStatus").then((stored) => {
  if (stored.captureStatus) {
    const restored = stored.captureStatus as CaptureStatus;
    currentBaseStatus = { state: restored.state, startedAt: restored.startedAt, error: restored.error };
    transcriptLines = restored.transcriptLines ?? [];
    updateBadge(currentBaseStatus);
  }
});
