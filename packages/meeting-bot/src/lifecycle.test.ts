import { describe, expect, it } from "vitest";
import { canTransition, isTerminalBotStatus } from "./lifecycle.js";
import { AdmissionRetryPolicy } from "./retry-policy.js";

describe("bot lifecycle transitions", () => {
  it("allows the normal forward path", () => {
    expect(canTransition("SCHEDULED", "JOINING")).toBe(true);
    expect(canTransition("JOINING", "WAITING_ROOM")).toBe(true);
    expect(canTransition("WAITING_ROOM", "IN_CALL")).toBe(true);
    expect(canTransition("IN_CALL", "LEFT")).toBe(true);
  });

  it("never regresses an in-call bot or leaves a terminal status", () => {
    expect(canTransition("IN_CALL", "WAITING_ROOM")).toBe(false);
    expect(canTransition("IN_CALL", "JOINING")).toBe(false);
    expect(canTransition("IN_CALL", "SCHEDULED")).toBe(false);
    for (const terminal of ["LEFT", "FAILED", "ADMISSION_REJECTED"] as const) {
      expect(isTerminalBotStatus(terminal)).toBe(true);
      expect(canTransition(terminal, "JOINING")).toBe(false);
      expect(canTransition(terminal, "SCHEDULED")).toBe(false);
    }
  });

  it("allows a pre-join bot to be rescheduled for a retry", () => {
    expect(canTransition("JOINING", "SCHEDULED")).toBe(true);
    expect(canTransition("WAITING_ROOM", "SCHEDULED")).toBe(true);
  });
});

describe("AdmissionRetryPolicy", () => {
  it("backs off exponentially and caps the delay", () => {
    const policy = new AdmissionRetryPolicy({ maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 3_000 });
    expect(policy.delayBeforeNextAttemptMs(1)).toBe(1_000);
    expect(policy.delayBeforeNextAttemptMs(2)).toBe(2_000);
    expect(policy.delayBeforeNextAttemptMs(3)).toBe(3_000);
    expect(policy.delayBeforeNextAttemptMs(4)).toBe(3_000);
  });

  it("counts the first attempt towards maxAttempts", () => {
    const policy = new AdmissionRetryPolicy({ maxAttempts: 2 });
    expect(policy.shouldRetry(1)).toBe(true);
    expect(policy.shouldRetry(2)).toBe(false);
    expect(new AdmissionRetryPolicy({ maxAttempts: 0 }).shouldRetry(1)).toBe(false);
  });
});
