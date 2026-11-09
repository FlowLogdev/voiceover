import { describe, expect, it } from "vitest";
import { assertAtLeastRole, ForbiddenError, hasAtLeastRole } from "./rbac";

describe("rbac", () => {
  it("allows a higher role to satisfy a lower requirement", () => {
    expect(hasAtLeastRole("OWNER", "MEMBER")).toBe(true);
  });

  it("denies a lower role for a higher requirement", () => {
    expect(hasAtLeastRole("GUEST", "ADMIN")).toBe(false);
  });

  it("throws ForbiddenError when assertion fails", () => {
    expect(() => assertAtLeastRole("MEMBER", "OWNER")).toThrow(ForbiddenError);
  });

  it("does not throw when assertion passes", () => {
    expect(() => assertAtLeastRole("ADMIN", "ADMIN")).not.toThrow();
  });
});
