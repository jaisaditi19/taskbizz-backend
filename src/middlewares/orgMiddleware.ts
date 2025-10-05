// src/middlewares/orgMiddleware.ts
import { RequestHandler } from "express";
import { getOrgPrisma } from "../di/container";

export const orgMiddleware: RequestHandler = async (req, _res, next) => {
  try {
    // Prefer orgId from authenticated user. Only fall back to header if present.
    const orgId =
      (req.user as any)?.orgId || (req.headers["x-org-id"] as string);

    if (!orgId) {
      // no org context for this request — that's fine for public routes
      return next();
    }

    // If another middleware already resolved it, reuse
    if ((req as any).orgPrisma) {
      console.debug("[orgMiddleware] req.orgPrisma already present, reusing");
      return next();
    }

    // Resolve via DI factory (LRU). This will reuse cached client if present.
    const client = await getOrgPrisma(orgId);
    (req as any).orgPrisma = client;
    return next();
  } catch (err) {
    // If org lookup fails, surface a 503 so caller knows it's a service problem
    console.error("orgMiddleware error:", err);
    return next(err);
  }
};
