import { describe, expect, it } from "vitest";
import { issueSessionToken, verifySessionToken } from "./session";

const SECRET = "test-secret-at-least-this-long-for-hs256";

describe("session tokens", () => {
  it("round-trips claims through sign and verify", async () => {
    const token = await issueSessionToken(
      { userId: "user-1", activeOrganizationId: "org-1" },
      SECRET,
    );
    const claims = await verifySessionToken(token, SECRET);
    expect(claims).toEqual({ userId: "user-1", activeOrganizationId: "org-1" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await issueSessionToken({ userId: "user-1", activeOrganizationId: null }, SECRET);
    await expect(verifySessionToken(token, "a-completely-different-secret")).rejects.toThrow();
  });
});
