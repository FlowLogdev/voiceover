"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MeetingSummaryDTO, SessionResponse } from "@voiceover/types";
import { api, ApiError } from "@/lib/api-client";

function newTrackId(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36);
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [meetings, setMeetings] = useState<MeetingSummaryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testTrackId] = useState(newTrackId);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const s = await api.session();
        if (cancelled) return;
        setSession(s);
        if (s.activeOrganizationId) {
          const m = await api.listMeetings(s.activeOrganizationId);
          if (!cancelled) setMeetings(m);
        }
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 401) {
          router.replace("/login");
          return;
        }
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load dashboard");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onLogout() {
    await api.logout();
    router.push("/login");
  }

  if (error) {
    return <main className="p-8 text-red-400">{error}</main>;
  }

  if (!session) {
    return <main className="p-8 text-slate-400">Loading...</main>;
  }

  const activeOrg = session.organizations.find((o) => o.id === session.activeOrganizationId);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{activeOrg?.name ?? "Dashboard"}</h1>
          <p className="text-sm text-slate-400">{session.user.email}</p>
        </div>
        <div className="flex gap-3">
          <a
            href={`/recorder/${testTrackId}`}
            className="rounded-md border border-indigo-500 px-4 py-2 text-sm text-indigo-300 hover:bg-indigo-500/10"
          >
            Open live recorder (test)
          </a>
          <button
            onClick={onLogout}
            className="rounded-md border border-slate-700 px-4 py-2 text-sm hover:bg-slate-900"
          >
            Log out
          </button>
        </div>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-medium">Meetings</h2>
        {meetings === null ? (
          <p className="text-slate-400">Loading meetings...</p>
        ) : meetings.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-700 p-8 text-center text-slate-400">
            No meetings yet. Recording (browser capture / meeting bot) is built in a later
            phase — see IMPLEMENTATION_PLAN.md.
          </div>
        ) : (
          <ul className="divide-y divide-slate-800">
            {meetings.map((m) => (
              <li key={m.id} className="py-3">
                <p className="font-medium">{m.title}</p>
                <p className="text-sm text-slate-400">{m.platform ?? "unknown platform"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
