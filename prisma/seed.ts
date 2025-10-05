// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const starterFeatures = {
  features: {
    tasks: true,
    clients: true,
    recurringTasks: true,
    emailIntegration: true,
    reports: true,
    addExtraUsers: true, // trial mode will override this to disallow top-ups
    whatsappIntegration: false,
    documentManagement: false,
    documentMailSend: false,
    clientPortal: false,
    activityLogs: false,
    chat: false,
  },
  limits: { minUsers: 3 },
};

const premiumFeatures = {
  ...starterFeatures,
  features: {
    ...starterFeatures.features,
    whatsappIntegration: true,
    documentManagement: true,
    documentMailSend: true,
    clientPortal: true,
    activityLogs: true,
    chat: true
  },
};

async function main() {
  // Upsert Starter
  const starter = await prisma.plan.upsert({
    where: { name: "Starter" },
    update: {
      features: starterFeatures,
      highlighted: false,
      badge: null,
      minUsers: 3,
      description: "Best suited for early-stage teams.",
    },
    create: {
      name: "Starter",
      features: starterFeatures,
      highlighted: false,
      minUsers: 3,
      description: "Best suited for early-stage teams.",
    },
  });

  // Upsert Premium
  const premium = await prisma.plan.upsert({
    where: { name: "Premium Plan" },
    update: {
      features: premiumFeatures,
      highlighted: true,
      badge: "Coming Soon",
      minUsers: 3,
      description:
        "For larger teams needing advanced features and integrations.",
    },
    create: {
      name: "Premium Plan",
      features: premiumFeatures,
      highlighted: true,
      badge: "Coming Soon",
      minUsers: 3,
      description:
        "For larger teams needing advanced features and integrations.",
    },
  });

  // PlanPrice upserts (per user / period). Prices in INR (whole units).
  const prices = [
    {
      planId: starter.id,
      period: "QUARTERLY",
      price: 3 * 249,
      originalPrice: 3 * 249,
      priceLabel: "Per user / quarter",
    },
    {
      planId: starter.id,
      period: "YEARLY",
      price: 12 * 249,
      originalPrice: 12 * 249,
      priceLabel: "Per user / year",
    },
    {
      planId: premium.id,
      period: "QUARTERLY",
      price: 3 * 649,
      originalPrice: 3 * 649,
      priceLabel: "Per user / quarter",
    },
    {
      planId: premium.id,
      period: "YEARLY",
      price: 12 * 649,
      originalPrice: 12 * 649,
      priceLabel: "Per user / year",
    },
  ];

  for (const p of prices) {
    await prisma.planPrice.upsert({
      where: { planId_period: { planId: p.planId, period: p.period as any } },
      update: {
        price: p.price,
        originalPrice: p.originalPrice,
        priceLabel: p.priceLabel,
      },
      create: {
        planId: p.planId,
        period: p.period as any,
        price: p.price,
        originalPrice: p.originalPrice,
        priceLabel: p.priceLabel,
      },
    });
  }
}

main()
  .then(async () => {
    console.log("✅ Seed complete");
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Seed failed", e);
    await prisma.$disconnect();
    process.exit(1);
  });
