import type {
  LoginRequest,
  SignupRequest,
  SessionResponse,
  CreateMeetingRequest,
  MeetingSummaryDTO,
  BotSessionDTO,
  CreateBotSessionRequest,
  CreateRecordingSessionRequest,
  RecordingConsentDTO,
  RecordingSessionDTO,
  RevokeConsentResponse,
  MeetingDetailDTO,
  MeetingTranscriptDTO,
  SpeakerDTO,
  MeetingInsightsDTO,
  InsightKind,
  UpdateInsightRequest,
  AskRequest,
  AskResponse,
} from "@voiceover/types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    // Only declare a JSON body when there is one: Fastify rejects an empty
    // body sent with Content-Type: application/json (400), which silently
    // broke bodyless POSTs like logout and bot leave.
    headers: { ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(response.status, body.error ?? "Request failed");
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const api = {
  signup: (body: SignupRequest) =>
    request<{ userId: string; organizationId: string }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  login: (body: LoginRequest) =>
    request<{ userId: string }>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  session: () => request<SessionResponse>("/auth/session"),
  listMeetings: (organizationId: string) =>
    request<MeetingSummaryDTO[]>(`/organizations/${organizationId}/meetings`),
  createMeeting: (organizationId: string, body: CreateMeetingRequest) =>
    request<{ id: string }>(`/organizations/${organizationId}/meetings`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listBotSessions: (organizationId: string, meetingId: string) =>
    request<BotSessionDTO[]>(`/organizations/${organizationId}/meetings/${meetingId}/bot-sessions`),
  inviteBot: (organizationId: string, meetingId: string, body: CreateBotSessionRequest) =>
    request<BotSessionDTO>(`/organizations/${organizationId}/meetings/${meetingId}/bot-sessions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeBot: (organizationId: string, sessionId: string) =>
    request<BotSessionDTO>(`/organizations/${organizationId}/bot-sessions/${sessionId}/leave`, {
      method: "POST",
    }),
  startRecording: (organizationId: string, meetingId: string, body: CreateRecordingSessionRequest) =>
    request<RecordingSessionDTO>(`/organizations/${organizationId}/meetings/${meetingId}/recording-sessions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  stopRecording: (organizationId: string, sessionId: string) =>
    request<RecordingSessionDTO>(`/organizations/${organizationId}/recording-sessions/${sessionId}/stop`, {
      method: "POST",
    }),
  listConsents: (organizationId: string, meetingId: string) =>
    request<RecordingConsentDTO[]>(`/organizations/${organizationId}/meetings/${meetingId}/consents`),
  getMeeting: (organizationId: string, meetingId: string) =>
    request<MeetingDetailDTO>(`/organizations/${organizationId}/meetings/${meetingId}`),
  getTranscript: (organizationId: string, meetingId: string) =>
    request<MeetingTranscriptDTO>(`/organizations/${organizationId}/meetings/${meetingId}/transcript`),
  renameSpeaker: (organizationId: string, meetingId: string, speakerId: string, displayName: string | null) =>
    request<SpeakerDTO>(`/organizations/${organizationId}/meetings/${meetingId}/speakers/${speakerId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),
  /** Same-site cookie auth: usable directly as an <audio> src. */
  playbackUrl: (organizationId: string, recordingTrackId: string) =>
    `${API_URL}/organizations/${organizationId}/recording-tracks/${recordingTrackId}/playback`,
  getInsights: (organizationId: string, meetingId: string) =>
    request<MeetingInsightsDTO>(`/organizations/${organizationId}/meetings/${meetingId}/insights`),
  regenerateAnalysis: (organizationId: string, meetingId: string) =>
    request<{ runId: string }>(`/organizations/${organizationId}/meetings/${meetingId}/analysis`, { method: "POST" }),
  updateInsight: (organizationId: string, meetingId: string, kind: InsightKind, itemId: string, body: UpdateInsightRequest) =>
    request<{ ok: true }>(`/organizations/${organizationId}/meetings/${meetingId}/insights/${kind}/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteInsight: (organizationId: string, meetingId: string, kind: InsightKind, itemId: string) =>
    request<void>(`/organizations/${organizationId}/meetings/${meetingId}/insights/${kind}/${itemId}`, { method: "DELETE" }),
  updateSummary: (organizationId: string, meetingId: string, content: string) =>
    request<{ ok: true }>(`/organizations/${organizationId}/meetings/${meetingId}/summary`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),
  ask: (organizationId: string, body: AskRequest) =>
    request<AskResponse>(`/organizations/${organizationId}/ask`, { method: "POST", body: JSON.stringify(body) }),
  revokeConsent: (organizationId: string, meetingId: string) =>
    request<RevokeConsentResponse>(`/organizations/${organizationId}/meetings/${meetingId}/consents/revoke`, {
      method: "POST",
    }),
};
