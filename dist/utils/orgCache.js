"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheUserOrgPointer = cacheUserOrgPointer;
exports.getCachedUserOrgId = getCachedUserOrgId;
exports.getOrgSnapshot = getOrgSnapshot;
exports.primeOrgSnapshot = primeOrgSnapshot;
exports.invalidateOrgSnapshot = invalidateOrgSnapshot;
// src/utils/orgCache.ts
const redisClient_1 = __importDefault(require("../config/redisClient"));
const container_1 = require("../di/container");
const ORG_SNAPSHOT_TTL = 60 * 10; // 10 minutes
const USER_ORG_TTL = 60 * 60 * 24; // 24 hours
function orgKey(orgId) {
    return `org:snap:${orgId}`;
}
function userOrgKey(userId) {
    return `user:${userId}:org`;
}
async function cacheUserOrgPointer(userId, orgId) {
    if (!orgId) {
        await redisClient_1.default.del(userOrgKey(userId)).catch(() => { });
        return;
    }
    await redisClient_1.default.set(userOrgKey(userId), orgId, { EX: USER_ORG_TTL });
}
async function getCachedUserOrgId(userId) {
    try {
        const v = await redisClient_1.default.get(userOrgKey(userId));
        return v ?? null;
    }
    catch {
        return null;
    }
}
async function getOrgSnapshot(orgId) {
    // 1) Try cache
    try {
        const raw = await redisClient_1.default.get(orgKey(orgId));
        if (raw)
            return JSON.parse(raw);
    }
    catch {
        // ignore redis errors
    }
    // 2) Fallback DB (no `plan` select)
    const prisma = (0, container_1.getCorePrisma)();
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, logoUrl: true },
    });
    if (!org)
        return null;
    const snap = {
        id: org.id,
        name: org.name,
        logoUrl: org.logoUrl ?? null,
    };
    // 3) Write-through cache
    try {
        await redisClient_1.default.set(orgKey(orgId), JSON.stringify(snap), {
            EX: ORG_SNAPSHOT_TTL,
        });
    }
    catch {
        // ignore
    }
    return snap;
}
async function primeOrgSnapshot(orgId) {
    await getOrgSnapshot(orgId);
}
async function invalidateOrgSnapshot(orgId) {
    try {
        await redisClient_1.default.del(orgKey(orgId));
    }
    catch {
        // ignore
    }
}
