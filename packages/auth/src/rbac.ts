export type Role = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";

const ROLE_RANK: Record<Role, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
  GUEST: 0,
};

/** Returns true if `role` has at least the permission level of `required`. */
export function hasAtLeastRole(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function assertAtLeastRole(role: Role, required: Role): void {
  if (!hasAtLeastRole(role, required)) {
    throw new ForbiddenError(`Requires role ${required} or higher, got ${role}`);
  }
}
