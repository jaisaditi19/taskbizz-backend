"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis_1 = require("redis");
const redisClient = (0, redis_1.createClient)({
    url: process.env.REDIS_URL || "redis://localhost:6379",
    socket: {
        connectTimeout: 10000, // optional: increase timeout
    },
});
redisClient.on("error", (err) => console.error("Redis Client Error", err));
(async () => {
    await redisClient.connect();
})();
exports.default = redisClient;
