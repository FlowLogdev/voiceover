import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AskExcerpt, LlmProvider } from "@voiceover/ai";
import { forOrganization, prisma, Prisma } from "@voiceover/database";
import { askRequestSchema, type AskResponse } from "@voiceover/types";
import { httpError } from "../http-error.js";
import { requireAuth, requireOrganization } from "../plugins/auth-context.js";

const orgParams = z.object({ organizationId: z.string().uuid() });

/** Common words that would match nearly every segment (EN / ES / PT). */
const STOPWORDS = new Set(
  (
    "the and for are was were what when where which who why how did does do this that with from have has had about into our your their they them " +
    "you she him her its can could would should will shall been being not but all any some there then than also just only very " +
    "que los las del por para con una uno unos unas como cuando donde quien cual pero esta este esto eso son fue ser hay sobre entre sus nos " +
    "não nao para com uma um uns umas como quando onde quem qual mas esta este isso essa esse são sao foi ser tem há sobre entre seus nós nos pelo pela dos das"
  ).split(" "),
);

/**
 * Turns a free-text question into an OR-of-prefixes tsquery for Postgres
 * full-text search ("simple" config: no language-specific stemming, since
 * meetings mix EN/ES/PT). Tokens are letters/digits only, so the result is
 * always valid tsquery syntax. Null if nothing searchable remains.
 */
export function buildSearchQuery(question: string): string | null {
  const tokens = (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => (t.length >= 3 || /^\p{N}{2,}$/u.test(t)) && !STOPWORDS.has(t),
  );
  const unique = [...new Set(tokens)].slice(0, 12);
  return unique.length > 0 ? unique.map((t) => `${t}:*`).join(" | ") : null;
}

/** Fixed-window per-user limit: every question is a paid model call. Single process, like TranscriptBus. */
export class AskRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60 * 60_000,
  ) {}
  /** Records a hit; false if the user is over the limit. */
  allow(userId: string, now = Date.now()): boolean {
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }
}

/** A single meeting this short is sent whole: keyword retrieval can miss questions like "what was decided?". */
const WHOLE_MEETING_MAX_SEGMENTS = 400;
const MAX_EXCERPTS = 30;

interface ExcerptRow {
  id: string;
  meetingId: string;
  startMs: number;
  text: string;
  speaker: string;
  title: string;
  meetingDate: Date | null;
}

/**
 * "Ask VoiceOver": answers questions from the organization's own meeting
 * transcripts, with citations. Retrieval is Postgres full-text search for
 * now. Semantic (embedding) search is blocked on choosing an embeddings
 * provider. Only meetings of the caller's organization are ever searched.
 */
export async function askRoutes(fastify: FastifyInstance, options: { llm: LlmProvider; rateLimiter?: AskRateLimiter }) {
  const limiter = options.rateLimiter ?? new AskRateLimiter();

  fastify.post("/organizations/:organizationId/ask", async (request) => {
    const auth = requireAuth(request);
    const { organizationId } = orgParams.parse(request.params);
    requireOrganization(auth, organizationId);
    const { question, meetingId } = askRequestSchema.parse(request.body);

    if (meetingId) {
      const meeting = await forOrganization(organizationId).meeting.findFirst({
        where: { id: meetingId, deletedAt: null },
        select: { id: true },
      });
      if (!meeting) throw httpError(404, "Meeting not found");
    }

    const rows = await retrieve(organizationId, question, meetingId);
    if (rows.length === 0) {
      const empty: AskResponse = {
        answer: "",
        insufficientEvidence: true,
        citations: [],
        model: null,
        retrievedExcerpts: 0,
      };
      return empty;
    }
    if (!limiter.allow(auth.userId)) throw httpError(429, "Too many questions in the last hour; try again later");

    const excerpts: AskExcerpt[] = rows.map((row, i) => ({
      ref: `E${i + 1}`,
      segmentId: row.id,
      meetingId: row.meetingId,
      meetingTitle: row.title,
      meetingDate: row.meetingDate ? row.meetingDate.toISOString().slice(0, 10) : null,
      startMs: row.startMs,
      speaker: row.speaker,
      text: row.text,
    }));
    let answer;
    try {
      answer = await options.llm.answerQuestion({ question, excerpts });
    } catch (error) {
      request.log.error(error, "Ask VoiceOver: LLM call failed");
      throw httpError(502, error instanceof Error ? error.message : "The language model call failed");
    }
    const response: AskResponse = {
      answer: answer.result.answer,
      insufficientEvidence: answer.result.insufficientEvidence,
      citations: answer.result.citations.map((c) => ({
        meetingId: c.meetingId,
        meetingTitle: c.meetingTitle,
        segmentId: c.segmentId,
        startMs: c.startMs,
        speaker: c.speaker,
        text: c.text,
      })),
      model: answer.model,
      retrievedExcerpts: excerpts.length,
    };
    return response;
  });
}

async function retrieve(organizationId: string, question: string, meetingId: string | undefined): Promise<ExcerptRow[]> {
  const select = Prisma.sql`
    SELECT ts.id, ts."meetingId", ts."startMs", ts.text,
           COALESCE(sp."displayName", sp.label, 'Unknown speaker') AS speaker,
           m.title, COALESCE(m."startedAt", m."createdAt") AS "meetingDate"
    FROM transcript_segments ts
    JOIN meetings m ON m.id = ts."meetingId"
    LEFT JOIN speakers sp ON sp.id = ts."speakerId"`;
  const scope = Prisma.sql`m."organizationId" = ${organizationId} AND m."deletedAt" IS NULL AND ts."isFinal" = true`;

  if (meetingId) {
    const count = await prisma.transcriptSegment.count({ where: { meetingId, isFinal: true } });
    if (count <= WHOLE_MEETING_MAX_SEGMENTS) {
      return prisma.$queryRaw<ExcerptRow[]>`${select} WHERE ${scope} AND m.id = ${meetingId} ORDER BY ts."startMs", ts."createdAt"`;
    }
  }
  const tsquery = buildSearchQuery(question);
  if (!tsquery) return [];
  const meetingFilter = meetingId ? Prisma.sql`AND m.id = ${meetingId}` : Prisma.empty;
  const hits = await prisma.$queryRaw<ExcerptRow[]>`
    ${select}, to_tsquery('simple', ${tsquery}) q
    WHERE ${scope} ${meetingFilter} AND to_tsvector('simple', ts.text) @@ q
    ORDER BY ts_rank(to_tsvector('simple', ts.text), q) DESC, ts."startMs"
    LIMIT ${MAX_EXCERPTS}`;
  // Present in reading order: by meeting date, then position in the meeting.
  return hits.sort(
    (a, b) => (a.meetingDate?.getTime() ?? 0) - (b.meetingDate?.getTime() ?? 0) || a.meetingId.localeCompare(b.meetingId) || a.startMs - b.startMs,
  );
}
