"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCorePrisma = registerCorePrisma;
exports.getCorePrisma = getCorePrisma;
exports.registerOrgPrismaFactory = registerOrgPrismaFactory;
exports.getOrgPrisma = getOrgPrisma;
exports.invalidateOrgMeta = invalidateOrgMeta;
exports.getRegisteredOrgFactory = getRegisteredOrgFactory;
const container = {
    _orgFactory: null,
};
function registerCorePrisma(p) {
    container.corePrisma = p;
}
function getCorePrisma() {
    if (!container.corePrisma)
        throw new Error("Core Prisma not registered");
    return container.corePrisma;
}
/**
 * Register either:
 *  - a function (orgId => Promise<OrgPrismaClient>) OR
 *  - the full factory object returned by createOrgPrismaFactory()
 *
 * The implementation accepts both shapes and normalizes into container.getOrgPrisma + invalidateOrgMeta.
 */
function registerOrgPrismaFactory(factory) {
    if (!factory)
        throw new Error("Org factory is required");
    if (typeof factory === "function") {
        // function form
        container.getOrgPrisma = factory;
        container.invalidateOrgMeta = undefined;
        container._orgFactory = null;
    }
    else {
        // object form
        // defensive binding in case methods are not bound
        container.getOrgPrisma = factory.getOrgPrismaClient.bind(factory);
        container.invalidateOrgMeta = factory.invalidateOrgMeta
            ? factory.invalidateOrgMeta.bind(factory)
            : undefined;
        container._orgFactory = factory;
    }
}
function getOrgPrisma(orgId) {
    if (!container.getOrgPrisma)
        throw new Error("Org Prisma factory not registered");
    return container.getOrgPrisma(orgId);
}
/**
 * Invalidate cached org metadata / evict client for an org.
 * Throws if not available.
 */
async function invalidateOrgMeta(orgId) {
    if (!container.invalidateOrgMeta)
        throw new Error("invalidateOrgMeta not available. Register a full org factory to enable it.");
    // ensure we await if the registered fn returns a promise
    await container.invalidateOrgMeta(orgId);
}
/** Optional: expose the underlying org factory (for diagnostics) */
function getRegisteredOrgFactory() {
    return container._orgFactory ?? null;
}
