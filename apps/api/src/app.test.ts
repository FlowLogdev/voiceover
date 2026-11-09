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
});
