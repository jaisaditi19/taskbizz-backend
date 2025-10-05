// src/utils/cache.ts
import redisClient from "../config/redisClient";

/**
 * Export the connected redis client as `redis` so other modules can import it.
 */
export const redis = redisClient;

/**
 * Generic JSON helpers (namespace-safe)
 */
export async function cacheGetJson<T = any>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (e) {
    console.warn("cacheGetJson failed", key, e);
    return null;
  }
}

export async function cacheSetJson<T = unknown>(
  key: string,
  value: T,
  ttlSeconds = 60
): Promise<void> {
  try {
    const payload = JSON.stringify(value);
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      await redis.set(key, payload, { EX: ttlSeconds });
    } else {
      await redis.set(key, payload);
    }
  } catch (e) {
    console.warn("cacheSetJson failed", key, e);
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (e) {
    console.warn("cacheDel failed", key, e);
  }
}

/**
 * Delete keys by pattern using SCAN iterator (safe for production).
 *
 * Notes:
 * - Uses redis.scanIterator({ MATCH, COUNT }) which is the node-redis v4 async iterator.
 * - Deletes in batches using a MULTI pipeline and UNLINK (non-blocking).
 * - Filters falsy keys and avoids calling DEL/UNLINK with no args (server error).
 * - `pattern` should be a glob-style pattern like "occurrences:orgId:*".
 */
export async function cacheDelByPattern(pattern: string): Promise<void> {
  try {
    const batchSize = 100;
    let batch: string[] = [];

    for await (const key of redis.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      // Ensure we only collect valid string keys
      if (!key) continue;
      batch.push(String(key));

      if (batch.length >= batchSize) {
        // Delete current batch via pipeline
        await deleteBatch(batch);
        batch = [];
      }
    }

    // final batch
    if (batch.length > 0) {
      await deleteBatch(batch);
    }
  } catch (e) {
    console.warn("cacheDelByPattern failed", pattern, e);
  }
}

/**
 * Helper to delete a batch of keys using MULTI + UNLINK.
 * UNLINK is non-blocking on the server side (preferred for large deletions).
 * This function guards against empty arrays and logs per-batch errors.
 */
async function deleteBatch(keys: string[]): Promise<void> {
  // filter falsy just in case
  const cleaned = keys.filter(Boolean);
  if (cleaned.length === 0) return;

  try {
    // Use MULTI/EXEC pipeline to send multiple UNLINK commands as separate args.
    const multi = redis.multi();
    for (const k of cleaned) multi.unlink(k);
    // Execute pipeline
    await multi.exec();
  } catch (err) {
    // If UNLINK isn't supported on the server (very old redis), fallback to DEL per key
    try {
      const multi = redis.multi();
      for (const k of cleaned) multi.del(k);
      await multi.exec();
    } catch (err2) {
      console.warn("deleteBatch failed", err2);
    }
  }
}

/**
 * Namespaced key helper: orgKey(orgId, scope, suffix)
 * Example: orgKey("org_1","occurrences","start=...:end=...")
 */
export function orgKey(orgId: string, scope: string, rest = "") {
  // keep '*' if caller includes it for patterns — just remove spaces
  const sanitized = String(rest || "").replace(/\s+/g, "");
  return `${scope}:${orgId}:${sanitized}`;
}
