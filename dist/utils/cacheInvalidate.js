"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateOrgCaches = invalidateOrgCaches;
// src/utils/cacheInvalidate.ts
const cache_1 = require("./cache");
const cache_2 = require("./cache");
const PUBSUB_CHANNEL_PREFIX = "cache:invalidate:org";
/**
 * Invalidate common per-org caches and publish a message so other instances can react.
 * This is fire-and-forget (not awaited by caller).
 */
async function invalidateOrgCaches(orgId) {
    try {
        // Delete dashboard and occurrences and lists for the org
        await Promise.all([
            (0, cache_2.cacheDelByPattern)((0, cache_2.orgKey)(orgId, "dashboard", "*")),
            (0, cache_2.cacheDelByPattern)((0, cache_2.orgKey)(orgId, "occurrences", "*")),
            (0, cache_2.cacheDelByPattern)((0, cache_2.orgKey)(orgId, "projects", "*")),
            (0, cache_2.cacheDelByPattern)((0, cache_2.orgKey)(orgId, "clients", "*")),
            (0, cache_2.cacheDelByPattern)((0, cache_2.orgKey)(orgId, "s3url", "*")),
        ]);
        // publish pubsub so other instances may also clear local in-memory caches
        try {
            await cache_1.redis.publish(`${PUBSUB_CHANNEL_PREFIX}:${orgId}`, JSON.stringify({ type: "invalidate_all" }));
        }
        catch (e) {
            console.warn("invalidateOrgCaches publish failed", e);
        }
    }
    catch (e) {
        console.warn("invalidateOrgCaches failed", e);
    }
}
