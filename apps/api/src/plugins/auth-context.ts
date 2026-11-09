import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@voiceover/auth";
import { prisma } from "@voiceover/database";
import { env } from "../env.js";

export interface AuthenticatedMembership {
  organizationId: string;
  organizationSlug: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
}

export interface AuthContext {
  userId: string;
  memberships: AuthenticatedMembership[];
  activeOrganizationId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

async function loadAuthContext(request: FastifyRequest): Promise<AuthContext | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  let claims;
  try {
    claims = await verifySessionToken(token, env.SESSION_SECRET);
  } catch {
    return null;
  }

  // A DB failure here must not 500 every request that merely carries a
  // session cookie, including routes (like the recording-audio WebSocket)
  // that never read `request.auth` at all. Fail closed — treat it as
  // unauthenticated, so routes that actually require auth correctly 401
  // instead of the request crashing with an opaque 500.
  let memberships;
  try {
    memberships = await prisma.membership.findMany({
      where: { userId: claims.userId },
      include: { organization: { select: { id: true, slug: true } } },
    });
  } catch (error) {
    request.log.error(error, "Failed to load memberships for auth context");
    return null;
  }

  return {
    userId: claims.userId,
    activeOrganizationId: claims.activeOrganizationId,
    memberships: memberships.map((m) => ({
      organizationId: m.organizationId,
      organizationSlug: m.organization.slug,
      role: m.role,
    })),
  };
}

export const authContextPlugin = fp(async function authContextPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest("auth", null);
  fastify.addHook("preHandler", async (request) => {
    request.auth = await loadAuthContext(request);
  });
});

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  }
  return request.auth;
}

export function requireOrganization(
  auth: AuthContext,
  organizationId: string,
): AuthenticatedMembership {
  const membership = auth.memberships.find((m) => m.organizationId === organizationId);
  if (!membership) {
    throw Object.assign(new Error("Not a member of this organization"), { statusCode: 403 });
  }
  return membership;
}
