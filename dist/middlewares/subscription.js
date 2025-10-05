"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enforceSeatLimit = exports.requireWriteAccess = exports.requireActiveSubscription = exports.attachSubscriptionContext = void 0;
const container_1 = require("../di/container");
const subscription_1 = require("../shared/subscription");
const DEFAULT_FEATURES = {
    features: {
        tasks: true,
        clients: true,
        recurringTasks: false,
        emailIntegration: false,
        reports: false,
        addExtraUsers: false,
        whatsappIntegration: false,
        documentManagement: false,
        documentMailSend: false,
        clientPortal: false,
        activityLogs: false,
    },
    limits: { minUsers: 1 },
};
function normalizeFeatures(raw, isTrial) {
    const parsed = subscription_1.FeaturesSchema.safeParse(raw);
    const base = parsed.success ? parsed.data : DEFAULT_FEATURES;
    return {
        ...base,
        features: {
            ...base.features,
            // trial override: disallow top-ups
            addExtraUsers: isTrial ? false : base.features.addExtraUsers,
        },
        limits: {
            ...base.limits,
            minUsers: Math.max(1, base.limits.minUsers ?? 1),
        },
    };
}
const attachSubscriptionContext = async (req, _res, next) => {
    try {
        const orgId = req.user?.orgId;
        if (!orgId)
            return next();
        const prisma = await (0, container_1.getCorePrisma)();
        const sub = await prisma.subscription.findFirst({
            where: { orgId },
            orderBy: { startDate: "desc" },
            include: { plan: true },
        });
        if (!sub)
            return next();
        const plan = sub.plan;
        if (!plan) {
            console.warn("attachSubscriptionContext: subscription has no attached plan", {
                subId: sub.id,
                orgId,
            });
            return next();
        }
        const now = new Date();
        // SIMPLIFIED: only two states
        // - "full" when subscription still active (now <= endDate)
        // - "view-only" when subscription expired (now > endDate)
        const access = now <= sub.endDate ? "full" : "view-only";
        const planFeatures = normalizeFeatures(plan.features, sub.isTrial);
        const minUsers = planFeatures.limits.minUsers;
        const licensed = sub.isTrial ? minUsers : sub.userCount ?? minUsers;
        const used = await prisma.user.count({
            where: { orgId, status: { not: "SUSPENDED" } },
        });
        const ctx = {
            access,
            isTrial: sub.isTrial,
            plan: {
                id: plan.id, // ← use plan.id (non-null)
                name: plan.name,
                features: planFeatures,
                highlighted: plan.highlighted,
                badge: plan.badge,
                minUsers: plan.minUsers,
                description: plan.description,
            },
            seats: { licensed, used, remaining: Math.max(licensed - used, 0) },
            cycle: {
                start: sub.startDate,
                end: sub.endDate,
                billingCycle: sub.billingCycle ?? null,
            },
            status: sub.status,
            // keep graceUntil for messaging / analytics even if not used for access
            graceUntil: sub.graceUntil ?? null,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
        };
        req.subscriptionCtx = ctx; // ← now typed
        next();
    }
    catch (e) {
        console.error("attachSubscriptionContext error:", e);
        next();
    }
};
exports.attachSubscriptionContext = attachSubscriptionContext;
/**
 * Server-side guard to block write/mutation endpoints unless subscription is full.
 * Use on all create/update/delete/invite/top-up routes.
 *
 * keep for backward compatibility (existing routes that import this)
 */
const requireActiveSubscription = (req, res, next) => {
    const ctx = req.subscriptionCtx;
    if (ctx && ctx.access !== "full") {
        return res.status(403).json({
            code: "WRITE_DISABLED_BY_SUBSCRIPTION",
            message: "Subscription expired: write actions are disabled.",
            access: ctx.access,
        });
    }
    next();
};
exports.requireActiveSubscription = requireActiveSubscription;
/**
 * Alias with more explicit name — use this on mutation routes.
 */
exports.requireWriteAccess = exports.requireActiveSubscription;
const enforceSeatLimit = (req, res, next) => {
    const ctx = req.subscriptionCtx;
    if (!ctx)
        return next();
    const licensed = ctx.isTrial
        ? ctx.plan.features.limits.minUsers
        : ctx.seats.licensed;
    if (ctx.seats.used >= licensed) {
        return res.status(409).json({
            code: "SEAT_LIMIT_REACHED",
            isTrial: ctx.isTrial,
            licensed,
            used: ctx.seats.used,
        });
    }
    next();
};
exports.enforceSeatLimit = enforceSeatLimit;
