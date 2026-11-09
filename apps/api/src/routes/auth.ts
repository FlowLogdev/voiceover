import type { FastifyInstance } from "fastify";
import { signupRequestSchema, loginRequestSchema, type SessionResponse } from "@voiceover/types";
import { hashPassword, verifyPassword, issueSessionToken, SESSION_COOKIE_NAME } from "@voiceover/auth";
import { prisma } from "@voiceover/database";
import { env } from "../env.js";
import { requireAuth } from "../plugins/auth-context.js";

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base.length > 0 ? base : "org";
}

async function uniqueSlug(desired: string): Promise<string> {
  let candidate = desired;
  let suffix = 1;
  // Small orgs count — a loop here is fine and avoids a bespoke SQL uniqueness query.
  while (await prisma.organization.findUnique({ where: { slug: candidate } })) {
    suffix += 1;
    candidate = `${desired}-${suffix}`;
  }
  return candidate;
}

const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/signup", async (request, reply) => {
    const body = signupRequestSchema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return reply.status(409).send({ error: "An account with that email already exists" });
    }

    const passwordHash = await hashPassword(body.password);
    const slug = await uniqueSlug(slugify(body.organizationName));

    const { user, organization } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: body.email, name: body.name, passwordHash },
      });
      const organization = await tx.organization.create({
        data: {
          name: body.organizationName,
          slug,
          subscription: { create: { tier: "FREE", browserMinutesQuota: 150, botMinutesQuota: 0 } },
          memberships: { create: { userId: user.id, role: "OWNER" } },
        },
      });
      return { user, organization };
    });

    const token = await issueSessionToken(
      { userId: user.id, activeOrganizationId: organization.id },
      env.SESSION_SECRET,
    );
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });

    return reply.status(201).send({ userId: user.id, organizationId: organization.id });
  });

  fastify.post("/auth/login", async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { memberships: { select: { organizationId: true }, take: 1 } },
    });
    if (!user || !user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const token = await issueSessionToken(
      { userId: user.id, activeOrganizationId: user.memberships[0]?.organizationId ?? null },
      env.SESSION_SECRET,
    );
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });

    return reply.send({ userId: user.id });
  });

  fastify.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.status(204).send();
  });

  fastify.get("/auth/session", async (request, reply) => {
    const auth = requireAuth(request);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { id: true, email: true, name: true },
    });
    const memberships = await prisma.membership.findMany({
      where: { userId: auth.userId },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    });

    const response: SessionResponse = {
      user,
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
      activeOrganizationId: auth.activeOrganizationId,
    };
    return reply.send(response);
  });
}
