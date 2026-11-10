import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __voiceoverPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__voiceoverPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__voiceoverPrisma = prisma;
}

const OPERATIONS_WITH_WHERE = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

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
          // `create`/`createMany` take no `where` — Prisma rejects an unknown
          // argument there, so injecting one would break every tenant-scoped
          // insert. Callers must set `organizationId` in `data` (it's a
          // required column, so the type system already enforces that).
          if (tenantScopedModels.has(model) && OPERATIONS_WITH_WHERE.has(operation)) {
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
