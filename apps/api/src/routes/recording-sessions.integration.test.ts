/**
 * Integration tests against a real Postgres instance (DATABASE_URL): see
 * auth.integration.test.ts for setup. Covers server-issued browser-capture
 * tracks, the upload socket's ownership check (PrismaUploadAuthorizer), and
 * recording consent (attestation, stop, revocation across browser + bot).
 * The bot provider and ASR are deterministic test doubles.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildChunkFrame } from "@voiceover/audio";
import { prisma } from "@voiceover/database";
import { AdmissionRetryPolicy, TestDoubleMeetingBotProvider } from "@voiceover/meeting-bot";
import {
  RECORDING_CONSENT_NOTICE,
  type BotSessionDTO,
  type RecordingSessionDTO,
  type RevokeConsentResponse,
  type ServerMessage,
} from "@voiceover/types";
import { buildApp } from "../app.js";
import { InMemoryChunkStore } from "../recording/chunk-store.js";

const consent = { attested: true, noticeVersion: RECORDING_CONSENT_NOTICE.version } as const;

interface TestUser {
  userId: string;
  cookie: string;
  organizationId: string;
}

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

function chunkMessage(sequenceNumber: number) {
  const frame = buildChunkFrame({
    sequenceNumber,
    startMs: sequenceNumber * 100,
    endMs: (sequenceNumber + 1) * 100,
    sourceTrack: "remote_tab",
    sampleRate: 16_000,
    samples: new Float32Array(1600),
  });
  return JSON.stringify({
    type: "chunk",
    sequenceNumber: frame.sequenceNumber,
    startMs: frame.startMs,
    endMs: frame.endMs,
    sourceTrack: frame.sourceTrack,
    sampleRate: frame.sampleRate,
    checksum: frame.checksum,
    bytesBase64: Buffer.from(frame.bytes).toString("base64"),
  });
}

describe("browser recording sessions, upload ownership and consent (real Postgres)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const chunkStore = new InMemoryChunkStore();

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
    const body = response.json() as { userId: string; organizationId: string };
    return { userId: body.userId, organizationId: body.organizationId, cookie: extractCookie(response.headers["set-cookie"]) };
  }

  /** A second user who is also a member of `owner`'s organization, with the given role. */
  async function colleague(owner: TestUser, role: "MEMBER" | "GUEST"): Promise<TestUser> {
    const user = await signup(`colleague-${role.toLowerCase()}`);
    await prisma.membership.create({ data: { userId: user.userId, organizationId: owner.organizationId, role } });
    return { ...user, organizationId: owner.organizationId };
  }

  async function createMeeting(user: TestUser) {
    const response = await app.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/meetings`,
      headers: { cookie: user.cookie },
      payload: { title: "Customer call" },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  function startRecording(user: TestUser, meetingId: string, payload: unknown = { consent }) {
    return app.inject({
      method: "POST",
      url: `/organizations/${user.organizationId}/meetings/${meetingId}/recording-sessions`,
      headers: { cookie: user.cookie },
      payload: payload as Record<string, unknown>,
    });
  }

  /** Connects to the upload socket; resolves once it's either accepted (first ack) or closed. */
  function upload(user: TestUser, trackId: string) {
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`ws://${baseUrl}/recording-tracks/${trackId}/audio`, { headers: { cookie: user.cookie } });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    socket.on("open", () => socket.send(chunkMessage(0)));
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    return { socket, messages, closed };
  }

  async function closeCodeFor(user: TestUser, trackId: string): Promise<number> {
    return (await upload(user, trackId).closed).code;
  }

  beforeAll(async () => {
    app = await buildApp({
      chunkStore,
      meetingBotProvider: new TestDoubleMeetingBotProvider({ stepDelayMs: 20, frameDurationMs: 50, speechBurstMs: 300, silenceMs: 700 }),
      botRetryPolicy: new AdmissionRetryPolicy({ maxAttempts: 1 }),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("issues tracks server-side only against a current consent attestation, and only the starting user may upload", async () => {
    const owner = await signup("rec-owner");
    const meetingId = await createMeeting(owner);

    for (const payload of [
      {},
      { consent: { attested: false, noticeVersion: RECORDING_CONSENT_NOTICE.version } },
      { consent: { attested: true, noticeVersion: "2020-01-01" } },
    ]) {
      expect((await startRecording(owner, meetingId, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await prisma.recordingSession.count({ where: { meetingId } })).toBe(0);

    const started = await startRecording(owner, meetingId);
    expect(started.statusCode).toBe(201);
    const session = started.json() as RecordingSessionDTO;
    expect(session).toMatchObject({ meetingId, method: "BROWSER", status: "RECORDING" });
    expect(session.tracks.map((t) => t.sourceTrack)).toEqual(["remote_tab"]);
    const trackId = session.tracks[0]!.id;

    const row = await prisma.recordingSession.findUniqueOrThrow({ where: { id: session.id }, include: { consents: true } });
    expect(row.startedByUserId).toBe(owner.userId);
    expect(row.consents).toEqual([
      expect.objectContaining({ userId: owner.userId, basis: "ORGANIZER_ATTESTATION", noticeVersion: RECORDING_CONSENT_NOTICE.version, revokedAt: null }),
    ]);
    const actions = (await prisma.auditLog.findMany({ where: { organizationId: owner.organizationId } })).map((a) => a.action);
    expect(actions.sort()).toEqual(["CONSENT_GRANTED", "RECORDING_STARTED"]);
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).toMatchObject({ recordingMethod: "BROWSER" });

    // The starting user can upload.
    const ownerUpload = upload(owner, trackId);
    await waitFor(() => (ownerUpload.messages.some((m) => m.type === "ack") ? true : undefined));
    expect(chunkStore.sequencesFor(trackId)).toEqual([0]);
    ownerUpload.socket.close();

    // Same-org colleague who didn't start it: forbidden. Another org: not found. Made-up id: not found.
    expect(await closeCodeFor(await colleague(owner, "MEMBER"), trackId)).toBe(4003);
    expect(await closeCodeFor(await signup("rec-outsider"), trackId)).toBe(4004);
    expect(await closeCodeFor(owner, randomUUID())).toBe(4004);

    // Bot tracks are server-written only: even the bot's inviter can't push audio into one.
    const bot = await app.inject({
      method: "POST",
      url: `/organizations/${owner.organizationId}/meetings/${meetingId}/bot-sessions`,
      headers: { cookie: owner.cookie },
      payload: { meetingUrl: "https://meet.google.com/abc-defg-hij", joinAt: new Date(Date.now() + 3_600_000).toISOString(), consent },
    });
    expect(bot.statusCode).toBe(201);
    expect(await closeCodeFor(owner, (bot.json() as BotSessionDTO).recordingTrackId)).toBe(4004);

    // Guests can't start a recording.
    const guest = await colleague(owner, "GUEST");
    expect((await startRecording(guest, meetingId)).statusCode).toBe(403);
    expect(chunkStore.sequencesFor(trackId)).toEqual([0]);
  });

  it("stop closes the live upload at once and the track can't be reused", async () => {
    const owner = await signup("rec-stopper");
    const meetingId = await createMeeting(owner);
    const session = (await startRecording(owner, meetingId)).json() as RecordingSessionDTO;
    const trackId = session.tracks[0]!.id;

    const live = upload(owner, trackId);
    await waitFor(() => (live.messages.some((m) => m.type === "ack") ? true : undefined));

    const stop = () =>
      app.inject({
        method: "POST",
        url: `/organizations/${owner.organizationId}/recording-sessions/${session.id}/stop`,
        headers: { cookie: owner.cookie },
      });
    const stopped = await stop();
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ status: "FINALIZING" });
    expect((await live.closed).code).toBe(4009);

    expect(await closeCodeFor(owner, trackId)).toBe(4009);
    await stop(); // idempotent
    const stoppedAudits = await prisma.auditLog.count({ where: { organizationId: owner.organizationId, action: "RECORDING_STOPPED" } });
    expect(stoppedAudits).toBe(1);
  });

  it("revoking consent stops every recording on the meeting: a live browser upload and an in-call bot", async () => {
    const owner = await signup("rec-revoke");
    const meetingId = await createMeeting(owner);
    const browser = (await startRecording(owner, meetingId)).json() as RecordingSessionDTO;
    const browserTrackId = browser.tracks[0]!.id;
    const live = upload(owner, browserTrackId);
    await waitFor(() => (live.messages.some((m) => m.type === "ack") ? true : undefined));

    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${owner.organizationId}/meetings/${meetingId}/bot-sessions`,
      headers: { cookie: owner.cookie },
      payload: { meetingUrl: "https://meet.google.com/abc-defg-hij", consent },
    });
    const bot = invite.json() as BotSessionDTO;
    await waitFor(async () => {
      const row = await prisma.recordingSession.findUniqueOrThrow({ where: { id: bot.id } });
      return row.botJoinStatus === "IN_CALL" ? true : undefined;
    });
    await waitFor(() => (chunkStore.sequencesFor(bot.recordingTrackId).length > 0 ? true : undefined));

    // A guest in the meeting's org (e.g. an attendee who objects) can stop everything.
    const guest = await colleague(owner, "GUEST");
    const revoke = await app.inject({
      method: "POST",
      url: `/organizations/${owner.organizationId}/meetings/${meetingId}/consents/revoke`,
      headers: { cookie: guest.cookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json() as RevokeConsentResponse).toEqual({
      revokedConsents: 2,
      stoppedBrowserSessions: 1,
      stoppedBotSessions: 1,
      botLeaveFailures: [],
    });

    expect((await live.closed).code).toBe(4003);
    expect(await prisma.recordingSession.findUniqueOrThrow({ where: { id: browser.id } })).toMatchObject({
      status: "CANCELED",
      failureReason: "Recording consent revoked",
    });
    expect((await prisma.recordingSession.findUniqueOrThrow({ where: { id: bot.id } })).botJoinStatus).toBe("LEFT");

    const botChunks = chunkStore.sequencesFor(bot.recordingTrackId).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(chunkStore.sequencesFor(bot.recordingTrackId).length).toBe(botChunks);
    expect(await closeCodeFor(owner, browserTrackId)).toBe(4009);

    const consents = await app.inject({
      method: "GET",
      url: `/organizations/${owner.organizationId}/meetings/${meetingId}/consents`,
      headers: { cookie: owner.cookie },
    });
    expect((consents.json() as Array<{ revokedAt: string | null }>).every((c) => c.revokedAt !== null)).toBe(true);
    const rows = await prisma.recordingConsent.findMany({ where: { meetingId } });
    expect(rows.every((c) => c.revokedByUserId === guest.userId)).toBe(true);
    const revokedAudit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: owner.organizationId, action: "CONSENT_REVOKED" },
    });
    expect(revokedAudit.userId).toBe(guest.userId);

    // Recording again needs a fresh attestation, which then works.
    expect((await startRecording(owner, meetingId)).statusCode).toBe(201);
  });

  it("keeps consent and recording controls inside the meeting's organization", async () => {
    const owner = await signup("rec-tenant-a");
    const outsider = await signup("rec-tenant-b");
    const meetingId = await createMeeting(owner);
    const session = (await startRecording(owner, meetingId)).json() as RecordingSessionDTO;

    const asOutsider = (method: "GET" | "POST", url: string) => app.inject({ method, url, headers: { cookie: outsider.cookie } });
    expect((await asOutsider("POST", `/organizations/${owner.organizationId}/meetings/${meetingId}/consents/revoke`)).statusCode).toBe(403);
    expect((await asOutsider("POST", `/organizations/${outsider.organizationId}/meetings/${meetingId}/consents/revoke`)).statusCode).toBe(404);
    expect((await asOutsider("GET", `/organizations/${outsider.organizationId}/meetings/${meetingId}/consents`)).statusCode).toBe(404);
    expect((await asOutsider("POST", `/organizations/${outsider.organizationId}/recording-sessions/${session.id}/stop`)).statusCode).toBe(404);
    expect((await startRecording({ ...outsider }, meetingId)).statusCode).toBe(404);

    expect(await prisma.recordingConsent.count({ where: { meetingId, revokedAt: null } })).toBe(1);
    expect((await prisma.recordingSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("RECORDING");
  });
});
