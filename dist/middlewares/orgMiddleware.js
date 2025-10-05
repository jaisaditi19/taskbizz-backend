"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orgMiddleware = void 0;
const container_1 = require("../di/container");
const orgMiddleware = async (req, _res, next) => {
    try {
        // Prefer orgId from authenticated user. Only fall back to header if present.
        const orgId = req.user?.orgId || req.headers["x-org-id"];
        if (!orgId) {
            // no org context for this request — that's fine for public routes
            return next();
        }
        // If another middleware already resolved it, reuse
        if (req.orgPrisma) {
            console.debug("[orgMiddleware] req.orgPrisma already present, reusing");
            return next();
        }
        // Resolve via DI factory (LRU). This will reuse cached client if present.
        const client = await (0, container_1.getOrgPrisma)(orgId);
        req.orgPrisma = client;
        return next();
    }
    catch (err) {
        // If org lookup fails, surface a 503 so caller knows it's a service problem
        console.error("orgMiddleware error:", err);
        return next(err);
    }
};
exports.orgMiddleware = orgMiddleware;
