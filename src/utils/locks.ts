// src/utils/locks.ts
import redisClient from "./redisClient";

/**
 * Acquire a simple lock: SET key token PX ttl NX
 * Returns token string if acquired, otherwise null.
 */
export async function acquireLock(
  key: string,
  ttl = 2 * 60 * 1000
): Promise<string | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const ok = await redisClient.set(key, token, "PX", ttl, "NX");
  return ok === "OK" ? token : null;
}

/**
 * Release the lock only if token matches (safe release via Lua).
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await redisClient.eval(lua, 1, key, token);
  } catch (e) {
    // best-effort; ignore
  }
}
