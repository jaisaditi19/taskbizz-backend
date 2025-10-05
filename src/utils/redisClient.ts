// src/utils/redisClient.ts
import IORedis from "ioredis";

/**
 * Create a shared ioredis client for BullMQ.
 *
 * IMPORTANT: BullMQ requires `maxRetriesPerRequest: null`.
 * See: https://docs.bullmq.io/ (and the runtime error you saw)
 */

const REDIS = process.env.REDIS_URL;
if (!REDIS) {
  throw new Error("REDIS_URL env required");
}

/**
 * If you use a Redis URL like "redis://:pass@host:6379/0", ioredis will parse it.
 * We pass the recommended options for BullMQ:
 *  - maxRetriesPerRequest: null  (prevent blocking command retry behavior)
 *  - enableReadyCheck: true (default); you can set to false for some cluster setups
 *
 * Add other options (tls, sentinel config) here if needed for your infra.
 */
export const redisClient = new IORedis(REDIS, {
  maxRetriesPerRequest: null,
  // optional: set connectionName for visibility in Redis
  connectionName: "taskbizz-bullmq",
  // you may tweak the following based on environment; left commented:
  // enableReadyCheck: false,
  // lazyConnect: false,
});

export const bullConnection: any = { connection: redisClient };

export default redisClient;
