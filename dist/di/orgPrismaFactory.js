"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrgPrismaFactory = createOrgPrismaFactory;
// src/di/orgPrismaFactory.ts
const lru_cache_1 = require("lru-cache");
const dbUrl_1 = require("../utils/dbUrl");
function createOrgPrismaFactory(corePrisma) {
    const maxClients = Number(process.env.ORG_PRISMA_CACHE_MAX || 50); // tune
    const ttlMs = Number(process.env.ORG_PRISMA_CACHE_TTL_MS || 1000 * 60 * 60); // 1h default
    // small in-memory cache for org metadata so we don't hit core DB every request
    const orgMetaCache = new Map();
    const cache = new lru_cache_1.LRUCache({
        max: maxClients,
        ttl: ttlMs,
        // dispose triggers on eviction; signature is (value, key)
        dispose: (client, orgId) => {
            client.$disconnect().catch((err) => {
                console.error(`Error disconnecting org prisma for ${orgId}`, err);
            });
        },
    });
    // Map to deduplicate concurrent client creations per orgId
    const inFlight = new Map();
    async function getOrgPrismaClient(orgId) {
        if (!orgId)
            throw new Error("orgId is required");
        // 1) fast path: cached client
        const cachedClient = cache.get(orgId);
        if (cachedClient) {
            return cachedClient;
        }
        // 2) if a creation is already in-flight for this orgId, await it
        const pending = inFlight.get(orgId);
        if (pending) {
            return pending;
        }
        // 3) create and store the promise in inFlight so other callers await it
        const creationPromise = (async () => {
            try {
                // Try to load dbName from metadata cache first
                let dbName = orgMetaCache.get(orgId)?.dbName;
                if (!dbName) {
                    const org = (await corePrisma.organization.findUnique({
                        where: { id: orgId },
                        select: { dbName: true },
                    }));
                    if (!org || !org.dbName) {
                        throw new Error(`Organization ${orgId} not found or dbName missing`);
                    }
                    dbName = org.dbName;
                    orgMetaCache.set(orgId, { dbName });
                    console.info(`[org-factory] loaded metadata for org=${orgId} db=${dbName}`);
                }
                else {
                    console.debug(`[org-factory] org metadata cache hit for org=${orgId}`);
                }
                const url = (0, dbUrl_1.getOrgDbUrl)(dbName);
                const mod = (await Promise.resolve().then(() => __importStar(require("../../prisma/generated/org-client"))));
                const ClientCtor = mod.PrismaClient;
                const client = new ClientCtor({
                    datasources: { db: { url } },
                });
                // Connect and then set in cache
                console.log(`[DEBUG] Attempting to connect to database for org ${orgId}...`);
                console.time(`org-connect-${orgId}`); // Start a timer
                await client.$connect();
                console.timeEnd(`org-connect-${orgId}`); // End the timer
                console.log(`[DEBUG] Successfully connected to database for org ${orgId}.`);
                console.info(`[org-factory] created org client for org=${orgId} db=${dbName}`);
                // It's possible another request created and set a client while we awaited $connect.
                // To be safe, check cache again: if no entry, set ours; otherwise disconnect ours and return cached.
                const existingAfterConnect = cache.get(orgId);
                if (existingAfterConnect) {
                    // Evict the client we just created because someone else already set one.
                    // This avoids having multiple live pools for the same org.
                    try {
                        await client.$disconnect();
                        console.info(`[org-factory] another client already existed for org=${orgId}; disconnected duplicate`);
                    }
                    catch (e) {
                        console.error(`[org-factory] error disconnecting duplicate client for org=${orgId}`, e);
                    }
                    return existingAfterConnect;
                }
                cache.set(orgId, client);
                return client;
            }
            finally {
                // remove the in-flight marker regardless of success or failure so retries work
                inFlight.delete(orgId);
            }
        })();
        inFlight.set(orgId, creationPromise);
        return creationPromise;
    }
    async function disconnectAll() {
        const keys = Array.from(cache.keys()); // convert generator -> array
        await Promise.all(keys.map(async (k) => {
            const c = cache.get(k);
            if (c) {
                try {
                    await c.$disconnect();
                }
                catch (e) {
                    console.error("Error disconnecting org client", k, e);
                }
                cache.delete(k);
            }
        }));
    }
    async function invalidateOrgMeta(orgId) {
        orgMetaCache.delete(orgId);
        if (cache.has(orgId)) {
            const cl = cache.get(orgId);
            cache.delete(orgId);
            if (cl) {
                try {
                    await cl.$disconnect();
                    console.info(`[org-factory] evicted and disconnected client for org=${orgId}`);
                }
                catch (e) {
                    console.error("Error disconnecting evicted client during invalidateOrgMeta", orgId, e);
                }
            }
        }
    }
    return {
        getOrgPrismaClient,
        disconnectAll,
        invalidateOrgMeta,
        _cache: cache, // exported for diagnostics if needed
    };
}
