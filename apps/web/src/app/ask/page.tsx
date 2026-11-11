"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AskResponse, SessionResponse } from "@voiceover/types";
import { api, ApiError } from "@/lib/api-client";

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "Ask VoiceOver": questions answered from the organization's own meeting transcripts, with citations. */
export default function AskPage() {
  const router = useRouter();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.session().then(setSession, (err) => {
      if (err instanceof ApiError && err.statusCode === 401) router.replace("/login");
      else setError(err instanceof Error ? err.message : "Failed to load session");
    });
  }, [router]);

  async function onAsk(event: React.FormEvent) {
    event.preventDefault();
    const orgId = session?.activeOrganizationId;
    if (!orgId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.ask(orgId, { question }));
      setAsked(question);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get an answer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <a href="/dashboard" className="text-sm text-slate-400 hover:text-slate-200">
        ← Dashboard
      </a>
      <h1 className="mb-1 mt-4 text-2xl font-semibold">Ask VoiceOver</h1>
      <p className="mb-6 text-sm text-slate-400">
        Answers come only from your organization&apos;s meeting transcripts, with links to the moments they cite.
        Search is by keyword for now.
      </p>

      <form onSubmit={onAsk} className="mb-6 flex gap-2">
        <input
          required
          minLength={3}
          maxLength={500}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What did we decide about the launch date?"
          className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !session?.activeOrganizationId}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Thinking…" : "Ask"}
        </button>
      </form>

      {error && <p className="mb-4 rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}

      {result && (
        <section className="space-y-4">
          {result.retrievedExcerpts === 0 ? (
            <p className="text-sm text-slate-400">Nothing in your meetings matched &ldquo;{asked}&rdquo;. Try other words.</p>
          ) : (
            <>
              <div className="rounded-md border border-slate-800 p-4">
                <p className="whitespace-pre-wrap text-sm">{result.answer}</p>
                <p className="mt-2 text-[11px] text-slate-500">
                  {result.insufficientEvidence
                    ? "The transcripts don't clearly answer this."
                    : `From ${result.citations.length} cited excerpt(s) of ${result.retrievedExcerpts} retrieved`}
                  {result.model && ` · ${result.model}`}
                </p>
                {result.model === "test-double" && (
                  <p className="mt-1 text-[11px] text-amber-300/80">Placeholder answer from the test-double language model.</p>
                )}
              </div>
              {result.citations.length > 0 && (
                <ul className="space-y-2 text-sm">
                  {result.citations.map((c) => (
                    <li key={c.segmentId} className="rounded-md border border-slate-800 p-3">
                      <a href={`/meetings/${c.meetingId}`} className="text-xs text-indigo-300 hover:underline">
                        {c.meetingTitle} · {formatTime(c.startMs)} · {c.speaker}
                      </a>
                      <p className="mt-1 text-slate-300">&ldquo;{c.text}&rdquo;</p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
