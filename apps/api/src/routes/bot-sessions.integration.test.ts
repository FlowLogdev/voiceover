/**
 * Integration tests against a real Postgres instance (DATABASE_URL) — see
 * auth.integration.test.ts for setup. Bot provider is the deterministic test
 * double (no real meeting is joined); everything else — routes, Prisma
 * persistence, tenancy, audit log, the shared ingestion pipeline, the
 * transcript WebSocket — is real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { prisma } from "@voiceover/database";
import { AdmissionRetryPolicy, TestDoubleMeetingBotProvider } from "@voiceover/meeting-bot";
import type { BotSessionDTO } from "@voiceover/types";
import { buildApp } from "../app.js";
import { InMemoryChunkStore } from "../recording/chunk-store.js";

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("Expected a Set-Cookie header");
  return raw.split(";")[0]!;
}

describe("meeting bot sessions (real Postgres, test-double bot provider)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const chunkStore = new InMemoryChunkStore();

  async function signup(label: string) {
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
    return { cookie: extractCookie(response.headers["set-cookie"]), organizationId: response.json().organizationId as string };
  }

  async function createMeeting(user: { cookie: string; organizationId: string }) {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/meetings`,
      headers: { cookie: user.cookie },
      payload: { title: "Weekly sync" },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function getSession(user: { cookie: string; organizationId: string }, sessionId: string) {
    return app.inject({
      method: "GET",
      url: `/organizations/${user.organizationId}/bot-sessions/${sessionId}`,
      headers: { cookie: user.cookie },
    });
  }

  beforeAll(async () => {
    app = await buildApp({
      chunkStore,
      meetingBotProvider: new TestDoubleMeetingBotProvider({
        stepDelayMs: 20,
        frameDurationMs: 50,
        speechBurstMs: 300,
        silenceMs: 700,
      }),
      botRetryPolicy: new AdmissionRetryPolicy({ maxAttempts: 1 }),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("invites a bot, streams its transcript live to a watcher, and leaves on request", async () => {
    const user = await signup("bot-owner");
    const meetingId = await createMeeting(user);

    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/meetings/${meetingId}/bot-sessions`,
      headers: { cookie: user.cookie },
      payload: { meetingUrl: "https://meet.google.com/ABC-defg-hij" },
    });
    expect(invite.statusCode).toBe(201);
    const created = invite.json() as BotSessionDTO;
    expect(created).toMatchObject({
      meetingId,
      provider: "test-double",
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      joinAttempts: 1,
    });
    // Dispatched immediately; the 20ms simulated steps may already have advanced it on a slow runner.
    expect(["JOINING", "WAITING_ROOM", "IN_CALL"]).toContain(created.status);

    // Watch the bot's track over the transcript WebSocket.
    const messages: Array<{ type: string; sourceTrack?: string }> = [];
    const socket = new WebSocket(`ws://${baseUrl}/recording-tracks/${created.recordingTrackId}/transcript`, {
      headers: { cookie: user.cookie },
    });
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await waitFor(() => (messages.some((m) => m.type === "subscribed") ? true : undefined));

    const inCall = await waitFor(async () => {
      const dto = (await getSession(user, created.id)).json() as BotSessionDTO;
      return dto.status === "IN_CALL" ? dto : undefined;
    });
    expect(inCall.startedAt).not.toBeNull();

    await waitFor(() => (messages.some((m) => m.type === "transcript.final") ? true : undefined));
    expect(messages.find((m) => m.type === "transcript.partial")?.sourceTrack).toBe("bot_mixed");
    expect(chunkStore.sequencesFor(created.recordingTrackId).length).toBeGreaterThan(0);

    const leave = await app.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/bot-sessions/${created.id}/leave`,
      headers: { cookie: user.cookie },
    });
    expect(leave.statusCode).toBe(200);
    expect((leave.json() as BotSessionDTO).status).toBe("LEFT");
    socket.close();

    const row = await prisma.recordingSession.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe("FINALIZING"); // finalisation job is Phase 5
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(meeting).toMatchObject({ platform: "google_meet", recordingMethod: "BOT" });
    const audit = await prisma.auditLog.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["BOT_INVITED", "BOT_LEFT"]);

    // Leaving again is a no-op, not a second audit entry.
    const again = await app.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/bot-sessions/${created.id}/leave`,
      headers: { cookie: user.cookie },
    });
    expect((again.json() as BotSessionDTO).status).toBe("LEFT");
    expect(await prisma.auditLog.count({ where: { organizationId: user.organizationId } })).toBe(2);
  });

  it("schedules a future join, rejects a second active bot, and cancels cleanly", async () => {
    const user = await signup("bot-scheduler");
    const meetingId = await createMeeting(user);
    const joinAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const url = `/organizations/${user.organizationId}/meetings/${meetingId}/bot-sessions`;

    const invite = await app.inject({
      method: "POST",
      url,
      headers: { cookie: user.cookie },
      payload: { meetingUrl: "https://acme.zoom.us/j/81234567890?pwd=x", joinAt, botName: "Scribe" },
    });
    expect(invite.statusCode).toBe(201);
    const created = invite.json() as BotSessionDTO;
    expect(created).toMatchObject({ status: "SCHEDULED", joinAttempts: 0, platform: "zoom", botName: "Scribe" });
    expect(created.scheduledJoinAt).toBe(joinAt);

    const duplicate = await app.inject({
      method: "POST",
      url,
      headers: { cookie: user.cookie },
      payload: { meetingUrl: "https://meet.google.com/abc-defg-hij" },
    });
    expect(duplicate.statusCode).toBe(409);

    const leave = await app.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/bot-sessions/${created.id}/leave`,
      headers: { cookie: user.cookie },
    });
    expect((leave.json() as BotSessionDTO).status).toBe("LEFT");
    const row = await prisma.recordingSession.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe("CANCELED");

    const list = await app.inject({ method: "GET", url, headers: { cookie: user.cookie } });
    expect((list.json() as BotSessionDTO[]).map((s) => s.id)).toEqual([created.id]);
  });

  it("validates meeting links and join times", async () => {
    const user = await signup("bot-validation");
    const meetingId = await createMeeting(user);
    const url = `/organizations/${user.organizationId}/meetings/${meetingId}/bot-sessions`;

    for (const payload of [
      { meetingUrl: "https://example.com/j/81234567890" },
      { meetingUrl: "http://meet.google.com/abc-defg-hij" },
      { meetingUrl: "https://meet.google.com/abc-defg-hij", joinAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      { meetingUrl: "https://meet.google.com/abc-defg-hij", joinAt: new Date(Date.now() + 120 * 86_400_000).toISOString() },
    ]) {
      const response = await app.inject({ method: "POST", url, headers: { cookie: user.cookie }, payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await prisma.recordingSession.count({ where: { meetingId } })).toBe(0);
  });

  it("isolates bot sessions and their transcript feed between organizations", async () => {
    const owner = await signup("bot-tenant-a");
    const outsider = await signup("bot-tenant-b");
    const meetingId = await createMeeting(owner);
    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${owner.organizationId}/meetings/${meetingId}/bot-sessions`,
      headers: { cookie: owner.cookie },
      payload: { meetingUrl: "https://teams.live.com/meet/9876543210", joinAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    const created = invite.json() as BotSessionDTO;

    // Outsider naming the owner's org: not a member.
    expect((await getSession({ ...outsider, organizationId: owner.organizationId }, created.id)).statusCode).toBe(403);
    // Outsider naming their own org with the owner's session id: not found.
    expect((await getSession(outsider, created.id)).statusCode).toBe(404);
    const leave = await app.inject({
      method: "POST",
      url: `/organizations/${outsider.organizationId}/bot-sessions/${created.id}/leave`,
      headers: { cookie: outsider.cookie },
    });
    expect(leave.statusCode).toBe(404);
    // Outsider inviting a bot into the owner's meeting via their own org: meeting not found.
    const hijack = await app.inject({
      method: "POST",
      url: `/organizations/${outsider.organizationId}/meetings/${meetingId}/bot-sessions`,
      headers: { cookie: outsider.cookie },
      payload: { meetingUrl: "https://meet.google.com/abc-defg-hij" },
    });
    expect(hijack.statusCode).toBe(404);

    const closeCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://${baseUrl}/recording-tracks/${created.recordingTrackId}/transcript`, {
        headers: { cookie: outsider.cookie },
      });
      socket.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(4004);

    expect((await getSession(owner, created.id)).json().status).toBe("SCHEDULED");
    await app.inject({
      method: "POST",
      url: `/organizations/${owner.organizationId}/bot-sessions/${created.id}/leave`,
      headers: { cookie: owner.cookie },
    });
  });
});
