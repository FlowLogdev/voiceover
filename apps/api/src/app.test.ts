import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("app (no database required)", () => {
  it("responds to the health check", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("returns 400 for an invalid signup payload before touching the database", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "not-an-email", password: "short", name: "", organizationName: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Validation error");
    await app.close();
  });

  it("requires authentication for /auth/session", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/auth/session" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requires authentication to invite or remove a meeting bot", async () => {
    const app = await buildApp();
    const orgId = "00000000-0000-4000-8000-000000000001";
    const invite = await app.inject({
      method: "POST",
      url: `/organizations/${orgId}/meetings/00000000-0000-4000-8000-000000000002/bot-sessions`,
      payload: { meetingUrl: "https://meet.google.com/abc-defg-hij" },
    });
    expect(invite.statusCode).toBe(401);
    const leave = await app.inject({
      method: "POST",
      url: `/organizations/${orgId}/bot-sessions/00000000-0000-4000-8000-000000000003/leave`,
    });
    expect(leave.statusCode).toBe(401);
    await app.close();
  });

  it("refuses to start with a meeting bot provider that has no adapter", async () => {
    process.env.MEETING_BOT_PROVIDER = "recall";
    try {
      await expect(buildApp()).rejects.toThrow('MEETING_BOT_PROVIDER="recall" has no adapter yet');
    } finally {
      delete process.env.MEETING_BOT_PROVIDER;
    }
  });
});
