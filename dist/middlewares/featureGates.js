"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireDocsFeatureIfDocOps = exports.ensureFeature = exports.requireFeature = void 0;
const subscription_1 = require("../utils/subscription");
/**
 * Blocks access when the feature flag is not enabled in the plan.
 * Returns 403 with an upgrade hint.
 */
const requireFeature = (key) => (req, res, next) => {
    if (!req.subscriptionCtx)
        return res.status(401).json({ code: "NO_SUBSCRIPTION_CTX" });
    if (!(0, subscription_1.hasFeature)(req, key)) {
        return res.status(403).json({
            code: "FEATURE_NOT_IN_PLAN",
            feature: key,
            upgrade: true,
        });
    }
    next();
};
exports.requireFeature = requireFeature;
/**
 * Soft guard for handlers/services where you just *prefer*
 * the feature but can fallback. Use to branch logic:
 *   if (!ensureFeature(req, 'reports')) return res.status(403)...
 */
const ensureFeature = (req, key) => (0, subscription_1.hasFeature)(req, key);
exports.ensureFeature = ensureFeature;
/**
 * Detects whether this request is attempting "document operations":
 * - Uploading files via multer (req.files)
 * - Removing attachments via attachmentsToRemove (stringified JSON or array)
 */
function hasDocOps(req) {
    const hasUploads = Array.isArray(req.files) && req.files.length > 0;
    let hasRemovals = false;
    const raw = req.body?.attachmentsToRemove;
    if (typeof raw === "string" && raw.trim().length) {
        try {
            const parsed = JSON.parse(raw);
            hasRemovals = Array.isArray(parsed) && parsed.length > 0;
        }
        catch {
            // ignore malformed JSON -> treat as no removals
        }
    }
    else if (Array.isArray(raw) && raw.length > 0) {
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
const requireDocsFeatureIfDocOps = (req, res, next) => {
    if (!hasDocOps(req))
        return next();
    if (!req.subscriptionCtx)
        return res.status(401).json({ code: "NO_SUBSCRIPTION_CTX" });
    const enabled = (0, subscription_1.hasFeature)(req, "documentManagement");
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
exports.requireDocsFeatureIfDocOps = requireDocsFeatureIfDocOps;
