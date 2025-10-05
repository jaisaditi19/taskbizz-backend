import type { Request, Response } from "express";
import { getCorePrisma } from "../di/container";

type Period = "QUARTERLY" | "YEARLY";

const addMonths = (d: Date, months: number) => {
  const x = new Date(d);
  const m = x.getMonth() + months;
  x.setMonth(m);
  if (x.getMonth() !== ((m % 12) + 12) % 12) x.setDate(0);
  return x;
};

// Place near top of file or in billing utils
type PromoApplyContext = {
  promoCode?: string | null;
  pay: any; // prisma payment row
  orgId: string;
  planId: string | null;
  seats: number;
  grossAmount: number; // currency total used to compute percent-based discounts
  prismaClient?: any;
  purpose?: "NEW_SUBSCRIPTION" | "SEAT_TOPUP" | "UPGRADE";
};

const applyPromoToPayment = async (ctx: PromoApplyContext) => {
  const db = ctx.prismaClient ?? getCorePrisma();
  const code = (ctx.promoCode || (ctx.pay?.meta as any)?.promoCode)
    ?.toString()
    ?.trim();
  if (!code) return null;

  // Load promo
  const promo = await db.promoCode.findUnique({ where: { code } });
  if (!promo) throw new Error("PROMO_NOT_FOUND");
  if (!promo.active) throw new Error("PROMO_INACTIVE");
  const now = new Date();
  if (promo.startsAt && promo.startsAt > now)
    throw new Error("PROMO_NOT_STARTED");
  if (promo.endsAt && promo.endsAt < now) throw new Error("PROMO_EXPIRED");
  if (promo.maxUses && promo.usedCount >= promo.maxUses)
    throw new Error("PROMO_MAX_USES_EXCEEDED");

  // Plan applicability
  // Plan applicability
  if (promo.applicablePlanIds) {
    // supports comma separated plan ids or JSON array string
    const str = promo.applicablePlanIds;
    let allowed: string[] = [];
    try {
      if (str.trim().startsWith("[")) allowed = JSON.parse(str);
      else
        allowed = str
          .split(",")
          .map((s: any) => s.trim())
          .filter(Boolean);
    } catch (e) {
      allowed = str
        .split(",")
        .map((s: any) => s.trim())
        .filter(Boolean);
    }
    // IMPORTANT: if allowed list present, require ctx.planId to be a non-empty string and included
    if (allowed.length > 0) {
      if (!ctx.planId || !allowed.includes(ctx.planId)) {
        throw new Error("PROMO_NOT_APPLICABLE_TO_PLAN");
      }
    }
  }

  // minSeats check
  if (promo.minSeats && ctx.seats < promo.minSeats) {
    throw new Error("PROMO_MIN_SEATS_NOT_MET");
  }

  // onePerOrg check -- simple approach: ensure there is no previous SUCCESS payment with this promo and same org
  if (promo.onePerOrg) {
    const prev = await db.payment.findFirst({
      where: {
        purpose: ctx.purpose,
        status: "SUCCESS",
        // payments may store orgId on meta or subscription - we try to match by subscription->org or meta.orgId
        OR: [
          { meta: { path: ["orgId"], equals: ctx.orgId } }, // if using Json filters (Prisma JSON path limits vary by adapter)
          // fallback: payments linked to subscriptions in the same org
          { subscription: { orgId: ctx.orgId } as any },
        ],
        meta: { path: ["promoCode"], equals: promo.code } as any,
      } as any,
    });
    if (prev) throw new Error("PROMO_ONE_PER_ORG_VIOLATION");
  }

  // Compute discount:
  let discountAmount = 0;
  if (promo.discountType === "PERCENT") {
    const pct = Math.max(0, Math.min(100, promo.discountValue));
    discountAmount = Math.round(ctx.grossAmount * (pct / 100) * 100) / 100;
  } else {
    // FIXED
    discountAmount = Math.round(Number(promo.discountValue) * 100) / 100;
    // never exceed gross
    if (discountAmount > ctx.grossAmount) discountAmount = ctx.grossAmount;
  }

  // Persist changes in a transaction:
  await db.$transaction(async (tx:any) => {
    // update payment.meta with discount info (idempotent)
    const existingMeta = (ctx.pay.meta as any) ?? {};
    const newMeta = {
      ...existingMeta,
      promoCode: promo.code,
      promoDiscountApplied: true,
      promoDiscountAmount: discountAmount,
      promoId: promo.id,
    };

    await tx.payment.update({
      where: { id: ctx.pay.id },
      data: { meta: newMeta },
    });

    // increment promo usedCount
    await tx.promoCode.update({
      where: { id: promo.id },
      data: { usedCount: { increment: 1 } },
    });

    // Optionally: insert a promo usage log table for audit (recommended)
    // await tx.promoUsage.create({ data: { promoCodeId: promo.id, orgId: ctx.orgId, paymentId: ctx.pay.id, amount: discountAmount } });
  });

  return {
    promoId: promo.id,
    promoCode: promo.code,
    discountAmount,
    promoType: promo.discountType,
  };
};


// GET /billing/subscription
// Mirrors attachSubscriptionContext payload placed on req
export const getSubscriptionCtx = async (req: any, res: Response) => {
  return res.json(req.subscriptionCtx ?? null);
};

/**
 * POST /billing/convert
 * Body: { paymentId: string, seats?: number, period?: "QUARTERLY" | "YEARLY" }
 * - Validates payment row (SUCCESS, NEW_SUBSCRIPTION, belongs to user).
 * - Uses body.seats/period if provided; falls back to payment.meta.
 * - Enforces seat minimums (plan.minUsers and >= currently used).
 * - Converts latest ACTIVE trial subscription on the org → paid in-place.
 * - Idempotent-ish: if trial not found but a paid ACTIVE exists, returns 409 with hint.
 */
export const convertTrialToPaid = async (req: any, res: Response) => {
  try {
    const prisma = getCorePrisma();
    const userId = req.user?.id as string | undefined;
    const orgId = req.user?.orgId as string | undefined;
    const {
      paymentId,
      seats: seatsFromBody,
      period: periodFromBody,
    } = req.body as {
      paymentId: string;
      seats?: number;
      period?: Period;
    };

    if (!userId || !orgId)
      return res.status(401).json({ message: "Unauthorized" });
    if (!paymentId)
      return res.status(400).json({ message: "PAYMENT_ID_REQUIRED" });

    // Find latest trial (regardless of status) and latest active paid subscription
    const [trialSub, activePaid] = await Promise.all([
      prisma.subscription.findFirst({
        where: { orgId, isTrial: true },
        orderBy: { startDate: "desc" },
      }),
      prisma.subscription.findFirst({
        where: { orgId, status: "ACTIVE", isTrial: false },
        orderBy: { startDate: "desc" },
      }),
    ]);

    // If there’s already a paid active subscription, prefer to return 409 (unchanged)
    if (!trialSub) {
      if (activePaid) {
        return res.status(409).json({
          message: "ALREADY_PAID",
          subscriptionId: activePaid.id,
          billingCycle: activePaid.billingCycle,
        });
      }
      return res.status(404).json({ message: "TRIAL_SUBSCRIPTION_NOT_FOUND" });
    }

    // Validate payment row
    const pay = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!pay) return res.status(404).json({ message: "PAYMENT_NOT_FOUND" });
    if (pay.userId && pay.userId !== userId)
      return res.status(403).json({ message: "PAYMENT_OWNERSHIP_MISMATCH" });
    if (pay.status !== "SUCCESS")
      return res.status(400).json({ message: "PAYMENT_NOT_SUCCESS" });
    if (pay.purpose !== "NEW_SUBSCRIPTION")
      return res.status(400).json({ message: "PAYMENT_WRONG_PURPOSE" });

    const meta = (pay.meta as any) ?? {};
    const metaPeriod = meta.period as Period | undefined;
    const metaPlanId = meta.planId as string | undefined;
    const metaSeats = Number(meta.seats ?? 0) || undefined;

    // Prefer body overrides (your UI sends them), fallback to meta
    const period: Period | undefined = periodFromBody ?? metaPeriod;
    const seatsFromPaymentOrBody = seatsFromBody ?? metaSeats;

    if (!period || !metaPlanId || !seatsFromPaymentOrBody) {
      return res.status(400).json({ message: "PAYMENT_META_INCOMPLETE" });
    }
    if (metaPlanId !== trialSub.planId) {
      return res.status(400).json({ message: "PLAN_MISMATCH" });
    }

    // Enforce seat minimums: plan.minUsers and >= currently active users in org
    const plan = await prisma.plan.findUnique({
      where: { id: trialSub.planId },
    });
    if (!plan) return res.status(400).json({ message: "INVALID_PLAN" });

    const planMin =
      plan.minUsers ?? (plan.features as any)?.limits?.minUsers ?? 1;

    const usedSeats = await prisma.user.count({
      where: { orgId, status: { not: "SUSPENDED" } as any },
    });

    const minSeatsRequired = Math.max(planMin, usedSeats);
    if (seatsFromPaymentOrBody < minSeatsRequired) {
      return res.status(400).json({
        message: "SEAT_MISMATCH",
        expected: minSeatsRequired,
        got: seatsFromPaymentOrBody,
      });
    }

    // Convert trial → paid on the same subscription row
    const now = new Date();
    const endDate =
      period === "YEARLY" ? addMonths(now, 12) : addMonths(now, 3);

    const updated = await prisma.subscription.update({
      where: { id: trialSub.id },
      data: {
        isTrial: false,
        billingCycle: period,
        userCount: seatsFromPaymentOrBody,
        startDate: now,
        endDate,
        status: "ACTIVE",
        cancelAtPeriodEnd: false,
        graceUntil: null,
      },
      include: { plan: true },
    });

    // Link payment → subscriptionId (idempotent-safe)
    if (!pay.subscriptionId) {
      await prisma.payment.update({
        where: { id: pay.id },
        data: { subscriptionId: updated.id },
      });
    }

    // --- Promo handling (body or payment.meta)
    let promoResult = null;
    try {
      const promoCodeFromBody = (req.body as any)?.promoCode as
        | string
        | undefined;
      const promoCode = promoCodeFromBody ?? (pay.meta as any)?.promoCode;
      if (promoCode) {
        // derive gross: prefer explicit pricePerSeat * seats, else fallback to pay.amount
        const metaP = (pay.meta as any) ?? {};
        const pricePerSeatDerived =
          Number(metaP.pricePerSeat ?? 0) ||
          (Number(pay.amount ?? 0) && seatsFromPaymentOrBody
            ? Math.round((Number(pay.amount) / seatsFromPaymentOrBody) * 100) /
              100
            : undefined);

        const gross =
          pricePerSeatDerived && seatsFromPaymentOrBody
            ? pricePerSeatDerived * seatsFromPaymentOrBody
            : Number(pay.amount ?? 0);

        promoResult = await applyPromoToPayment({
          promoCode,
          pay,
          orgId,
          planId: trialSub.planId ?? null,
          seats: seatsFromPaymentOrBody,
          grossAmount: gross,
        });
      }
    } catch (e: any) {
      // Convert known errors to client-friendly responses
      const msg = e && e.message ? e.message : "PROMO_APPLY_FAILED";
      console.warn("convertTrialToPaid: promo apply failed", msg);
      if (msg === "PROMO_NOT_FOUND")
        return res.status(400).json({ message: "PROMO_NOT_FOUND" });
      if (msg === "PROMO_EXPIRED")
        return res.status(400).json({ message: "PROMO_EXPIRED" });
      if (msg === "PROMO_MAX_USES_EXCEEDED")
        return res.status(400).json({ message: "PROMO_MAX_USES_EXCEEDED" });
      if (msg === "PROMO_MIN_SEATS_NOT_MET")
        return res.status(400).json({ message: "PROMO_MIN_SEATS_NOT_MET" });
      if (msg === "PROMO_NOT_APPLICABLE_TO_PLAN")
        return res
          .status(400)
          .json({ message: "PROMO_NOT_APPLICABLE_TO_PLAN" });
      if (msg === "PROMO_ONE_PER_ORG_VIOLATION")
        return res.status(400).json({ message: "PROMO_ALREADY_USED_BY_ORG" });
      // otherwise don't fail the subscription conversion on promo bookkeeping failure; just warn
      console.error("convertTrialToPaid: unknown promo error", e);
    }

    return res.json({
      message: "Subscription converted to paid",
      subscription: updated,
      promo: promoResult,
    });
  } catch (err) {
    console.error("convertTrialToPaid error:", err);
    return res.status(500).json({ message: "SERVER_ERROR" });
  }
};

// --- applySeatTopup (updated to record 20% discount for YEARLY billing if possible) ---
export const applySeatTopup = async (req: Request & { user?: any }, res: Response) => {
  try {
    const prisma = getCorePrisma();
    const userId = req.user?.id;
    const orgId = req.user?.orgId;
    const { paymentId } = req.body as { paymentId: string };

    if (!userId || !orgId)
      return res.status(401).json({ message: "Unauthorized" });
    if (!paymentId)
      return res.status(400).json({ message: "PAYMENT_ID_REQUIRED" });

    const pay = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!pay) return res.status(404).json({ message: "PAYMENT_NOT_FOUND" });

    if (pay.userId !== userId)
      return res.status(403).json({ message: "PAYMENT_OWNERSHIP_MISMATCH" });
    if (pay.status !== "SUCCESS")
      return res.status(400).json({ message: "PAYMENT_NOT_SUCCESS" });
    if (pay.purpose !== "SEAT_TOPUP")
      return res.status(400).json({ message: "PAYMENT_WRONG_PURPOSE" });

    const meta = (pay.meta as any) ?? {};
    const subId = meta.subscriptionId as string | undefined;
    const deltaSeats = Number(meta.deltaSeats || 0);
    const pricePerSeat = Number(meta.pricePerSeat ?? 0) || undefined; // optional, used to compute discount
    if (!subId || !deltaSeats || deltaSeats <= 0) {
      return res.status(400).json({ message: "PAYMENT_META_INCOMPLETE" });
    }

    const sub = await prisma.subscription.findUnique({ where: { id: subId } });
    if (!sub || sub.orgId !== orgId)
      return res.status(404).json({ message: "SUBSCRIPTION_NOT_FOUND" });
    if (sub.status !== "ACTIVE")
      return res.status(400).json({ message: "SUBSCRIPTION_NOT_ACTIVE" });

    // Compute discount if billing cycle is YEARLY and we have pricePerSeat
    let discountInfo = null;
    try {
      if (sub.billingCycle === "YEARLY" && pricePerSeat && pricePerSeat > 0) {
        const gross = pricePerSeat * deltaSeats;
        const discountAmount = Math.round(gross * 0.2 * 100) / 100; // 20% discount, 2 decimal places
        const newMeta = {
          ...((pay.meta as any) ?? {}),
          discountApplied: true,
          discountAmount,
        };
        await prisma.payment.update({
          where: { id: pay.id },
          data: { meta: newMeta },
        });
        discountInfo = { discountApplied: true, discountAmount };
      }
    } catch (e) {
      console.error("applySeatTopup: discount bookkeeping failed", e);
    }

    // --- Promo handling (body or payment.meta)
    let promoResult = null;
    try {
      const promoCodeFromBody = (req.body as any)?.promoCode as
        | string
        | undefined;
      const promoCode = promoCodeFromBody ?? (pay.meta as any)?.promoCode;
      if (promoCode) {
        // derive gross: prefer explicit pricePerSeat * deltaSeats, else fallback to pay.amount
        const metaP = (pay.meta as any) ?? {};
        const pricePerSeatDerived =
          Number(metaP.pricePerSeat ?? 0) ||
          (Number(pay.amount ?? 0) && deltaSeats
            ? Math.round((Number(pay.amount) / deltaSeats) * 100) / 100
            : undefined);

        const gross =
          pricePerSeatDerived && deltaSeats
            ? pricePerSeatDerived * deltaSeats
            : Number(pay.amount ?? 0);

        promoResult = await applyPromoToPayment({
          promoCode,
          pay,
          orgId,
          planId: sub.planId ?? null,
          seats: deltaSeats,
          grossAmount: gross,
          purpose: "SEAT_TOPUP",
        });
      }
    } catch (e: any) {
      const msg = e && e.message ? e.message : "PROMO_APPLY_FAILED";
      console.warn("applySeatTopup: promo apply failed", msg);
      if (msg === "PROMO_NOT_FOUND")
        return res.status(400).json({ message: "PROMO_NOT_FOUND" });
      if (msg === "PROMO_EXPIRED")
        return res.status(400).json({ message: "PROMO_EXPIRED" });
      if (msg === "PROMO_MAX_USES_EXCEEDED")
        return res.status(400).json({ message: "PROMO_MAX_USES_EXCEEDED" });
      if (msg === "PROMO_MIN_SEATS_NOT_MET")
        return res.status(400).json({ message: "PROMO_MIN_SEATS_NOT_MET" });
      if (msg === "PROMO_NOT_APPLICABLE_TO_PLAN")
        return res
          .status(400)
          .json({ message: "PROMO_NOT_APPLICABLE_TO_PLAN" });
      if (msg === "PROMO_ONE_PER_ORG_VIOLATION")
        return res.status(400).json({ message: "PROMO_ALREADY_USED_BY_ORG" });
      console.error("applySeatTopup: unknown promo error", e);
    }

    // Now update subscription seats
    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { userCount: (sub.userCount ?? 0) + deltaSeats },
      include: { plan: true },
    });

    // link payment -> subscription id as before
    if (!pay.subscriptionId) {
      await prisma.payment.update({
        where: { id: pay.id },
        data: { subscriptionId: updated.id },
      });
    }

    return res.json({
      message: "Seats updated",
      subscription: updated,
      deltaSeats,
      promo: promoResult,
    });

  } catch (err) {
    console.error("applySeatTopup error:", err);
    return res.status(500).json({ message: "SERVER_ERROR" });
  }
};


export const setCancelAtPeriodEnd = async (req: Request & { user?: any }, res: Response) => {
  try {
    const prisma = getCorePrisma();
    const userId = req.user?.id;
    const orgId = req.user?.orgId;
    const { cancelAtPeriodEnd } = req.body as { cancelAtPeriodEnd: boolean };

    if (!userId || !orgId) return res.status(401).json({ message: "Unauthorized" });
    if (typeof cancelAtPeriodEnd !== "boolean") {
      return res.status(400).json({ message: "cancelAtPeriodEnd boolean required" });
    }

    // Find latest ACTIVE paid subscription for this org
    const sub = await prisma.subscription.findFirst({
      where: { orgId, status: "ACTIVE", isTrial: false },
      orderBy: { startDate: "desc" },
    });

    if (!sub) {
      return res.status(404).json({ message: "ACTIVE_SUBSCRIPTION_NOT_FOUND" });
    }

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd },
      select: {
        id: true,
        cancelAtPeriodEnd: true,
        endDate: true,
        status: true,
        isTrial: true,
      },
    });

    return res.json({
      message: cancelAtPeriodEnd ? "Auto-renew turned OFF" : "Auto-renew turned ON",
      subscription: updated,
    });
  } catch (err) {
    console.error("setCancelAtPeriodEnd error:", err);
    return res.status(500).json({ message: "SERVER_ERROR" });
  }
};

// POST /billing/apply-plan-upgrade
// Body: { paymentId: string }
export const applyPlanUpgrade = async (req: Request & { user?: any }, res: Response) => {
  try {
    const prisma = getCorePrisma();
    const userId = req.user?.id;
    const orgId = req.user?.orgId;
    const { paymentId } = req.body as { paymentId: string };

    if (!userId || !orgId) return res.status(401).json({ message: "Unauthorized" });
    if (!paymentId) return res.status(400).json({ message: "PAYMENT_ID_REQUIRED" });

    // 1) Load and validate payment
    const pay = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!pay) return res.status(404).json({ message: "PAYMENT_NOT_FOUND" });
    if (pay.userId && pay.userId !== userId) {
      return res.status(403).json({ message: "PAYMENT_OWNERSHIP_MISMATCH" });
    }
    if (pay.purpose !== "UPGRADE") {
      return res.status(400).json({ message: "WRONG_PURPOSE" });
    }
    if (pay.status !== "SUCCESS") {
      return res.status(400).json({ message: "PAYMENT_NOT_SUCCESS" });
    }

    const meta = (pay.meta as any) ?? {};
    const fromPlanId = meta.fromPlanId as string | undefined;
    const toPlanId = meta.toPlanId as string | undefined;
    const subscriptionIdFromMeta = meta.subscriptionId as string | undefined;

    if (!toPlanId) return res.status(400).json({ message: "TO_PLAN_MISSING" });

    // 2) Find current active paid subscription (or use meta.subscriptionId)
    const sub = subscriptionIdFromMeta
      ? await prisma.subscription.findUnique({ where: { id: subscriptionIdFromMeta } })
      : await prisma.subscription.findFirst({
          where: { orgId, status: "ACTIVE", isTrial: false },
          orderBy: { startDate: "desc" },
        });

    if (!sub) return res.status(404).json({ message: "SUBSCRIPTION_NOT_FOUND" });
    if (sub.orgId !== orgId) return res.status(403).json({ message: "ORG_MISMATCH" });

    // (Optional safety) ensure the payment was for this plan switch
    if (fromPlanId && sub.planId && sub.planId !== fromPlanId) {
      // This could still be ok (if user upgraded twice quickly), but we warn/fail by default:
      return res.status(400).json({ message: "SUBSCRIPTION_PLAN_CHANGED_SINCE_PAYMENT" });
    }

    // 3) Flip the plan immediately; keep dates & billing cycle intact
    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        planId: toPlanId,
        isTrial: false,
        status: "ACTIVE",
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd, // unchanged
      },
      include: { plan: true },
    });

    // 4) Link payment to this subscription if not already
    if (!pay.subscriptionId) {
      await prisma.payment.update({
        where: { id: pay.id },
        data: { subscriptionId: updated.id },
      });
    }

    return res.json({
      message: "Plan upgraded successfully",
      subscription: updated,
    });
  } catch (err) {
    console.error("applyPlanUpgrade error:", err);
    return res.status(500).json({ message: "SERVER_ERROR" });
  }
};

export const getPlans = async (req: Request & { user?: any }, res: Response) => {
  try {
    const prisma = getCorePrisma();
    if (req.user.role !== "ADMIN") {
      return res
        .status(403)
        .json({ message: "Only admins can view all users" });
    }

    const plans = await prisma.plan.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        minUsers: true,
        features: true,
        prices: true
      },
    });

    return res.json(plans);
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}