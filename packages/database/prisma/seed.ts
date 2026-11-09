import { PrismaClient, MembershipRole, SubscriptionTier } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "demo-org" },
    update: {},
    create: {
      name: "Demo Organization",
      slug: "demo-org",
      subscription: {
        create: {
          tier: SubscriptionTier.FREE,
          browserMinutesQuota: 150,
          botMinutesQuota: 0,
        },
      },
    },
  });

  const user = await prisma.user.upsert({
    where: { email: "owner@demo-org.test" },
    update: {},
    create: {
      email: "owner@demo-org.test",
      name: "Demo Owner",
    },
  });

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: {},
    create: {
      organizationId: org.id,
      userId: user.id,
      role: MembershipRole.OWNER,
    },
  });

  console.log(`Seeded organization "${org.name}" (${org.id}) with owner ${user.email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
