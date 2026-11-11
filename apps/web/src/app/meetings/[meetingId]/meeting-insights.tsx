"use client";

import { useCallback, useEffect, useState } from "react";
import type { EvidenceDTO, InsightKind, MeetingInsightsDTO, UpdateInsightRequest } from "@voiceover/types";
import { api } from "@/lib/api-client";
import { requestSeek } from "./seek";

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function EvidenceLinks({ evidence }: { evidence: EvidenceDTO[] }) {
  if (evidence.length === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {evidence.map((e) => (
        <button
          key={e.segmentId}
          disabled={!e.recordingTrackId}
          onClick={() => e.recordingTrackId && requestSeek({ recordingTrackId: e.recordingTrackId, ms: e.startMs })}
          title="Play this moment"
          className="rounded bg-slate-800 px-1.5 font-mono text-[11px] text-indigo-300 hover:bg-slate-700 disabled:opacity-50"
        >
          ▶ {formatTime(e.startMs)}
        </button>
      ))}
    </span>
  );
}

interface ItemProps {
  text: string;
  edited: boolean;
  origin: "AI" | "USER";
  evidence: EvidenceDTO[];
  canEdit: boolean;
  detail?: React.ReactNode;
  toggle?: { checked: boolean; label: string; onChange: (checked: boolean) => void };
  onSaveText: (text: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

function InsightItem({ text, edited, evidence, canEdit, detail, toggle, onSaveText, onDelete }: ItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  return (
    <li className="group py-1.5">
      <div className="flex items-start gap-2">
        {toggle && (
          <input
            type="checkbox"
            aria-label={toggle.label}
            checked={toggle.checked}
            disabled={!canEdit}
            onChange={(e) => toggle.onChange(e.target.checked)}
            className="mt-1"
          />
        )}
        <div className="flex-1">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) void onSaveText(draft.trim()).then(() => setEditing(false));
              }}
            >
              <input
                autoFocus
                value={draft}
                maxLength={2000}
                onChange={(e) => setDraft(e.target.value)}
                className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
              />
              <button type="submit" className="rounded-md bg-indigo-600 px-2 text-xs">
                Save
              </button>
              <button type="button" onClick={() => setEditing(false)} className="text-xs text-slate-400">
                Cancel
              </button>
            </form>
          ) : (
            <span className={toggle?.checked ? "text-slate-500 line-through" : ""}>{text}</span>
          )}
          {detail && <span className="ml-2 text-xs text-slate-400">{detail}</span>}
          <EvidenceLinks evidence={evidence} />
          {edited && <span className="ml-2 text-[11px] text-slate-500">edited</span>}
        </div>
        {canEdit && !editing && (
          <span className="invisible flex gap-2 text-xs text-slate-400 group-hover:visible">
            <button
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button onClick={() => void onDelete()} className="text-red-400">
              Delete
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

const RUN_LABEL = {
  PENDING: "Analysis queued…",
  RUNNING: "Analyzing the transcript…",
  COMPLETE: "Analysis complete",
  FAILED: "Analysis failed",
} as const;

/**
 * AI summary, topics, decisions, action items, open questions, risks and
 * commitments for a meeting. Every item links back to the moments in the
 * recording that support it. Edits are kept when the analysis is regenerated.
 */
export function MeetingInsights({
  organizationId,
  meetingId,
  canEdit,
  refreshKey,
}: {
  organizationId: string;
  meetingId: string;
  canEdit: boolean;
  refreshKey?: string;
}) {
  const [insights, setInsights] = useState<MeetingInsightsDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");

  const load = useCallback(async () => {
    setInsights(await api.getInsights(organizationId, meetingId));
  }, [organizationId, meetingId]);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load insights"));
  }, [load, refreshKey]);

  const inFlight = insights?.latestRun?.status === "PENDING" || insights?.latestRun?.status === "RUNNING";
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => void load().catch(() => {}), 4000);
    return () => clearInterval(id);
  }, [inFlight, load]);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }
  const update = (kind: InsightKind, id: string, body: UpdateInsightRequest) =>
    act(() => api.updateInsight(organizationId, meetingId, kind, id, body));
  const remove = (kind: InsightKind, id: string) => act(() => api.deleteInsight(organizationId, meetingId, kind, id));

  if (!insights) return error ? <p className="text-sm text-red-300">{error}</p> : null;
  const run = insights.latestRun;
  const hasAny =
    insights.summary ||
    [insights.decisions, insights.actionItems, insights.questions, insights.risks, insights.commitments].some((l) => l.length > 0);
  const placeholder = insights.summary?.modelName === "test-double";

  const section = (title: string, children: React.ReactNode, count: number) =>
    count > 0 && (
      <div>
        <h3 className="mb-1 text-sm font-medium text-slate-300">{title}</h3>
        <ul className="divide-y divide-slate-800/60 text-sm">{children}</ul>
      </div>
    );

  return (
    <section className="mb-8 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Insights</h2>
        {canEdit && (
          <button
            onClick={() => void act(() => api.regenerateAnalysis(organizationId, meetingId))}
            disabled={inFlight}
            className="rounded-md border border-slate-700 px-3 py-1 text-sm hover:bg-slate-900 disabled:opacity-50"
          >
            {hasAny ? "Regenerate" : "Analyze"}
          </button>
        )}
      </div>
      {run && (
        <p className={`text-xs ${run.status === "FAILED" ? "text-red-300" : "text-slate-500"}`}>
          {RUN_LABEL[run.status]}
          {run.status === "COMPLETE" && run.modelName && ` · ${run.modelName}`}
          {run.status === "COMPLETE" && run.droppedItemCount ? ` · ${run.droppedItemCount} unsupported item(s) discarded` : ""}
          {run.status !== "COMPLETE" && run.error && `: ${run.error}`}
        </p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {placeholder && (
        <p className="text-xs text-amber-300/80">
          Placeholder output from the test-double language model: set LLM_PROVIDER=anthropic for real analysis.
        </p>
      )}
      {hasAny && <p className="text-xs text-slate-500">AI-generated from the transcript: check before relying on it. Edited items are kept when you regenerate.</p>}

      {insights.summary && (
        <div className="rounded-md border border-slate-800 p-3">
          {editingSummary ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => api.updateSummary(organizationId, meetingId, summaryDraft)).then(() => setEditingSummary(false));
              }}
            >
              <textarea
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
                rows={5}
                className="w-full rounded-md border border-slate-700 bg-slate-900 p-2 text-sm"
              />
              <div className="mt-2 flex gap-2">
                <button type="submit" className="rounded-md bg-indigo-600 px-3 py-1 text-xs">
                  Save
                </button>
                <button type="button" onClick={() => setEditingSummary(false)} className="text-xs text-slate-400">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="whitespace-pre-wrap text-sm">{insights.summary.content}</p>
              {insights.summary.keyPoints.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-sm text-slate-300">
                  {insights.summary.keyPoints.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                {insights.summary.edited ? "Edited summary" : `Generated ${new Date(insights.summary.generatedAt).toLocaleString()}`}
                {canEdit && (
                  <button
                    onClick={() => {
                      setSummaryDraft(insights.summary!.content);
                      setEditingSummary(true);
                    }}
                    className="ml-2 text-slate-400 hover:text-slate-200"
                  >
                    Edit
                  </button>
                )}
              </p>
            </>
          )}
        </div>
      )}

      {insights.topics.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {insights.topics.map((t) => (
            <span key={t.id} className="rounded-full border border-slate-700 px-2 py-0.5 text-slate-300">
              {t.title} · {formatTime(t.startMs)}
            </span>
          ))}
        </div>
      )}

      {section(
        "Action items",
        insights.actionItems.map((a) => (
          <InsightItem
            key={a.id}
            {...a}
            canEdit={canEdit}
            detail={[a.ownerName, a.dueDate && `due ${a.dueDate}`].filter(Boolean).join(" · ") || undefined}
            toggle={{ checked: a.isDone, label: "Done", onChange: (isDone) => void update("action-items", a.id, { isDone }) }}
            onSaveText={(text) => update("action-items", a.id, { text })}
            onDelete={() => remove("action-items", a.id)}
          />
        )),
        insights.actionItems.length,
      )}
      {section(
        "Decisions",
        insights.decisions.map((d) => (
          <InsightItem
            key={d.id}
            {...d}
            canEdit={canEdit}
            onSaveText={(text) => update("decisions", d.id, { text })}
            onDelete={() => remove("decisions", d.id)}
          />
        )),
        insights.decisions.length,
      )}
      {section(
        "Commitments",
        insights.commitments.map((c) => (
          <InsightItem
            key={c.id}
            {...c}
            canEdit={canEdit}
            detail={[c.committedBy, c.dueDate && `by ${c.dueDate}`].filter(Boolean).join(" · ") || undefined}
            toggle={{ checked: c.isFulfilled, label: "Fulfilled", onChange: (isFulfilled) => void update("commitments", c.id, { isFulfilled }) }}
            onSaveText={(text) => update("commitments", c.id, { text })}
            onDelete={() => remove("commitments", c.id)}
          />
        )),
        insights.commitments.length,
      )}
      {section(
        "Risks",
        insights.risks.map((r) => (
          <InsightItem
            key={r.id}
            {...r}
            canEdit={canEdit}
            detail={r.severity ?? undefined}
            onSaveText={(text) => update("risks", r.id, { text })}
            onDelete={() => remove("risks", r.id)}
          />
        )),
        insights.risks.length,
      )}
      {section(
        "Open questions",
        insights.questions.map((q) => (
          <InsightItem
            key={q.id}
            {...q}
            canEdit={canEdit}
            toggle={{ checked: q.isResolved, label: "Resolved", onChange: (isResolved) => void update("questions", q.id, { isResolved }) }}
            onSaveText={(text) => update("questions", q.id, { text })}
            onDelete={() => remove("questions", q.id)}
          />
        )),
        insights.questions.length,
      )}
    </section>
  );
}
