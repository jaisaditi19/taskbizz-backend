// src/utils/cacheInvalidate.ts
import { redis } from "./cache";
import { cacheDelByPattern, orgKey } from "./cache";

const PUBSUB_CHANNEL_PREFIX = "cache:invalidate:org";

/**
 * Invalidate common per-org caches and publish a message so other instances can react.
 * This is fire-and-forget (not awaited by caller).
 */
export async function invalidateOrgCaches(orgId: string) {
  try {
    // Delete dashboard and occurrences and lists for the org
    await Promise.all([
      cacheDelByPattern(orgKey(orgId, "dashboard", "*")),
      cacheDelByPattern(orgKey(orgId, "occurrences", "*")),
      cacheDelByPattern(orgKey(orgId, "projects", "*")),
      cacheDelByPattern(orgKey(orgId, "clients", "*")),
      cacheDelByPattern(orgKey(orgId, "s3url", "*")),
    ]);
    // publish pubsub so other instances may also clear local in-memory caches
    try {
      await redis.publish(
        `${PUBSUB_CHANNEL_PREFIX}:${orgId}`,
        JSON.stringify({ type: "invalidate_all" })
      );
    } catch (e) {
      console.warn("invalidateOrgCaches publish failed", e);
    }
  } catch (e) {
    console.warn("invalidateOrgCaches failed", e);
  }
}
