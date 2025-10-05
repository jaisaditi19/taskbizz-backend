// src/middlewares/subscription.ts
import type { RequestHandler } from "express";
import { getCorePrisma } from "../di/container";
import {
  FeaturesSchema,
  type PlanFeaturesJSON,
  type SubscriptionCtx,
  type BillingCycle,
} from "../shared/subscription";

const DEFAULT_FEATURES: PlanFeaturesJSON = {
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

function normalizeFeatures(raw: unknown, isTrial: boolean): PlanFeaturesJSON {
  const parsed = FeaturesSchema.safeParse(raw);
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

export const attachSubscriptionContext: RequestHandler = async (
  req,
  _res,
  next
) => {
  try {
    const orgId = req.user?.orgId;
    if (!orgId) return next();

    const prisma = await getCorePrisma();

    const sub = await prisma.subscription.findFirst({
      where: { orgId },
      orderBy: { startDate: "desc" },
      include: { plan: true },
    });
    if (!sub) return next();

    const plan = sub.plan;
    if (!plan) {
      console.warn(
        "attachSubscriptionContext: subscription has no attached plan",
        {
          subId: sub.id,
          orgId,
        }
      );
      return next();
    }

    const now = new Date();

    // SIMPLIFIED: only two states
    // - "full" when subscription still active (now <= endDate)
    // - "view-only" when subscription expired (now > endDate)
    const access: SubscriptionCtx["access"] =
      now <= sub.endDate ? "full" : "view-only";

    const planFeatures = normalizeFeatures(plan.features, sub.isTrial);

    const minUsers = planFeatures.limits.minUsers;
    const licensed = sub.isTrial ? minUsers : sub.userCount ?? minUsers;

    const used = await prisma.user.count({
      where: { orgId, status: { not: "SUSPENDED" } as any },
    });

    const ctx: SubscriptionCtx = {
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
        billingCycle: (sub.billingCycle as BillingCycle) ?? null,
      },
      status: sub.status as string,
      // keep graceUntil for messaging / analytics even if not used for access
      graceUntil: sub.graceUntil ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
    };

    req.subscriptionCtx = ctx; // ← now typed
    next();
  } catch (e) {
    console.error("attachSubscriptionContext error:", e);
    next();
  }
};

/**
 * Server-side guard to block write/mutation endpoints unless subscription is full.
 * Use on all create/update/delete/invite/top-up routes.
 *
 * keep for backward compatibility (existing routes that import this)
 */
export const requireActiveSubscription: RequestHandler = (req, res, next) => {
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

/**
 * Alias with more explicit name — use this on mutation routes.
 */
export const requireWriteAccess: RequestHandler = requireActiveSubscription;

export const enforceSeatLimit: RequestHandler = (req, res, next) => {
  const ctx = req.subscriptionCtx;
  if (!ctx) return next();

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