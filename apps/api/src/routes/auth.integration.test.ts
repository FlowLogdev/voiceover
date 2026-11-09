/**
 * Integration tests against a real Postgres instance (DATABASE_URL). Requires
 * `docker compose up -d postgres` locally (see README) or the `postgres` service
 * configured in .github/workflows/ci.yml, plus `pnpm db:migrate` applied first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { prisma } from "@voiceover/database";

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("Expected a Set-Cookie header");
  return raw.split(";")[0]!;
}

describe("auth + tenant isolation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("signs up a user, creates an organization, and returns a session", async () => {
    const email = `signup-${Date.now()}@example.test`;
    const signupResponse = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email,
        password: "a-long-enough-password",
        name: "Test User",
        organizationName: "Test Org",
      },
    });
    expect(signupResponse.statusCode).toBe(201);
    const cookie = extractCookie(signupResponse.headers["set-cookie"]);

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    expect(sessionResponse.statusCode).toBe(200);
    const session = sessionResponse.json();
    expect(session.user.email).toBe(email);
    expect(session.organizations).toHaveLength(1);
    expect(session.organizations[0].role).toBe("OWNER");
  });

  it("rejects login with the wrong password", async () => {
    const email = `wrongpass-${Date.now()}@example.test`;
    await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "correct-password-1", name: "User", organizationName: "Org" },
    });

    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong-password" },
    });
    expect(loginResponse.statusCode).toBe(401);
  });

  it("prevents a member of org A from reading org B's meetings", async () => {
    const userAEmail = `usera-${Date.now()}@example.test`;
    const userBEmail = `userb-${Date.now()}@example.test`;

    const signupA = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: userAEmail, password: "password-aaaaaaaa", name: "A", organizationName: "Org A" },
    });
    const cookieA = extractCookie(signupA.headers["set-cookie"]);
    const { organizationId: orgAId } = signupA.json();

    const signupB = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: userBEmail, password: "password-bbbbbbbb", name: "B", organizationName: "Org B" },
    });
    const cookieB = extractCookie(signupB.headers["set-cookie"]);
    const { organizationId: orgBId } = signupB.json();

    // User A creates a meeting in org A.
    await app.inject({
      method: "POST",
      url: `/organizations/${orgAId}/meetings`,
      headers: { cookie: cookieA },
      payload: { title: "Org A private meeting" },
    });

    // User B must not be able to list org A's meetings.
    const crossTenantRead = await app.inject({
      method: "GET",
      url: `/organizations/${orgAId}/meetings`,
      headers: { cookie: cookieB },
    });
    expect(crossTenantRead.statusCode).toBe(403);

    // User B's own (empty) org list is unaffected.
    const ownRead = await app.inject({
      method: "GET",
      url: `/organizations/${orgBId}/meetings`,
      headers: { cookie: cookieB },
    });
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json()).toHaveLength(0);
  });
});
