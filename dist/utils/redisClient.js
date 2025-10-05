"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bullConnection = exports.redisClient = void 0;
// src/utils/redisClient.ts
const ioredis_1 = __importDefault(require("ioredis"));
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
exports.redisClient = new ioredis_1.default(REDIS, {
    maxRetriesPerRequest: null,
    // optional: set connectionName for visibility in Redis
    connectionName: "taskbizz-bullmq",
    // you may tweak the following based on environment; left commented:
    // enableReadyCheck: false,
    // lazyConnect: false,
});
exports.bullConnection = { connection: exports.redisClient };
exports.default = exports.redisClient;
