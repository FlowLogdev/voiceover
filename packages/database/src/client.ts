import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __voiceoverPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__voiceoverPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__voiceoverPrisma = prisma;
}

/**
 * Tenant-scoped accessor. Every call site that reads/writes organization-scoped
 * tables must go through this instead of the raw `prisma` client, so a missing
 * `where: { organizationId }` clause can't leak data across tenants by accident.
 */
export function forOrganization(organizationId: string) {
  if (!organizationId) {
    throw new Error("forOrganization() requires a non-empty organizationId");
  }
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const tenantScopedModels = new Set([
            "Meeting",
            "Workspace",
            "Integration",
            "Subscription",
            "UsageRecord",
            "ProviderCost",
            "AuditLog",
            "Share",
            "Membership",
          ]);
          if (tenantScopedModels.has(model)) {
            const a = args as { where?: Record<string, unknown> };
            a.where = { ...(a.where ?? {}), organizationId };
          }
          return query(args);
        },
      },
    },
  });
}

export type TenantScopedClient = ReturnType<typeof forOrganization>;
