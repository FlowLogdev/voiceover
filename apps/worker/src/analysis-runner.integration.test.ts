/**
 * Integration tests against a real Postgres instance (DATABASE_URL; CI provides
 * one). The LLM is a scripted stand-in, so nothing leaves the machine.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LlmError,
  resolveAnalysis,
  TestDoubleLlmProvider,
  type LlmProvider,
  type MeetingAnalysisInput,
  type RawAnalysis,
} from "@voiceover/ai";
import { enqueueMeetingAnalysis, prisma } from "@voiceover/database";
import { AnalysisRunner } from "./analysis-runner.js";

const quiet = () => {};

/** Returns `make(input)` resolved against the real input, like a real provider would. */
function scripted(make: (input: MeetingAnalysisInput) => Partial<RawAnalysis>): LlmProvider & { calls: MeetingAnalysisInput[] } {
  const calls: MeetingAnalysisInput[] = [];
  return {
    name: "scripted",
    calls,
    async analyzeMeeting(input) {
      calls.push(input);
      const raw: RawAnalysis = {
        language: "en",
        executiveSummary: "Summary",
        keyPoints: [],
        topics: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
        risks: [],
        commitments: [],
        ...make(input),
      };
      return { result: resolveAnalysis(raw, input.segments), model: "scripted-model" };
    },
    async answerQuestion() {
      throw new Error("not used");
    },
  };
}

function failing(error: Error): LlmProvider {
  return {
    name: "failing",
    analyzeMeeting: async () => Promise.reject(error),
    answerQuestion: async () => Promise.reject(error),
  };
}

describe("AnalysisRunner (real Postgres)", () => {
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    const suffix = randomUUID();
    organizationId = (await prisma.organization.create({ data: { name: "Analysis org", slug: `analysis-${suffix}` } })).id;
    userId = (await prisma.user.create({ data: { email: `analysis-${suffix}@example.test`, name: "Ana" } })).id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function seedMeeting(lines: string[]) {
    const meeting = await prisma.meeting.create({ data: { organizationId, hostUserId: userId, title: "Release sync" } });
    const speaker = await prisma.speaker.create({ data: { meetingId: meeting.id, label: "Speaker 1", displayName: "Maria", externalKey: `k-${randomUUID()}` } });
    const segmentIds: string[] = [];
    for (const [i, text] of lines.entries()) {
      const segment = await prisma.transcriptSegment.create({
        data: {
          meetingId: meeting.id,
          speakerId: speaker.id,
          sourceTrack: "remote_tab",
          startMs: i * 5_000,
          endMs: i * 5_000 + 4_000,
          text,
          languageCode: "en",
          provider: "test-double",
          isFinal: true,
        },
      });
      segmentIds.push(segment.id);
    }
    return { meetingId: meeting.id, segmentIds };
  }

  async function queue(meetingId: string) {
    const result = await enqueueMeetingAnalysis({ meetingId, trigger: "manual", requestedByUserId: userId });
    if (!result.enqueued) throw new Error(`not enqueued: ${result.reason}`);
    return result.runId;
  }

  it("queues at most one analysis per meeting, and none without a transcript", async () => {
    const { meetingId } = await seedMeeting(["hello"]);
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueMeetingAnalysis({ meetingId, trigger: "manual" })));
    expect(results.filter((r) => r.enqueued)).toHaveLength(1);
    expect(results.filter((r) => !r.enqueued && r.reason === "already_queued")).toHaveLength(4);
    const empty = await prisma.meeting.create({ data: { organizationId, hostUserId: userId, title: "Silent" } });
    expect(await enqueueMeetingAnalysis({ meetingId: empty.id, trigger: "manual" })).toEqual({ enqueued: false, reason: "no_transcript" });
  });

  it("analyzes the transcript in order with speaker names, and stores grounded items with their evidence", async () => {
    const { meetingId, segmentIds } = await seedMeeting(["Let's ship Friday.", "I'll write the notes by 2026-11-12.", "Vendor API is flaky."]);
    const runId = await queue(meetingId);
    const llm = scripted(() => ({
      topics: [{ title: "Release", firstSegment: "S1", lastSegment: "S3" }],
      decisions: [{ text: "Ship Friday", evidence: ["S1"] }, { text: "Made up", evidence: ["S99"] }],
      actionItems: [{ text: "Write notes", owner: "Maria", dueDate: "2026-11-12", evidence: ["S2"] }],
      risks: [{ text: "Vendor API flaky", severity: "high", evidence: ["S3", "S1"] }],
    }));
    expect(await new AnalysisRunner({ llm, log: quiet }).runOnce({ runIds: [runId] })).toEqual([{ runId, status: "COMPLETE" }]);

    expect(llm.calls[0]!.segments.map((s) => [s.ref, s.speaker, s.text])).toEqual([
      ["S1", "Maria", "Let's ship Friday."],
      ["S2", "Maria", "I'll write the notes by 2026-11-12."],
      ["S3", "Maria", "Vendor API is flaky."],
    ]);
    const run = await prisma.meetingAnalysisRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "COMPLETE", provider: "scripted", modelName: "scripted-model", segmentCount: 3, droppedItemCount: 1, attempts: 1 });

    expect(await prisma.decision.findMany({ where: { meetingId }, select: { text: true, evidenceSegmentIds: true, sourceSegmentId: true, origin: true } })).toEqual([
      { text: "Ship Friday", evidenceSegmentIds: [segmentIds[0]], sourceSegmentId: segmentIds[0], origin: "AI" },
    ]);
    const action = await prisma.actionItem.findFirstOrThrow({ where: { meetingId } });
    expect(action).toMatchObject({ ownerName: "Maria", dueDate: new Date("2026-11-12T00:00:00Z"), analysisRunId: runId });
    expect((await prisma.risk.findFirstOrThrow({ where: { meetingId } })).evidenceSegmentIds).toEqual([segmentIds[0], segmentIds[2]]);
    expect(await prisma.topic.findMany({ where: { meetingId }, select: { title: true, startMs: true, endMs: true } })).toEqual([
      { title: "Release", startMs: 0, endMs: 14_000 },
    ]);
    expect(await prisma.summary.findFirstOrThrow({ where: { meetingId } })).toMatchObject({ kind: "executive", content: "Summary", modelName: "scripted-model" });
  });

  it("regenerates without destroying human work: edited and user-created items and an edited summary survive", async () => {
    const { meetingId } = await seedMeeting(["a", "b"]);
    const first = scripted(() => ({
      executiveSummary: "First summary",
      decisions: [{ text: "Keep me (edited)", evidence: ["S1"] }, { text: "Replace me", evidence: ["S2"] }],
    }));
    await new AnalysisRunner({ llm: first, log: quiet }).runOnce({ runIds: [await queue(meetingId)] });

    // A person edits one AI decision and the summary, and adds their own decision.
    await prisma.decision.updateMany({ where: { meetingId, text: "Keep me (edited)" }, data: { editedAt: new Date() } });
    await prisma.summary.updateMany({ where: { meetingId }, data: { content: "My summary", editedAt: new Date() } });
    await prisma.decision.create({ data: { meetingId, text: "User decision", origin: "USER" } });

    const second = scripted(() => ({
      executiveSummary: "Second summary",
      decisions: [{ text: "keep me  (EDITED)", evidence: ["S1"] }, { text: "New decision", evidence: ["S2"] }],
    }));
    await new AnalysisRunner({ llm: second, log: quiet }).runOnce({ runIds: [await queue(meetingId)] });

    const decisions = (await prisma.decision.findMany({ where: { meetingId } })).map((d) => d.text).sort();
    // "Replace me" is gone; the edited one isn't duplicated by its regenerated twin.
    expect(decisions).toEqual(["Keep me (edited)", "New decision", "User decision"]);
    const summaries = await prisma.summary.findMany({ where: { meetingId } });
    expect(summaries.map((s) => s.content)).toEqual(["My summary"]);
  });

  it("retries a transient LLM failure with backoff, then fails; fails a permanent one at once", async () => {
    const { meetingId } = await seedMeeting(["x"]);
    const runId = await queue(meetingId);
    let clock = Date.now();
    const runner = new AnalysisRunner({
      llm: failing(new LlmError("rate limited", true)),
      now: () => new Date(clock),
      maxAttempts: 2,
      baseRetryDelayMs: 60_000,
      log: quiet,
    });
    expect((await runner.runOnce({ runIds: [runId] }))[0]).toMatchObject({ status: "RETRY", error: "rate limited" });
    expect(await prisma.meetingAnalysisRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: "PENDING", attempts: 1, error: "rate limited" });
    expect(await runner.runOnce({ runIds: [runId] })).toEqual([]); // backing off
    clock += 61_000;
    expect((await runner.runOnce({ runIds: [runId] }))[0]).toMatchObject({ status: "FAILED" });
    expect((await prisma.meetingAnalysisRun.findUniqueOrThrow({ where: { id: runId } })).error).toMatch(/^Failed after 2 attempts: rate limited/);

    const other = await seedMeeting(["y"]);
    const permanentRun = await queue(other.meetingId);
    const permanent = new AnalysisRunner({ llm: failing(new LlmError("The model declined this request", false)), log: quiet });
    expect((await permanent.runOnce({ runIds: [permanentRun] }))[0]).toMatchObject({ status: "FAILED", error: "The model declined this request" });
    expect((await prisma.meetingAnalysisRun.findUniqueOrThrow({ where: { id: permanentRun } })).attempts).toBe(1);
  });

  it("discards a result whose lease was taken over by another worker", async () => {
    const { meetingId } = await seedMeeting(["z"]);
    const runId = await queue(meetingId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: LlmProvider = {
      name: "slow",
      async analyzeMeeting(input) {
        await gate;
        return new TestDoubleLlmProvider().analyzeMeeting(input);
      },
      answerQuestion: async () => Promise.reject(new Error("unused")),
    };
    const stale = new AnalysisRunner({ llm: slow, log: quiet });
    const claim = await stale.claimNext({ runIds: [runId] });
    const pending = stale.runClaimed(claim!.runId, claim!.attempts);

    // Its lease expires; another worker claims the run (attempt 2) while the first is still waiting on the model.
    const later = new AnalysisRunner({ llm: slow, log: quiet, now: () => new Date(Date.now() + 16 * 60_000) });
    expect((await later.claimNext({ runIds: [runId] }))?.attempts).toBe(2);
    release();

    expect(await pending).toEqual({ runId, status: "LEASE_LOST" });
    expect(await prisma.actionItem.count({ where: { meetingId } })).toBe(0);
    expect((await prisma.meetingAnalysisRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("RUNNING");
  });
});
