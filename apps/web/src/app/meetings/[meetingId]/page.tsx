"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  RECORDING_CONSENT_NOTICE,
  type BotSessionDTO,
  type BotStatusDTO,
  type RecordingConsentDTO,
  type SessionResponse,
} from "@voiceover/types";
import { api, ApiError } from "@/lib/api-client";
import { MeetingRecording } from "./meeting-recording";
import { MeetingInsights } from "./meeting-insights";

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
  const [consented, setConsented] = useState(false);
  const [consents, setConsents] = useState<RecordingConsentDTO[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  const orgId = session?.activeOrganizationId ?? null;
  const consentInEffect = consents.some((c) => c.revokedAt === null);
  const consent = { attested: true as const, noticeVersion: RECORDING_CONSENT_NOTICE.version };

  const refresh = useCallback(async () => {
    if (!orgId) return;
    const [bots, consentRows] = await Promise.all([
      api.listBotSessions(orgId, meetingId),
      api.listConsents(orgId, meetingId),
    ]);
    setBotSessions(bots);
    setConsents(consentRows);
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

  useEffect(() => {
    if (!orgId) return;
    api.getMeeting(orgId, meetingId).then((m) => setTitle(m.title), () => {});
  }, [orgId, meetingId]);

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
        consent,
      });
      setMeetingUrl("");
      setJoinAt("");
      setConsented(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite bot");
    } finally {
      setBusy(false);
    }
  }

  async function onStartBrowserRecording() {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    try {
      const recording = await api.startRecording(orgId, meetingId, { consent });
      const track = recording.tracks[0]!;
      router.push(`/recorder/${track.id}?org=${orgId}&session=${recording.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start recording");
      setBusy(false);
    }
  }

  async function onRevoke() {
    if (!orgId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.revokeConsent(orgId, meetingId);
      const stopped = result.stoppedBotSessions + result.stoppedBrowserSessions;
      setNotice(
        `Consent withdrawn. Stopped ${stopped} recording${stopped === 1 ? "" : "s"}.` +
          (result.botLeaveFailures.length > 0
            ? ` ${result.botLeaveFailures.length} bot(s) could not be removed by the provider: their audio is no longer stored, but remove them from the call manually.`
            : ""),
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to withdraw consent");
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
      <h1 className="mb-6 mt-4 text-2xl font-semibold">{title ?? "Meeting"}</h1>

      {orgId && (
        <MeetingRecording
          organizationId={orgId}
          meetingId={meetingId}
          refreshKey={botSessions.map((s) => `${s.id}:${s.status}`).join(",")}
        />
      )}
      {orgId && (
        <MeetingInsights
          organizationId={orgId}
          meetingId={meetingId}
          canEdit={session?.organizations.find((o) => o.id === orgId)?.role !== "GUEST"}
          refreshKey={botSessions.map((s) => `${s.id}:${s.status}`).join(",")}
        />
      )}

      <h2 className="mb-1 text-lg font-medium">Meeting bot</h2>
      <p className="mb-6 text-sm text-amber-300/80">
        Test-double bot provider: no real meeting is joined. The bot&apos;s lifecycle is simulated and its
        audio is synthetic, so the transcript text is placeholder output.
      </p>

      {error && <p className="mb-4 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}
      {notice && <p className="mb-4 rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">{notice}</p>}

      {consentInEffect && (
        <section className="mb-6 flex items-center justify-between rounded-md border border-red-900/60 p-4">
          <p className="text-sm text-slate-300">Recording consent is in effect for this meeting.</p>
          <button
            onClick={() => void onRevoke()}
            disabled={busy}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium hover:bg-red-600 disabled:opacity-50"
          >
            Stop all recording &amp; withdraw consent
          </button>
        </section>
      )}

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
          <label className="flex items-start gap-2 rounded-md border border-slate-800 p-3 text-sm text-slate-300">
            <input
              type="checkbox"
              required
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-1"
            />
            <span>{RECORDING_CONSENT_NOTICE.text}</span>
          </label>
          <p className="text-xs text-slate-500">
            The bot announces in the meeting that it is recording, and anyone in your organization can stop it.
          </p>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={busy || !orgId || !consented}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              Send bot
            </button>
            <button
              type="button"
              onClick={() => void onStartBrowserRecording()}
              disabled={busy || !orgId || !consented}
              title="Starts a server-issued browser recording and opens the synthetic-audio test recorder"
              className="rounded-md border border-slate-700 px-4 py-2 text-sm hover:bg-slate-900 disabled:opacity-50"
            >
              Test browser recording
            </button>
          </div>
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
