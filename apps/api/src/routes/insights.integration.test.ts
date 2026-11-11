/**
 * Integration tests against a real Postgres instance (DATABASE_URL): see
 * auth.integration.test.ts for setup. Insights are seeded the way the
 * worker's AnalysisRunner stores them (tested in apps/worker); Ask VoiceOver
 * runs real full-text retrieval with a recording LLM stand-in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { resolveAnswer, type AskInput, type LlmProvider } from "@voiceover/ai";
import { prisma } from "@voiceover/database";
import type { AskResponse, MeetingInsightsDTO } from "@voiceover/types";
import { buildApp } from "../app.js";
import { AskRateLimiter } from "./ask.js";

interface TestUser {
  userId: string;
  cookie: string;
  organizationId: string;
}

/** Cites every excerpt it's shown and records what it saw. */
const asked: AskInput[] = [];
const recordingLlm: LlmProvider = {
  name: "recording",
  analyzeMeeting: async () => Promise.reject(new Error("analysis runs in the worker")),
  async answerQuestion(input) {
    asked.push(input);
    return {
      result: resolveAnswer({ answer: `Answer from ${input.excerpts.length} excerpts`, citations: input.excerpts.map((e) => e.ref), insufficientEvidence: false }, input.excerpts),
      model: "recording-model",
    };
  },
};

describe("meeting insights and Ask VoiceOver (real Postgres)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ llm: recordingLlm, askRateLimiter: new AskRateLimiter(3, 60 * 60_000) });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function signup(label: string): Promise<TestUser> {
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        password: "a-long-enough-password",
        name: label,
        organizationName: `${label} org`,
      },
    });
    expect(response.statusCode).toBe(201);
    const raw = response.headers["set-cookie"];
    return { ...(response.json() as { userId: string; organizationId: string }), cookie: (Array.isArray(raw) ? raw[0] : raw)!.split(";")[0]! };
  }

  async function meetingWithTranscript(user: TestUser, title: string, lines: string[]) {
    const meeting = await prisma.meeting.create({ data: { organizationId: user.organizationId, hostUserId: user.userId, title } });
    const session = await prisma.recordingSession.create({
      data: { meetingId: meeting.id, method: "BROWSER", status: "COMPLETE", tracks: { create: { sourceTrack: "remote_tab", storagePrefix: "x" } } },
      include: { tracks: true },
    });
    const speaker = await prisma.speaker.create({ data: { meetingId: meeting.id, label: "Tab audio", displayName: "Maria", externalKey: `${session.tracks[0]!.id}:track` } });
    const segments = [];
    for (const [i, text] of lines.entries()) {
      segments.push(
        await prisma.transcriptSegment.create({
          data: {
            meetingId: meeting.id,
            speakerId: speaker.id,
            recordingTrackId: session.tracks[0]!.id,
            sourceTrack: "remote_tab",
            startMs: i * 10_000,
            endMs: i * 10_000 + 9_000,
            text,
            languageCode: "en",
            provider: "test-double",
            isFinal: true,
          },
        }),
      );
    }
    return { meetingId: meeting.id, trackId: session.tracks[0]!.id, segments };
  }

  const call = (user: TestUser, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: user.cookie }, ...(payload ? { payload } : {}) });

  it("serves insights with evidence linking to transcript time and track, and lets members edit and delete them", async () => {
    const owner = await signup("insights-owner");
    const { meetingId, trackId, segments } = await meetingWithTranscript(owner, "Release sync", ["Ship Friday", "Notes by Thursday", "Vendor is flaky"]);
    const base = `/organizations/${owner.organizationId}/meetings/${meetingId}`;

    const empty = (await call(owner, "GET", `${base}/insights`)).json() as MeetingInsightsDTO;
    expect(empty).toMatchObject({ latestRun: null, summary: null, decisions: [], actionItems: [] });

    // Queue an analysis (the worker would pick it up); a second request while it's queued is a 409.
    const queued = await call(owner, "POST", `${base}/analysis`);
    expect(queued.statusCode).toBe(202);
    const runId = queued.json().runId as string;
    expect((await call(owner, "POST", `${base}/analysis`)).statusCode).toBe(409);

    // What the worker stores on completion.
    await prisma.meetingAnalysisRun.update({ where: { id: runId }, data: { status: "COMPLETE", provider: "test-double", modelName: "test-double", completedAt: new Date(), droppedItemCount: 1 } });
    await prisma.summary.create({ data: { meetingId, kind: "executive", content: "We ship Friday.", keyPoints: ["Friday"], language: "en", modelName: "test-double", analysisRunId: runId } });
    const action = await prisma.actionItem.create({
      data: { meetingId, text: "Write notes", analysisRunId: runId, sourceSegmentId: segments[1]!.id, evidenceSegmentIds: [segments[2]!.id, segments[1]!.id] },
    });
    const decision = await prisma.decision.create({ data: { meetingId, text: "Ship Friday", analysisRunId: runId, evidenceSegmentIds: [segments[0]!.id] } });

    const insights = (await call(owner, "GET", `${base}/insights`)).json() as MeetingInsightsDTO;
    expect(insights.latestRun).toMatchObject({ id: runId, status: "COMPLETE", trigger: "manual", droppedItemCount: 1 });
    expect(insights.summary).toMatchObject({ content: "We ship Friday.", keyPoints: ["Friday"], edited: false });
    expect(insights.actionItems).toEqual([
      {
        id: action.id,
        text: "Write notes",
        origin: "AI",
        edited: false,
        ownerName: null,
        dueDate: null,
        isDone: false,
        // Sorted by time, each pointing at the track to play.
        evidence: [
          { segmentId: segments[1]!.id, startMs: 10_000, recordingTrackId: trackId },
          { segmentId: segments[2]!.id, startMs: 20_000, recordingTrackId: trackId },
        ],
      },
    ]);

    const edit = await call(owner, "PATCH", `${base}/insights/action-items/${action.id}`, { ownerName: "João", dueDate: "2026-11-20", isDone: true });
    expect(edit.statusCode).toBe(200);
    expect(await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
      ownerName: "João",
      dueDate: new Date("2026-11-20T00:00:00Z"),
      isDone: true,
    });
    // Fields that don't belong to the kind, unknown fields and bad dates are rejected.
    expect((await call(owner, "PATCH", `${base}/insights/decisions/${decision.id}`, { isDone: true })).statusCode).toBe(400);
    expect((await call(owner, "PATCH", `${base}/insights/decisions/${decision.id}`, { text: "x", hacked: 1 })).statusCode).toBe(400);
    expect((await call(owner, "PATCH", `${base}/insights/action-items/${action.id}`, { dueDate: "next week" })).statusCode).toBe(400);

    expect((await call(owner, "PATCH", `${base}/summary`, { content: "Shipping Friday, notes Thursday." })).statusCode).toBe(200);
    const after = (await call(owner, "GET", `${base}/insights`)).json() as MeetingInsightsDTO;
    expect(after.actionItems[0]).toMatchObject({ edited: true, ownerName: "João", dueDate: "2026-11-20", isDone: true });
    expect(after.summary).toMatchObject({ content: "Shipping Friday, notes Thursday.", edited: true });

    expect((await call(owner, "DELETE", `${base}/insights/decisions/${decision.id}`)).statusCode).toBe(204);
    expect((await call(owner, "DELETE", `${base}/insights/decisions/${decision.id}`)).statusCode).toBe(404);

    // Guests can read but not change; another organization can't reach any of it.
    const guest = await signup("insights-guest");
    await prisma.membership.create({ data: { userId: guest.userId, organizationId: owner.organizationId, role: "GUEST" } });
    const asGuest = { ...guest, organizationId: owner.organizationId };
    expect((await call(asGuest, "GET", `${base}/insights`)).statusCode).toBe(200);
    expect((await call(asGuest, "PATCH", `${base}/insights/action-items/${action.id}`, { isDone: false })).statusCode).toBe(403);
    expect((await call(asGuest, "POST", `${base}/analysis`)).statusCode).toBe(403);
    const outsider = await signup("insights-outsider");
    const outsiderBase = `/organizations/${outsider.organizationId}/meetings/${meetingId}`;
    expect((await call(outsider, "GET", `${outsiderBase}/insights`)).statusCode).toBe(404);
    expect((await call(outsider, "PATCH", `${outsiderBase}/insights/action-items/${action.id}`, { isDone: false })).statusCode).toBe(404);
    expect((await call(outsider, "GET", `${base}/insights`)).statusCode).toBe(403);
  });

  it("refuses to queue an analysis of a meeting without a transcript", async () => {
    const owner = await signup("insights-empty");
    const meeting = await prisma.meeting.create({ data: { organizationId: owner.organizationId, hostUserId: owner.userId, title: "Silent" } });
    expect((await call(owner, "POST", `/organizations/${owner.organizationId}/meetings/${meeting.id}/analysis`)).statusCode).toBe(400);
  });

  it("answers from the organization's own transcripts only, with citations, and rate-limits model calls", async () => {
    const owner = await signup("ask-owner");
    const other = await signup("ask-other");
    await meetingWithTranscript(owner, "Budget review", ["The marketing budget for Q3 is 40k", "Unrelated small talk"]);
    await meetingWithTranscript(other, "Other org", ["Our marketing budget is secret 99k"]);
    const askUrl = `/organizations/${owner.organizationId}/ask`;

    asked.length = 0;
    const response = await call(owner, "POST", askUrl, { question: "What is the marketing budget?" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AskResponse;
    expect(body).toMatchObject({ model: "recording-model", insufficientEvidence: false, retrievedExcerpts: 1 });
    expect(body.citations).toEqual([expect.objectContaining({ meetingTitle: "Budget review", speaker: "Maria", text: "The marketing budget for Q3 is 40k", startMs: 0 })]);
    // The other organization's transcript was never retrieved, so never sent to the model.
    expect(asked[0]!.excerpts.map((e) => e.text)).toEqual(["The marketing budget for Q3 is 40k"]);

    // Nothing matches: no model call at all.
    const none = (await call(owner, "POST", askUrl, { question: "zebra xylophone" })).json() as AskResponse;
    expect(none).toEqual({ answer: "", insufficientEvidence: true, citations: [], model: null, retrievedExcerpts: 0 });
    expect(asked).toHaveLength(1);

    // Scoped to a short meeting: the whole transcript is offered, even without keyword matches.
    const { meetingId } = await meetingWithTranscript(owner, "Standup", ["Blocked on review", "Will pair later"]);
    const scoped = (await call(owner, "POST", askUrl, { question: "What happened here?", meetingId })).json() as AskResponse;
    expect(scoped.retrievedExcerpts).toBe(2);
    expect((await call(owner, "POST", askUrl, { question: "anything?", meetingId: (await prisma.meeting.findFirstOrThrow({ where: { organizationId: other.organizationId } })).id })).statusCode).toBe(404);

    // Limit is 3 model calls per hour in this app: two used, one left, then 429.
    expect((await call(owner, "POST", askUrl, { question: "marketing budget again" })).statusCode).toBe(200);
    expect((await call(owner, "POST", askUrl, { question: "marketing budget once more" })).statusCode).toBe(429);
    expect((await call(other, "POST", `/organizations/${owner.organizationId}/ask`, { question: "marketing budget" })).statusCode).toBe(403);
  });
});
