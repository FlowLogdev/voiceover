"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingDetailDTO, MeetingTranscriptDTO, SpeakerDTO } from "@voiceover/types";
import { api } from "@/lib/api-client";

const IN_PROGRESS = new Set(["PENDING", "RECORDING", "PAUSED", "STOPPING", "FINALIZING"]);
const SOURCE_LABEL: Record<string, string> = {
  remote_tab: "Tab audio",
  local_mic: "Microphone",
  bot_mixed: "Meeting bot",
};

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function speakerName(speaker: SpeakerDTO | undefined): string {
  return speaker ? (speaker.displayName ?? speaker.label) : "Unknown speaker";
}

function SpeakerChip({
  speaker,
  onRename,
}: {
  speaker: SpeakerDTO;
  onRename: (speaker: SpeakerDTO, name: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(speaker.displayName ?? "");

  if (!editing) {
    return (
      <button
        onClick={() => {
          setValue(speaker.displayName ?? "");
          setEditing(true);
        }}
        title={speaker.displayName ? `Default label: ${speaker.label}` : "Rename"}
        className="rounded-full border border-slate-700 px-3 py-1 text-xs hover:bg-slate-900"
      >
        {speakerName(speaker)} ✎
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void onRename(speaker, value.trim() || null).then(() => setEditing(false));
      }}
    >
      <input
        autoFocus
        value={value}
        maxLength={100}
        placeholder={speaker.label}
        onChange={(e) => setValue(e.target.value)}
        className="w-36 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
      />
      <button type="submit" className="rounded-md bg-indigo-600 px-2 py-1 text-xs">
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)} className="px-1 text-xs text-slate-400">
        Cancel
      </button>
    </form>
  );
}

/**
 * Persisted transcript + finalized playback for a meeting. Clicking a line
 * seeks that line's own track; the line under the playhead is highlighted.
 */
export function MeetingRecording({
  organizationId,
  meetingId,
  refreshKey,
}: {
  organizationId: string;
  meetingId: string;
  /** Changes whenever the page knows recordings changed (e.g. a bot's status), forcing a reload. */
  refreshKey?: string;
}) {
  const [detail, setDetail] = useState<MeetingDetailDTO | null>(null);
  const [transcript, setTranscript] = useState<MeetingTranscriptDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const players = useRef(new Map<string, HTMLAudioElement>());
  const activeLine = useRef<HTMLLIElement | null>(null);

  const load = useCallback(async () => {
    const [d, t] = await Promise.all([api.getMeeting(organizationId, meetingId), api.getTranscript(organizationId, meetingId)]);
    setDetail(d);
    setTranscript(t);
  }, [organizationId, meetingId]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load recording"));
  }, [load, refreshKey]);

  // Keep refreshing while something is still recording or being finalized.
  const busy = detail?.tracks.some((t) => IN_PROGRESS.has(t.sessionStatus)) ?? false;
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(id);
  }, [busy, load]);

  useEffect(() => {
    activeLine.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [positions]);

  async function rename(speaker: SpeakerDTO, name: string | null) {
    try {
      const updated = await api.renameSpeaker(organizationId, meetingId, speaker.id, name);
      setDetail((d) => (d ? { ...d, speakers: d.speakers.map((s) => (s.id === updated.id ? updated : s)) } : d));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename speaker");
    }
  }

  function seek(trackId: string | null, ms: number) {
    const player = trackId ? players.current.get(trackId) : undefined;
    if (!player) return;
    player.currentTime = ms / 1000;
    void player.play().catch(() => {});
  }

  if (error) return <p className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>;
  if (!detail || !transcript) return <p className="text-sm text-slate-500">Loading recording…</p>;
  if (detail.tracks.length === 0) return null;

  const speakers = new Map(detail.speakers.map((s) => [s.id, s]));
  const playable = detail.tracks.filter((t) => t.playbackAvailable);
  const sourceAttributed = detail.speakers.some((s) => s.attribution === "source");
  const placeholderText = transcript.segments.some((s) => s.provider === "test-double");

  return (
    <section className="mb-8 space-y-4">
      <h2 className="text-lg font-medium">Recording &amp; transcript</h2>

      <div className="space-y-2">
        {detail.tracks.map((track) =>
          track.playbackAvailable ? (
            <div key={track.id} className="rounded-md border border-slate-800 p-3">
              <p className="mb-1 text-xs text-slate-400">
                {SOURCE_LABEL[track.sourceTrack] ?? track.sourceTrack}
                {track.durationMs !== null && ` · ${formatTime(track.durationMs)}`}
                {track.missingChunkCount ? ` · ${track.missingChunkCount} gap(s) filled with silence` : ""}
              </p>
              <audio
                controls
                preload="metadata"
                src={api.playbackUrl(organizationId, track.id)}
                ref={(el) => {
                  if (el) players.current.set(track.id, el);
                  else players.current.delete(track.id);
                }}
                onTimeUpdate={(e) => {
                  const ms = e.currentTarget.currentTime * 1000;
                  setPositions((p) => ({ ...p, [track.id]: ms }));
                }}
                className="w-full"
              />
            </div>
          ) : (
            <p key={track.id} className="text-sm text-slate-500">
              {SOURCE_LABEL[track.sourceTrack] ?? track.sourceTrack}:{" "}
              {IN_PROGRESS.has(track.sessionStatus)
                ? track.sessionStatus === "FINALIZING"
                  ? "finalizing, playback will appear shortly…"
                  : "recording…"
                : track.sessionStatus === "FAILED"
                  ? `playback unavailable (${track.failureReason ?? "finalization failed"})`
                  : track.durationMs === 0
                    ? "no audio was captured"
                    : "playback unavailable"}
            </p>
          ),
        )}
      </div>

      {detail.speakers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-slate-500">Speakers</span>
          {detail.speakers.map((s) => (
            <SpeakerChip key={s.id} speaker={s} onRename={rename} />
          ))}
        </div>
      )}
      {sourceAttributed && (
        <p className="text-xs text-slate-500">
          Speakers are grouped by audio source (tab, microphone, bot), not by voice: no diarization provider is
          configured yet.
        </p>
      )}
      {transcript.languages.length > 1 && (
        <p className="text-xs text-slate-400">
          Languages:{" "}
          {transcript.languages.map((l) => `${l.languageCode.toUpperCase()} ${formatTime(l.startMs)}–${formatTime(l.endMs)}`).join(" · ")}
        </p>
      )}
      {placeholderText && (
        <p className="text-xs text-amber-300/80">Transcript text is placeholder output from the test-double ASR provider.</p>
      )}

      {transcript.segments.length === 0 ? (
        <p className="text-sm text-slate-500">No transcript yet.</p>
      ) : (
        <ul className="max-h-[28rem] space-y-1 overflow-y-auto rounded-md border border-slate-800 p-3 text-sm">
          {transcript.segments.map((segment) => {
            const position = segment.recordingTrackId ? positions[segment.recordingTrackId] : undefined;
            const active = position !== undefined && position >= segment.startMs && position < segment.endMs;
            const canSeek = segment.recordingTrackId !== null && playable.some((t) => t.id === segment.recordingTrackId);
            return (
              <li
                key={segment.id}
                ref={active ? activeLine : undefined}
                onClick={() => canSeek && seek(segment.recordingTrackId, segment.startMs)}
                className={`rounded px-2 py-1 ${active ? "bg-indigo-950/60" : ""} ${canSeek ? "cursor-pointer hover:bg-slate-900" : ""}`}
              >
                <span className="mr-2 font-mono text-xs text-slate-500">{formatTime(segment.startMs)}</span>
                <span className="mr-2 font-medium text-indigo-300">{speakerName(speakers.get(segment.speakerId ?? ""))}</span>
                {segment.text}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
