import type { CaptureStatus, PopupRequest } from "../shared/messages.js";

const statusEl = document.getElementById("status") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;

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

  startBtn.disabled = status.state !== "idle" && status.state !== "error";
  pauseBtn.disabled = status.state !== "recording" && status.state !== "paused";
  pauseBtn.textContent = status.state === "paused" ? "Resume" : "Pause";
  stopBtn.disabled = status.state === "idle";
}

startBtn.addEventListener("click", () => void send({ type: "start" }).then(render));
pauseBtn.addEventListener("click", () => {
  const request: PopupRequest = pauseBtn.textContent === "Resume" ? { type: "resume" } : { type: "pause" };
  void send(request).then(render);
});
stopBtn.addEventListener("click", () => void send({ type: "stop" }).then(render));

void send({ type: "get-status" }).then(render);
setInterval(() => void send({ type: "get-status" }).then(render), 1000);
