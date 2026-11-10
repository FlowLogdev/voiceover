"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { BotSessionDTO, BotStatusDTO, SessionResponse } from "@voiceover/types";
import { api, ApiError } from "@/lib/api-client";

const WS_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/^http/, "ws");
const ACTIVE: BotStatusDTO[] = ["SCHEDULED", "JOINING", "WAITING_ROOM", "IN_CALL"];

const STATUS_LABEL: Record<BotStatusDTO, string> = {
  SCHEDULED: "Scheduled",
  JOINING: "Joining",
  WAITING_ROOM: "In waiting room",
  IN_CALL: "In call",
  ADMISSION_REJECTED: "Not admitted",
  LEFT: "Left",
  FAILED: "Failed",
};

interface TranscriptLine {
  segmentId: string;
  text: string;
  startMs: number;
  final: boolean;
}

/** Live transcript for one recording track, via the read-only transcript WebSocket. */
function LiveTranscript({ recordingTrackId }: { recordingTrackId: string }) {
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [lines, setLines] = useState<TranscriptLine[]>([]);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE_URL}/recording-tracks/${recordingTrackId}/transcript`);
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "subscribed") setState("open");
        if (msg.type === "transcript.partial" || msg.type === "transcript.final") {
          setLines((prev) => {
            const line = { segmentId: msg.segmentId, text: msg.text, startMs: msg.startMs, final: msg.type === "transcript.final" };
            const rest = prev.filter((l) => l.segmentId !== msg.segmentId);
            return [...rest, line].sort((a, b) => a.startMs - b.startMs).slice(-100);
          });
        }
      } catch {
        // ignore malformed messages
      }
    });
    ws.addEventListener("close", () => setState("closed"));
    return () => ws.close();
  }, [recordingTrackId]);

  return (
    <div className="mt-4 rounded-md border border-slate-800 p-4">
      <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Live transcript · {state}</p>
      {lines.length === 0 ? (
        <p className="text-sm text-slate-500">Waiting for speech…</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {lines.map((l) => (
            <li key={l.segmentId} className={l.final ? "text-slate-200" : "italic text-slate-400"}>
              <span className="mr-2 font-mono text-xs text-slate-500">{(l.startMs / 1000).toFixed(1)}s</span>
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MeetingPage() {
  const router = useRouter();
  const { meetingId } = useParams<{ meetingId: string }>();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [botSessions, setBotSessions] = useState<BotSessionDTO[]>([]);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [joinAt, setJoinAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const orgId = session?.activeOrganizationId ?? null;

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setBotSessions(await api.listBotSessions(orgId, meetingId));
  }, [orgId, meetingId]);

  useEffect(() => {
    api.session().then(setSession, (err) => {
      if (err instanceof ApiError && err.statusCode === 401) router.replace("/login");
      else setError(err instanceof Error ? err.message : "Failed to load session");
    });
  }, [router]);

  const active = botSessions.find((s) => ACTIVE.includes(s.status)) ?? null;

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : "Failed to load bot sessions"));
  }, [refresh]);

  // Status changes come from the provider asynchronously; poll while a bot is active.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void refresh().catch(() => {}), 2000);
    return () => clearInterval(id);
  }, [active, refresh]);

  async function onInvite(event: React.FormEvent) {
    event.preventDefault();
    if (!orgId) return;
    setBusy(true);
    setError(null);
    try {
      await api.inviteBot(orgId, meetingId, {
        meetingUrl,
        joinAt: joinAt ? new Date(joinAt).toISOString() : undefined,
      });
      setMeetingUrl("");
      setJoinAt("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite bot");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(sessionId: string) {
    if (!orgId) return;
    setBusy(true);
    try {
      await api.removeBot(orgId, sessionId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove bot");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <a href="/dashboard" className="text-sm text-slate-400 hover:text-slate-200">
        ← Dashboard
      </a>
      <h1 className="mb-1 mt-4 text-2xl font-semibold">Meeting bot</h1>
      <p className="mb-6 text-sm text-amber-300/80">
        Test-double bot provider: no real meeting is joined. The bot&apos;s lifecycle is simulated and its
        audio is synthetic, so the transcript text is placeholder output.
      </p>

      {error && <p className="mb-4 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}

      {active ? (
        <section className="rounded-md border border-slate-700 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">
                {active.botName} · <span className="text-indigo-300">{STATUS_LABEL[active.status]}</span>
              </p>
              <p className="text-sm text-slate-400">
                {active.platform} · attempt {active.joinAttempts}
                {active.scheduledJoinAt && ` · joins ${new Date(active.scheduledJoinAt).toLocaleString()}`}
              </p>
              {active.failureReason && <p className="text-sm text-amber-300">{active.failureReason}</p>}
            </div>
            <button
              onClick={() => void onRemove(active.id)}
              disabled={busy}
              className="rounded-md border border-red-800 px-4 py-2 text-sm text-red-300 hover:bg-red-950/40 disabled:opacity-50"
            >
              {active.status === "SCHEDULED" ? "Cancel" : "Remove bot"}
            </button>
          </div>
          {active.status === "IN_CALL" && <LiveTranscript recordingTrackId={active.recordingTrackId} />}
        </section>
      ) : (
        <form onSubmit={onInvite} className="space-y-3 rounded-md border border-slate-700 p-4">
          <label className="block text-sm">
            Meeting link (Zoom, Google Meet or Teams)
            <input
              required
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://meet.google.com/abc-defg-hij"
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            Join at (optional — leave empty to join now)
            <input
              type="datetime-local"
              value={joinAt}
              onChange={(e) => setJoinAt(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !orgId}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            Send bot
          </button>
        </form>
      )}

      {botSessions.filter((s) => s.id !== active?.id).length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium text-slate-400">Previous bot sessions</h2>
          <ul className="divide-y divide-slate-800 text-sm">
            {botSessions
              .filter((s) => s.id !== active?.id)
              .map((s) => (
                <li key={s.id} className="py-2">
                  {STATUS_LABEL[s.status]} · {s.platform} · {s.joinAttempts} attempt(s)
                  {s.failureReason && <span className="text-slate-500"> — {s.failureReason}</span>}
                </li>
              ))}
          </ul>
        </section>
      )}
    </main>
  );
}
