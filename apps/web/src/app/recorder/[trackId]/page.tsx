"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { buildChunkFrame } from "@voiceover/audio";
import type { ServerMessage } from "@voiceover/types";

const WS_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(
  /^http/,
  "ws",
);
const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000;

function loudSamples(): Float32Array {
  const samples = new Float32Array(CHUNK_SAMPLES);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = i % 2 === 0 ? 0.8 : -0.8;
  }
  return samples;
}

function silentSamples(): Float32Array {
  return new Float32Array(CHUNK_SAMPLES);
}

/**
 * Manual verification page for the live-transcription pipeline (Phase 3).
 * Sends synthetic PCM chunks directly over the same WebSocket protocol the
 * Chrome extension uses, so the whole chunk -> VAD -> test-double ASR ->
 * live transcript path can be exercised and watched from an ordinary
 * browser tab, without needing the extension loaded or a real meeting.
 * Requires being logged in (uses the same session cookie as the dashboard).
 */
export default function RecorderPage() {
  const params = useParams<{ trackId: string }>();
  const trackId = params.trackId;
  // Set when opened from a meeting page, so this page can stop the server-side session.
  const search = useSearchParams();
  const organizationId = search.get("org");
  const sessionId = search.get("session");
  const [closeInfo, setCloseInfo] = useState<string | null>(null);

  const [connectionState, setConnectionState] = useState<"connecting" | "open" | "closed" | "error">(
    "connecting",
  );
  const [events, setEvents] = useState<(ServerMessage & { receivedAt: number })[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const sequenceRef = useRef(0);
  const elapsedMsRef = useRef(0);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE_URL}/recording-tracks/${trackId}/audio`);
    wsRef.current = ws;
    ws.addEventListener("open", () => setConnectionState("open"));
    ws.addEventListener("close", (event) => {
      setConnectionState("closed");
      // 4003 not yours / consent revoked, 4004 unknown track, 4009 recording stopped.
      if (event.code !== 1000 && event.code !== 1005) setCloseInfo(`${event.code} ${event.reason}`.trim());
    });
    ws.addEventListener("error", () => setConnectionState("error"));
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data as string) as ServerMessage;
        setEvents((prev) => [...prev, { ...message, receivedAt: Date.now() }].slice(-200));
      } catch {
        // ignore malformed messages
      }
    });
    return () => ws.close();
  }, [trackId]);

  function sendSamples(samples: Float32Array) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const startMs = elapsedMsRef.current;
    const endMs = startMs + CHUNK_MS;
    elapsedMsRef.current = endMs;

    const frame = buildChunkFrame({
      sequenceNumber: sequenceRef.current++,
      startMs,
      endMs,
      sourceTrack: "remote_tab",
      sampleRate: SAMPLE_RATE,
      samples,
    });

    ws.send(
      JSON.stringify({
        type: "chunk",
        sequenceNumber: frame.sequenceNumber,
        startMs: frame.startMs,
        endMs: frame.endMs,
        sourceTrack: frame.sourceTrack,
        sampleRate: frame.sampleRate,
        checksum: frame.checksum,
        bytesBase64: btoa(String.fromCharCode(...frame.bytes)),
      }),
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold">Live recorder — manual test</h1>
      <p className="mt-1 text-sm text-slate-400">
        Track <code>{trackId}</code> — connection:{" "}
        <span
          className={
            connectionState === "open"
              ? "text-emerald-400"
              : connectionState === "error"
                ? "text-red-400"
                : "text-slate-400"
          }
        >
          {connectionState}
        </span>
        {closeInfo && <span className="ml-2 text-red-400">({closeInfo})</span>}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Tracks are issued by the server when a recording starts from a meeting page (with a consent
        confirmation); the server only accepts audio from the user who started it.
      </p>
      <p className="mt-1 text-sm text-amber-400">
        Sends synthetic test audio, not real speech — the transcript text below comes from a
        deterministic test-double ASR provider (see FEATURE_MATRIX.md), not real transcription.
      </p>

      <div className="mt-4 flex gap-3">
        <button
          onClick={() => sendSamples(loudSamples())}
          disabled={connectionState !== "open"}
          className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-40"
        >
          Send speech-like chunk
        </button>
        <button
          onClick={() => sendSamples(silentSamples())}
          disabled={connectionState !== "open"}
          className="rounded-md border border-slate-700 px-4 py-2 text-sm hover:bg-slate-900 disabled:opacity-40"
        >
          Send silent chunk
        </button>
        {organizationId && sessionId && (
          <button
            onClick={() => void api.stopRecording(organizationId, sessionId).catch(() => {})}
            disabled={connectionState !== "open"}
            className="rounded-md border border-red-800 px-4 py-2 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-40"
          >
            Stop recording
          </button>
        )}
      </div>

      <ul className="mt-6 divide-y divide-slate-800 text-sm">
        {events.map((event, i) => (
          <li key={i} className="flex gap-3 py-2">
            <span className="w-36 shrink-0 font-mono text-xs text-slate-500">{event.type}</span>
            <span className="text-slate-200">{JSON.stringify(event)}</span>
          </li>
        ))}
        {events.length === 0 && <li className="py-2 text-slate-500">No events yet.</li>}
      </ul>
    </main>
  );
}
