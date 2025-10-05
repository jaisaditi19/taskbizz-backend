// src/middlewares/featureGates.ts
import type { RequestHandler } from "express";
import type { FeatureKey } from "../shared/subscription";
import { hasFeature } from "../utils/subscription";

/**
 * Blocks access when the feature flag is not enabled in the plan.
 * Returns 403 with an upgrade hint.
 */
export const requireFeature =
  (key: FeatureKey): RequestHandler =>
  (req, res, next) => {
    if (!req.subscriptionCtx)
      return res.status(401).json({ code: "NO_SUBSCRIPTION_CTX" });
    if (!hasFeature(req, key)) {
      return res.status(403).json({
        code: "FEATURE_NOT_IN_PLAN",
        feature: key,
        upgrade: true,
      });
    }
    next();
  };

/**
 * Soft guard for handlers/services where you just *prefer*
 * the feature but can fallback. Use to branch logic:
 *   if (!ensureFeature(req, 'reports')) return res.status(403)...
 */
export const ensureFeature = (req: any, key: FeatureKey) =>
  hasFeature(req, key);

/**
 * Detects whether this request is attempting "document operations":
 * - Uploading files via multer (req.files)
 * - Removing attachments via attachmentsToRemove (stringified JSON or array)
 */
function hasDocOps(req: any): boolean {
  const hasUploads = Array.isArray(req.files) && req.files.length > 0;

  let hasRemovals = false;
  const raw = req.body?.attachmentsToRemove;
  if (typeof raw === "string" && raw.trim().length) {
    try {
      const parsed = JSON.parse(raw);
      hasRemovals = Array.isArray(parsed) && parsed.length > 0;
    } catch {
      // ignore malformed JSON -> treat as no removals
    }
  } else if (Array.isArray(raw) && raw.length > 0) {
    hasRemovals = true;
  }

  return hasUploads || hasRemovals;
}

/**
 * Conditional gate for document management:
 * - If the request DOES NOT perform doc ops → allow.
 * - If it DOES perform doc ops → require documentManagement feature.
 *
 * Place this AFTER multer (so req.files is populated) and BEFORE any S3/DB work.
 */
export const requireDocsFeatureIfDocOps: RequestHandler = (req, res, next) => {
  if (!hasDocOps(req)) return next();

  if (!req.subscriptionCtx)
    return res.status(401).json({ code: "NO_SUBSCRIPTION_CTX" });

  const enabled = hasFeature(req, "documentManagement");
  if (!enabled) {
    return res.status(403).json({
      code: "FEATURE_NOT_IN_PLAN",
      feature: "documentManagement",
      message: "Attachments are not available on your plan.",
      upgrade: true,
    });
  }
  next();
};
