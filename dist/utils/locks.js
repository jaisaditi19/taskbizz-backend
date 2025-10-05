"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireLock = acquireLock;
exports.releaseLock = releaseLock;
// src/utils/locks.ts
const redisClient_1 = __importDefault(require("./redisClient"));
/**
 * Acquire a simple lock: SET key token PX ttl NX
 * Returns token string if acquired, otherwise null.
 */
async function acquireLock(key, ttl = 2 * 60 * 1000) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const ok = await redisClient_1.default.set(key, token, "PX", ttl, "NX");
    return ok === "OK" ? token : null;
}
/**
 * Release the lock only if token matches (safe release via Lua).
 */
async function releaseLock(key, token) {
    const lua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
    try {
        await redisClient_1.default.eval(lua, 1, key, token);
    }
    catch (e) {
        // best-effort; ignore
    }
}
