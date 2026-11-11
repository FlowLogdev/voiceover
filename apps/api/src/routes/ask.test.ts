import { describe, expect, it } from "vitest";
import { AskRateLimiter, buildSearchQuery } from "./ask.js";

describe("buildSearchQuery", () => {
  it("keeps meaningful words as OR'd prefix terms, dropping stopwords in EN/ES/PT", () => {
    expect(buildSearchQuery("When did we decide on the launch date?")).toBe("decide:* | launch:* | date:*");
    expect(buildSearchQuery("¿Cuándo vamos a lanzar el producto?")).toBe("cuándo:* | vamos:* | lanzar:* | producto:*");
    expect(buildSearchQuery("Quem é o responsável pelo orçamento?")).toBe("responsável:* | orçamento:*");
  });

  it("keeps 2+ digit numbers, dedupes, and returns null when nothing searchable is left", () => {
    expect(buildSearchQuery("Q3 budget 2026 budget")).toBe("budget:* | 2026:*");
    expect(buildSearchQuery("what is it?")).toBeNull();
  });

  it("never lets tsquery syntax through", () => {
    const query = buildSearchQuery("budget') | !secret & <-> :* ''; DROP TABLE meetings;--")!;
    expect(query).toBe("budget:* | secret:* | drop:* | table:* | meetings:*");
    expect(query.replace(/[\p{L}\p{N}]+:\*/gu, "").replace(/ \| /g, "")).toBe("");
  });
});

describe("AskRateLimiter", () => {
  it("allows up to the limit per user per window", () => {
    const limiter = new AskRateLimiter(2, 1_000);
    expect([limiter.allow("a", 0), limiter.allow("a", 10), limiter.allow("a", 20)]).toEqual([true, true, false]);
    expect(limiter.allow("b", 20)).toBe(true); // per user
    expect(limiter.allow("a", 1_001)).toBe(true); // window slid past the first hit
  });
});
