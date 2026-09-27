"use strict";
// src/jobs/subscriptionExpiryCron.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscriptionExpiryCron = void 0;
exports.expireSubscriptions = expireSubscriptions;
exports.startSubscriptionExpiryCron = startSubscriptionExpiryCron;
exports.stopSubscriptionExpiryCron = stopSubscriptionExpiryCron;
const node_cron_1 = __importDefault(require("node-cron"));
const luxon_1 = require("luxon");
const container_1 = require("../di/container");
const SUBSCRIPTION_EXPIRY_TIMEZONE = "Asia/Kolkata";
async function expireSubscriptions() {
    const core = (0, container_1.getCorePrisma)();
    const startOfToday = luxon_1.DateTime.now()
        .setZone(SUBSCRIPTION_EXPIRY_TIMEZONE)
        .startOf("day")
        .toUTC()
        .toJSDate();
    console.log(`[Subscription Expiry] Checking subscriptions before ${startOfToday.toISOString()}`);
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
    console.log(`[Subscription Expiry] ${result.count} subscription(s) marked as INACTIVE.`);
    return result.count;
}
exports.subscriptionExpiryCron = node_cron_1.default.schedule("0 0 * * *", async () => {
    console.log("[Subscription Expiry] Starting midnight subscription expiry job...");
    try {
        await expireSubscriptions();
        console.log("[Subscription Expiry] Job completed successfully.");
    }
    catch (error) {
        console.error("[Subscription Expiry] Job failed:", error);
    }
}, {
    timezone: SUBSCRIPTION_EXPIRY_TIMEZONE,
});
function startSubscriptionExpiryCron() {
    console.log("Subscription Expiry Cron started — every day at 12:00 AM IST.");
    exports.subscriptionExpiryCron.start();
}
function stopSubscriptionExpiryCron() {
    console.log("Stopping Subscription Expiry Cron...");
    exports.subscriptionExpiryCron.stop();
}
