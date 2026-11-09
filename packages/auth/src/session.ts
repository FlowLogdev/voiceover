import { SignJWT, jwtVerify } from "jose";

export interface SessionClaims {
  userId: string;
  activeOrganizationId: string | null;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecretKey(secret: string) {
  return new TextEncoder().encode(secret);
}

export async function issueSessionToken(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey(secret));
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, getSecretKey(secret));
  if (typeof payload.userId !== "string") {
    throw new Error("Invalid session token: missing userId");
  }
  return {
    userId: payload.userId,
    activeOrganizationId:
      typeof payload.activeOrganizationId === "string" ? payload.activeOrganizationId : null,
  };
}

export const SESSION_COOKIE_NAME = "voiceover_session";
