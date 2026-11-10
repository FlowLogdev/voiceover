import { buildChunkFrame, ChunkBuffer, ResumableUploader } from "@voiceover/audio";
import type { CaptureStatus, OffscreenCommand, OffscreenEvent, TranscriptLine } from "../shared/messages.js";
import { WebSocketTransport } from "./websocket-transport.js";

type BaseStatus = Omit<CaptureStatus, "transcriptLines">;

const WORKLET_URL = chrome.runtime.getURL("worklet.js");

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let transport: WebSocketTransport | null = null;
let uploader: ResumableUploader | null = null;
let chunkBuffer: ChunkBuffer | null = null;
let sequenceNumber = 0;
let elapsedMs = 0;
let paused = false;

function reportStatus(status: BaseStatus) {
  const event: OffscreenEvent = { type: "offscreen-status", status };
  void chrome.runtime.sendMessage(event);
}

function reportTranscriptLine(line: TranscriptLine) {
  const event: OffscreenEvent = { type: "transcript-line", line };
  void chrome.runtime.sendMessage(event);
}

async function initCapture(streamId: string, recordingTrackId: string, wsUrl: string) {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Chrome's tab-capture constraint shape isn't part of the standard
      // MediaTrackConstraints type — cast narrowly at this one call site.
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    } as MediaTrackConstraints,
  });

  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(WORKLET_URL);

  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");

  // Restore tab audio playback — the user must still hear the meeting while
  // it's being captured.
  source.connect(audioContext.destination);
  source.connect(workletNode);

  chunkBuffer = await ChunkBuffer.open(recordingTrackId);
  transport = new WebSocketTransport(wsUrl);
  transport.onTranscriptMessage((message) => {
    if (message.type === "transcript.partial" || message.type === "transcript.final") {
      reportTranscriptLine({
        segmentId: message.segmentId,
        text: message.text,
        languageCode: message.languageCode,
        isFinal: message.type === "transcript.final",
      });
    }
  });
  transport.onTerminalClose((code, reason) => {
    void stopCapture().then(() =>
      reportStatus({
        state: "error",
        startedAt: null,
        error: `Recording stopped by the server (${code}${reason ? `: ${reason}` : ""})`,
      }),
    );
  });
  uploader = new ResumableUploader({ transport, buffer: chunkBuffer });
  sequenceNumber = 0;
  elapsedMs = 0;
  paused = false;

  workletNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
    if (paused) return;
    const { samples, sampleRate } = event.data;
    const startMs = elapsedMs;
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    elapsedMs += durationMs;

    const frame = buildChunkFrame({
      sequenceNumber: sequenceNumber++,
      startMs,
      endMs: elapsedMs,
      sourceTrack: "remote_tab",
      sampleRate,
      samples,
    });
    void uploader?.enqueue(frame);
  };

  reportStatus({ state: "recording", startedAt: Date.now() });
}

function pauseCapture() {
  paused = true;
  reportStatus({ state: "paused", startedAt: null });
}

function resumeCapture() {
  paused = false;
  reportStatus({ state: "recording", startedAt: Date.now() });
}

async function stopCapture() {
  workletNode?.disconnect();
  audioContext?.close();
  mediaStream?.getTracks().forEach((track) => track.stop());
  transport?.close();
  chunkBuffer?.close();

  mediaStream = null;
  audioContext = null;
  workletNode = null;
  transport = null;
  uploader = null;
  chunkBuffer = null;

  reportStatus({ state: "idle", startedAt: null });
}

chrome.runtime.onMessage.addListener((message: OffscreenCommand) => {
  void (async () => {
    switch (message.type) {
      case "init-capture":
        try {
          await initCapture(message.streamId, message.recordingTrackId, message.wsUrl);
        } catch (error) {
          reportStatus({ state: "error", startedAt: null, error: (error as Error).message });
        }
        return;
      case "pause-capture":
        pauseCapture();
        return;
      case "resume-capture":
        resumeCapture();
        return;
      case "stop-capture":
        await stopCapture();
        return;
    }
  })();
});
