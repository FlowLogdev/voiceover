import type {
  CaptureStatus,
  OffscreenCommand,
  OffscreenEvent,
  PopupRequest,
  TranscriptLine,
} from "../shared/messages.js";
import type { RecordingSessionDTO, SessionResponse } from "@voiceover/types";
import { API_BASE_URL, WS_BASE_URL } from "../shared/messages.js";

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const MAX_TRANSCRIPT_LINES = 200;

type BaseStatus = Omit<CaptureStatus, "transcriptLines">;

let currentBaseStatus: BaseStatus = { state: "idle", startedAt: null };
let transcriptLines: TranscriptLine[] = [];
/** The server-issued recording session this capture uploads to (so Stop can end it server-side). */
interface ActiveRecording {
  organizationId: string;
  recordingSessionId: string;
  recordingTrackId: string;
}
let activeRecording: ActiveRecording | null = null;

/**
 * Calls the VoiceOver API with the user's web-app session cookie (the
 * extension's host permission for the API origin lets it send that cookie).
 */
async function apiRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) throw new Error("Log in to VoiceOver in this browser first");
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `VoiceOver API error ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Creates a meeting for this tab and a server-issued browser recording
 * session for it, carrying the user's consent attestation. The server records
 * the consent and is the only source of track ids; its upload socket accepts
 * audio only from the user who started the session.
 */
async function createServerRecording(
  tabTitle: string | undefined,
  consent: { attested: true; noticeVersion: string },
): Promise<ActiveRecording> {
  const session = await apiRequest<SessionResponse>("/auth/session");
  const organizationId = session.activeOrganizationId;
  if (!organizationId) throw new Error("Your VoiceOver account has no active organization");
  const meeting = await apiRequest<{ id: string }>(`/organizations/${organizationId}/meetings`, {
    title: (tabTitle || "Browser recording").slice(0, 200),
    recordingMethod: "BROWSER",
  });
  const recording = await apiRequest<RecordingSessionDTO>(
    `/organizations/${organizationId}/meetings/${meeting.id}/recording-sessions`,
    { consent, sourceTracks: ["remote_tab"] },
  );
  const track = recording.tracks.find((t) => t.sourceTrack === "remote_tab");
  if (!track) throw new Error("Server did not issue a tab-audio track");
  return { organizationId, recordingSessionId: recording.id, recordingTrackId: track.id };
}

async function stopServerRecording(recording: ActiveRecording | null): Promise<void> {
  if (!recording) return;
  try {
    await apiRequest(
      `/organizations/${recording.organizationId}/recording-sessions/${recording.recordingSessionId}/stop`,
      {},
    );
  } catch {
    // Capture and the upload socket are already closed. The server-side
    // session stays RECORDING until stopped from the web app, but nothing
    // more can be uploaded to it without this user's session cookie.
  }
}

function setActiveRecording(recording: ActiveRecording | null) {
  activeRecording = recording;
  void chrome.storage.session.set({ activeRecording: recording });
}

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

async function startCapture(consent: { attested: true; noticeVersion: string }): Promise<void> {
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

  const recording = await createServerRecording(tab.title, consent);
  setActiveRecording(recording);

  await ensureOffscreenDocument();

  const command: OffscreenCommand = {
    type: "init-capture",
    streamId,
    recordingTrackId: recording.recordingTrackId,
    wsUrl: `${WS_BASE_URL}/recording-tracks/${recording.recordingTrackId}/audio`,
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
      // The server ended it (stopped elsewhere / consent revoked): nothing left to stop.
      if (message.status.state === "error") setActiveRecording(null);
      return;
    }
    if (message.type === "transcript-line") {
      upsertTranscriptLine(message.line);
      return;
    }

    switch (message.type) {
      case "start":
        try {
          await startCapture(message.consent);
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
        await stopServerRecording(activeRecording);
        setActiveRecording(null);
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
void chrome.storage.session.get(["captureStatus", "activeRecording"]).then((stored) => {
  activeRecording = (stored.activeRecording as ActiveRecording | null | undefined) ?? null;
  if (stored.captureStatus) {
    const restored = stored.captureStatus as CaptureStatus;
    currentBaseStatus = { state: restored.state, startedAt: restored.startedAt, error: restored.error };
    transcriptLines = restored.transcriptLines ?? [];
    updateBadge(currentBaseStatus);
  }
});
