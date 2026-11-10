import { RECORDING_CONSENT_NOTICE } from "@voiceover/types";
import type { CaptureStatus, PopupRequest } from "../shared/messages.js";

const statusEl = document.getElementById("status") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const transcriptEl = document.getElementById("transcript") as HTMLDivElement;
const consentEl = document.getElementById("consent") as HTMLInputElement;
const consentTextEl = document.getElementById("consent-text") as HTMLSpanElement;
const consentRowEl = document.getElementById("consent-row") as HTMLLabelElement;
consentTextEl.textContent = RECORDING_CONSENT_NOTICE.text;
let lastStatus: CaptureStatus | null = null;

function send(request: PopupRequest): Promise<CaptureStatus> {
  return chrome.runtime.sendMessage(request);
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return "";
  const totalSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return ` (${minutes}:${seconds})`;
}

function render(status: CaptureStatus) {
  lastStatus = status;
  errorEl.textContent = status.error ?? "";
  statusEl.classList.toggle("recording", status.state === "recording");

  switch (status.state) {
    case "idle":
      statusEl.textContent = "Not recording";
      break;
    case "starting":
      statusEl.textContent = "Starting...";
      break;
    case "recording":
      statusEl.textContent = `Recording${formatElapsed(status.startedAt)}`;
      break;
    case "paused":
      statusEl.textContent = "Paused";
      break;
    case "stopping":
      statusEl.textContent = "Stopping...";
      break;
    case "error":
      statusEl.textContent = "Error";
      break;
  }

  const canStart = status.state === "idle" || status.state === "error";
  consentRowEl.hidden = !canStart;
  // Recording cannot start until the user confirms the consent notice.
  startBtn.disabled = !canStart || !consentEl.checked;
  pauseBtn.disabled = status.state !== "recording" && status.state !== "paused";
  pauseBtn.textContent = status.state === "paused" ? "Resume" : "Pause";
  stopBtn.disabled = status.state === "idle";

  renderTranscript(status.transcriptLines);
}

function renderTranscript(lines: CaptureStatus["transcriptLines"]) {
  const wasScrolledToBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop <= transcriptEl.clientHeight + 4;

  transcriptEl.replaceChildren(
    ...lines.map((line) => {
      const el = document.createElement("div");
      el.className = `transcript-line${line.isFinal ? "" : " partial"}`;
      const lang = document.createElement("span");
      lang.className = "lang";
      lang.textContent = line.languageCode;
      el.appendChild(lang);
      el.appendChild(document.createTextNode(line.text));
      return el;
    }),
  );

  if (wasScrolledToBottom) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
}

consentEl.addEventListener("change", () => {
  if (lastStatus) render(lastStatus);
});
startBtn.addEventListener("click", () => {
  if (!consentEl.checked) return;
  const request: PopupRequest = {
    type: "start",
    consent: { attested: true, noticeVersion: RECORDING_CONSENT_NOTICE.version },
  };
  void send(request).then((status) => {
    consentEl.checked = false; // confirm again for every recording
    render(status);
  });
});
pauseBtn.addEventListener("click", () => {
  const request: PopupRequest = pauseBtn.textContent === "Resume" ? { type: "resume" } : { type: "pause" };
  void send(request).then(render);
});
stopBtn.addEventListener("click", () => void send({ type: "stop" }).then(render));

void send({ type: "get-status" }).then(render);
setInterval(() => void send({ type: "get-status" }).then(render), 1000);
