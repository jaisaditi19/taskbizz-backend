// src/jobs/subscriptionExpiryCron.ts

import cron from "node-cron";
import { DateTime } from "luxon";
import { getCorePrisma } from "../di/container";

const SUBSCRIPTION_EXPIRY_TIMEZONE = "Asia/Kolkata";

export async function expireSubscriptions() {
  const core = getCorePrisma();

  const startOfToday = DateTime.now()
    .setZone(SUBSCRIPTION_EXPIRY_TIMEZONE)
    .startOf("day")
    .toUTC()
    .toJSDate();

  console.log(
    `[Subscription Expiry] Checking subscriptions before ${startOfToday.toISOString()}`,
  );

  const result = await core.subscription.updateMany({
    where: {
      status: "ACTIVE",
      endDate: {
        lt: startOfToday,
      },
    },

    data: {
      status: "INACTIVE",
    },
  });

  console.log(
    `[Subscription Expiry] ${result.count} subscription(s) marked as INACTIVE.`,
  );

  return result.count;
}

export const subscriptionExpiryCron = cron.schedule(
  "0 0 * * *",
  async () => {
    console.log(
      "[Subscription Expiry] Starting midnight subscription expiry job...",
    );

    try {
      await expireSubscriptions();

      console.log("[Subscription Expiry] Job completed successfully.");
    } catch (error) {
      console.error("[Subscription Expiry] Job failed:", error);
    }
  },
  {
    timezone: SUBSCRIPTION_EXPIRY_TIMEZONE,
  },
);

export function startSubscriptionExpiryCron() {
  console.log("Subscription Expiry Cron started — every day at 12:00 AM IST.");

  subscriptionExpiryCron.start();
}

export function stopSubscriptionExpiryCron() {
  console.log("Stopping Subscription Expiry Cron...");

  subscriptionExpiryCron.stop();
}
