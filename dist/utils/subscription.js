"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LimitError = exports.getLimit = exports.hasFeature = void 0;
exports.enforceMax = enforceMax;
const hasFeature = (req, key) => !!req.subscriptionCtx?.plan.features.features[key];
exports.hasFeature = hasFeature;
const getLimit = (req, key) => req.subscriptionCtx?.plan.features.limits[key];
exports.getLimit = getLimit;
class LimitError extends Error {
    constructor(detail) {
        super("Limit reached");
        this.detail = detail;
    }
}
exports.LimitError = LimitError;
/**
 * Generic "max" enforcer for future numeric limits you may add
 * (e.g., maxClients, maxStorageMb, reportsMonthly, etc.)
 */
async function enforceMax(req, key, currentCountFn) {
    const max = (0, exports.getLimit)(req, key);
    if (typeof max !== "number")
        return;
    const count = await currentCountFn();
    if (count >= max)
        throw new LimitError({ key, limit: max });
}
