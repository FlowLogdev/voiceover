import { describe, expect, it } from "vitest";
import { TrackAssemblyError } from "@voiceover/audio";
import { InvalidStorageKeyError } from "@voiceover/storage";
import { isPermanent, PermanentFinalizationError, retryDelayMs } from "./finalizer.js";

describe("finalization retry policy", () => {
  it("backs off exponentially from the base delay and caps it", () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt, 30_000, 100_000))).toEqual([30_000, 60_000, 100_000, 100_000]);
  });

  it("retries transient errors but not corrupt or unusable data", () => {
    expect(isPermanent(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isPermanent(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))).toBe(false);
    expect(isPermanent(new TrackAssemblyError("mixed sample rates"))).toBe(true);
    expect(isPermanent(new InvalidStorageKeyError("../x"))).toBe(true);
    expect(isPermanent(new PermanentFinalizationError("checksum"))).toBe(true);
  });
});
