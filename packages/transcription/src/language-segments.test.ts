import { describe, expect, it } from "vitest";
import { mergeLanguageSegments } from "./language-segments.js";

describe("mergeLanguageSegments", () => {
  it("merges same-language segments across short pauses and splits on a language change", () => {
    expect(
      mergeLanguageSegments([
        { startMs: 6_000, endMs: 8_000, languageCode: "es" },
        { startMs: 0, endMs: 1_000, languageCode: "en" },
        { startMs: 2_000, endMs: 4_000, languageCode: "en" },
        { startMs: 8_500, endMs: 9_000, languageCode: "es" },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 4_000, languageCode: "en" },
      { startMs: 6_000, endMs: 9_000, languageCode: "es" },
    ]);
  });

  it("does not bridge a long silence, and handles empty input", () => {
    expect(
      mergeLanguageSegments([
        { startMs: 0, endMs: 1_000, languageCode: "pt" },
        { startMs: 60_000, endMs: 61_000, languageCode: "pt" },
      ]),
    ).toHaveLength(2);
    expect(mergeLanguageSegments([])).toEqual([]);
  });
});
