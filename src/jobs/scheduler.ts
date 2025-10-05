// src/jobs/scheduler.ts
import IORedis from "ioredis";
import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error("REDIS_URL env var is required");
}

// create a redis client instance and pass it to BullMQ
const redisClient = new IORedis(REDIS_URL);

// NOTE: depending on your bullmq version, the types for `repeat.cron` may be missing.
// We cast the repeat options to `any` to avoid a TS error while keeping runtime cron behavior.
export async function createDailyRepeatJob() {
  const q = new Queue("daily-enqueue", { connection: redisClient });

  await q.add(
    "enqueue-today-emails",
    {},
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repeat: { cron: "0 10 * * *" } as any,
      removeOnComplete: true,
      removeOnFail: false,
    }
  );

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
