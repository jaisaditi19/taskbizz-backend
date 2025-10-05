"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDailyRepeatJob = createDailyRepeatJob;
// src/jobs/scheduler.ts
const ioredis_1 = __importDefault(require("ioredis"));
const bullmq_1 = require("bullmq");
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
    throw new Error("REDIS_URL env var is required");
}
// create a redis client instance and pass it to BullMQ
const redisClient = new ioredis_1.default(REDIS_URL);
// NOTE: depending on your bullmq version, the types for `repeat.cron` may be missing.
// We cast the repeat options to `any` to avoid a TS error while keeping runtime cron behavior.
async function createDailyRepeatJob() {
    const q = new bullmq_1.Queue("daily-enqueue", { connection: redisClient });
    await q.add("enqueue-today-emails", {}, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        repeat: { cron: "0 10 * * *" },
        removeOnComplete: true,
        removeOnFail: false,
    });
    console.log("Scheduled repeatable job: daily-enqueue @ 10:00 server time");
}
// run once when executed directly
if (require.main === module) {
    createDailyRepeatJob()
        .then(() => {
        console.log("Scheduler created — exiting");
        // make sure redis connection is closed so process can exit
        return redisClient.quit();
    })
        .catch((err) => {
        console.error("Failed to create scheduler:", err);
        return redisClient.quit().then(() => process.exit(1));
    });
}
