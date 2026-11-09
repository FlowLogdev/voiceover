import type {
  LoginRequest,
  SignupRequest,
  SessionResponse,
  CreateMeetingRequest,
  MeetingSummaryDTO,
} from "@voiceover/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
    headers: { "Content-Type": "application/json", ...init?.headers },
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
};
