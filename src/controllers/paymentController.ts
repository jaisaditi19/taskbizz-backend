import type { Request, Response } from "express";
import crypto from "crypto";
import { razorpay } from "../config/razorpay";
import { getCorePrisma } from "../di/container";
import type { PaymentPurpose, PaymentStatus } from "@prisma/client";

type BillingCycle = "quarterly" | "yearly";
type Period = "QUARTERLY" | "YEARLY";
type Purpose = "NEW_SUBSCRIPTION" | "SEAT_TOPUP" | "PLAN_UPGRADE";

const toPeriod = (b: BillingCycle): Period =>
  b === "yearly" ? "YEARLY" : "QUARTERLY";

const YEARLY_DISCOUNT_PCT = 20;

function computeAmount(seatPriceInInr: number, seats: number, period: Period) {
  const base = seatPriceInInr * seats; // INR (pre-discount)
  const discountPct = period === "YEARLY" ? YEARLY_DISCOUNT_PCT : 0;
  const amount = Math.round((base * (100 - discountPct)) / 100); // INR (final)
  return { base, amount, discountPct };
}

// Simple promo helper — looks up promo, validates basic rules, and returns discount
async function computePromoDiscountAmount({
  promoCode,
  planId,
  seats,
  grossAmount, // INR (number)
}: {
  promoCode?: string | null;
  planId?: string | null;
  seats?: number;
  grossAmount: number;
  }) {
  const prisma = getCorePrisma();
  if (!promoCode) return null;

  const promo = await prisma.promoCode.findUnique({
    where: { code: promoCode },
  });
  if (!promo) throw new Error("PROMO_NOT_FOUND");
  if (!promo.active) throw new Error("PROMO_INACTIVE");
  const now = new Date();
  if (promo.startsAt && promo.startsAt > now)
    throw new Error("PROMO_NOT_STARTED");
  if (promo.endsAt && promo.endsAt < now) throw new Error("PROMO_EXPIRED");
  if (promo.maxUses && promo.usedCount >= promo.maxUses)
    throw new Error("PROMO_MAX_USES_EXCEEDED");

  // plan applicability
  if (promo.applicablePlanIds) {
    let allowed: string[] = [];
    try {
      if (promo.applicablePlanIds.trim().startsWith("["))
        allowed = JSON.parse(promo.applicablePlanIds);
      else
        allowed = promo.applicablePlanIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    } catch {
      allowed = promo.applicablePlanIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (allowed.length > 0 && planId && !allowed.includes(planId)) {
      throw new Error("PROMO_NOT_APPLICABLE_TO_PLAN");
    }
  }

  if (promo.minSeats && seats && seats < promo.minSeats)
    throw new Error("PROMO_MIN_SEATS_NOT_MET");

  // compute discount
  let discountAmount = 0;
  if (promo.discountType === "PERCENT") {
    const pct = Math.max(0, Math.min(100, promo.discountValue));
    discountAmount = Math.round(grossAmount * (pct / 100) * 100) / 100;
  } else {
    discountAmount = Math.round(Number(promo.discountValue) * 100) / 100;
  }
  if (discountAmount > grossAmount) discountAmount = grossAmount;

  return {
    promoId: promo.id,
    code: promo.code,
    discountAmount,
    promoType: promo.discountType,
    promoRow: promo,
  };
}

// Apply yearly discount ONLY for YEARLY period to get the effective seat price used for comparisons
function effectiveSeatPriceForPeriod(rawSeatPerPeriod: number, period: Period) {
  return period === "YEARLY"
    ? Math.round((rawSeatPerPeriod * (100 - YEARLY_DISCOUNT_PCT)) / 100)
    : rawSeatPerPeriod;
}

// keep under 40 chars
function makeReceipt(prefix: string, idSeed: string) {
  const p = prefix.slice(0, 8);
  const ts = Date.now().toString(36);
  const seed = (idSeed || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `${p}_${seed}_${ts}`.slice(0, 40);
}

// Time-based proration against the current subscription window
function prorationFactor(now: Date, start: Date, end: Date) {
  const totalMs = end.getTime() - start.getTime();
  const remainingMs = Math.max(0, end.getTime() - now.getTime());
  if (totalMs <= 0) return 0;
  return Math.min(1, remainingMs / totalMs);
}

/**
 * Compute INR for prorated topup.
 */
function computeProratedTopupAmountINR(params: {
  seatPriceInInr: number;
  deltaSeats: number;
  subStart: Date;
  subEnd: Date;
  now?: Date;
  minFactor?: number;
}) {
  const { seatPriceInInr, deltaSeats, subStart, subEnd } = params;
  const now = params.now ?? new Date();
  const baseFactor = prorationFactor(now, subStart, subEnd);
  const factor =
    typeof params.minFactor === "number"
      ? Math.max(params.minFactor, baseFactor)
      : baseFactor;

  const raw = seatPriceInInr * deltaSeats * factor; // INR
  return { amountProratedInInr: Math.max(0, Math.round(raw)), factor };
}

/**
 * Compute INR for prorated plan upgrade (never negative).
 */
function computeProratedUpgradeAmountINR(params: {
  oldSeatPriceInInr: number;
  newSeatPriceInInr: number;
  seats: number;
  subStart: Date;
  subEnd: Date;
  now?: Date;
  minFactor?: number;
}) {
  const {
    oldSeatPriceInInr,
    newSeatPriceInInr,
    seats,
    subStart,
    subEnd,
    now,
    minFactor,
  } = params;

  const factorBase = prorationFactor(now ?? new Date(), subStart, subEnd);
  const factor =
    typeof minFactor === "number"
      ? Math.max(minFactor, factorBase)
      : factorBase;

  const diffPerSeat = Math.max(0, newSeatPriceInInr - oldSeatPriceInInr);
  const raw = diffPerSeat * seats * factor;
  const amountProratedInInr = Math.max(0, Math.round(raw));
  return { amountProratedInInr, factor, diffPerSeat };
}

/**
 * POST /payment/quote
 * - NEW_SUBSCRIPTION: { planId, billingCycle: "quarterly"|"yearly", userCount }
 * - SEAT_TOPUP:       { purpose: "SEAT_TOPUP",    deltaSeats }
 * - PLAN_UPGRADE:     { purpose: "PLAN_UPGRADE",  newPlanId }
 */
export const quote = async (req: Request & { user?: any }, res: Response) => {
  try {
    const prisma = getCorePrisma();
    const purpose =
      (req.body?.purpose as Purpose | undefined) ?? "NEW_SUBSCRIPTION";

    // ---------- SEAT TOP-UP ----------
    if (purpose === "SEAT_TOPUP") {
      const userId = req.user?.id;
      const orgId = req.user?.orgId;
      const deltaSeats = Math.max(1, Number(req.body?.deltaSeats || 0));
      const promoCode = (req.body as any)?.promoCode as string | undefined;

      if (!userId || !orgId)
        return res.status(401).json({ message: "Unauthorized" });

      const sub = await prisma.subscription.findFirst({
        where: { orgId, status: "ACTIVE", isTrial: false },
        orderBy: { startDate: "desc" },
      });
      if (!sub)
        return res.status(400).json({ message: "NO_ACTIVE_PAID_SUBSCRIPTION" });

      if (sub.billingCycle !== "YEARLY" && sub.billingCycle !== "QUARTERLY") {
        return res.status(400).json({ message: "NO_BILLING_CYCLE" });
      }
      const period: Period = sub.billingCycle;
      const pid = sub.planId;
      if (!pid) {
        return res
          .status(400)
          .json({ message: "PLAN_MISSING_ON_SUBSCRIPTION" });
      }

      const priceRow = await prisma.planPrice.findUnique({
        where: { planId_period: { planId: pid, period } },
      });
      if (!priceRow)
        return res.status(400).json({ message: "PRICE_NOT_FOUND" });

      const seatPrice = Number(priceRow.price ?? 0);
      if (seatPrice <= 0)
        return res.status(400).json({ message: "INVALID_PRICE" });

      const { amountProratedInInr, factor } = computeProratedTopupAmountINR({
        seatPriceInInr: seatPrice,
        deltaSeats,
        subStart: sub.startDate,
        subEnd: sub.endDate,
      });

      // apply promo if present
      let promoResult = null;
      let amountAfterPromo = amountProratedInInr;
      if (promoCode) {
        try {
          promoResult = await computePromoDiscountAmount({
            promoCode,
            planId: pid,
            seats: deltaSeats,
            grossAmount: amountProratedInInr,
          });
          if (promoResult) {
            amountAfterPromo = Math.max(
              0,
              Math.round(
                (amountProratedInInr - promoResult.discountAmount) * 100
              ) / 100
            );
          }
        } catch (e: any) {
          return res
            .status(400)
            .json({ message: e.message || "PROMO_INVALID" });
        }
      }

      return res.json({
        amount: amountAfterPromo,
        currency: "INR",
        period,
        seats: deltaSeats,
        purpose: "SEAT_TOPUP",
        proration: {
          factor,
          start: sub.startDate,
          end: sub.endDate,
        },
        promo: promoResult
          ? {
              code: promoResult.code,
              discountAmount: promoResult.discountAmount,
            }
          : null,
      });
    }

    // ---------- PLAN UPGRADE ----------
    if (purpose === "PLAN_UPGRADE") {
      const userId = req.user?.id;
      const orgId = req.user?.orgId;
      const newPlanId = String(req.body?.newPlanId || "");
      const promoCode = (req.body as any)?.promoCode as string | undefined;

      if (!userId || !orgId)
        return res.status(401).json({ message: "Unauthorized" });
      if (!newPlanId)
        return res.status(400).json({ message: "NEW_PLAN_REQUIRED" });

      const sub = await prisma.subscription.findFirst({
        where: { orgId, status: "ACTIVE", isTrial: false },
        orderBy: { startDate: "desc" },
      });
      if (!sub)
        return res.status(400).json({ message: "NO_ACTIVE_PAID_SUBSCRIPTION" });
      if (sub.billingCycle !== "YEARLY" && sub.billingCycle !== "QUARTERLY") {
        return res.status(400).json({ message: "NO_BILLING_CYCLE" });
      }
      const period: Period = sub.billingCycle;
      const oldPlanId = sub.planId;
      if (!oldPlanId) {
        return res.status(400).json({ message: "OLD_PLAN_MISSING" });
      }
      if (oldPlanId === newPlanId) {
        return res.status(400).json({ message: "SAME_PLAN" });
      }

      const oldPriceRow = await prisma.planPrice.findUnique({
        where: { planId_period: { planId: oldPlanId, period } },
      });
      const newPriceRow = await prisma.planPrice.findUnique({
        where: { planId_period: { planId: newPlanId, period } },
      });
      if (!oldPriceRow || !newPriceRow)
        return res.status(400).json({ message: "PRICE_NOT_FOUND" });

      // Use EFFECTIVE (discounted for YEARLY) prices for upgrade comparisons
      const oldSeatRaw = Number(oldPriceRow.price ?? 0);
      const newSeatRaw = Number(newPriceRow.price ?? 0);
      if (newSeatRaw <= 0)
        return res.status(400).json({ message: "INVALID_NEW_PRICE" });

      const oldSeatEff = effectiveSeatPriceForPeriod(oldSeatRaw, period);
      const newSeatEff = effectiveSeatPriceForPeriod(newSeatRaw, period);

      const seats = Number(sub.userCount || 0);
      if (seats <= 0) return res.status(400).json({ message: "INVALID_SEATS" });

      const { amountProratedInInr, factor, diffPerSeat } =
        computeProratedUpgradeAmountINR({
          oldSeatPriceInInr: oldSeatEff,
          newSeatPriceInInr: newSeatEff,
          seats,
          subStart: sub.startDate,
          subEnd: sub.endDate,
        });

      // apply promo if present
      let promoResult = null;
      let amountAfterPromo = amountProratedInInr;
      if (promoCode) {
        try {
          promoResult = await computePromoDiscountAmount({
            promoCode,
            planId: newPlanId,
            seats,
            grossAmount: amountProratedInInr,
          });
          if (promoResult) {
            amountAfterPromo = Math.max(
              0,
              Math.round(
                (amountProratedInInr - promoResult.discountAmount) * 100
              ) / 100
            );
          }
        } catch (e: any) {
          return res
            .status(400)
            .json({ message: e.message || "PROMO_INVALID" });
        }
      }

      return res.json({
        amount: amountAfterPromo,
        currency: "INR",
        period,
        seats,
        purpose: "PLAN_UPGRADE",
        fromPlanId: oldPlanId,
        toPlanId: newPlanId,
        priceDiffPerSeat: diffPerSeat, // effective (discounted if YEARLY)
        proration: { factor, start: sub.startDate, end: sub.endDate },
        promo: promoResult
          ? {
              code: promoResult.code,
              discountAmount: promoResult.discountAmount,
            }
          : null,
      });
    }

    // ---------- NEW SUBSCRIPTION ----------
    const { planId, billingCycle, userCount } = req.body as {
      planId: string;
      billingCycle: BillingCycle;
      userCount: number;
    };

    const period = toPeriod(billingCycle);
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return res.status(400).json({ message: "INVALID_PLAN" });

    const minUsers = (plan.features as any)?.limits?.minUsers ?? 1;
    const seats = Math.max(Number(userCount || minUsers), minUsers);

    const priceRow = await prisma.planPrice.findUnique({
      where: { planId_period: { planId, period } },
    });
    if (!priceRow) return res.status(400).json({ message: "PRICE_NOT_FOUND" });

    const seatPrice = Number(priceRow.price ?? 0);
    if (seatPrice <= 0)
      return res.status(400).json({ message: "INVALID_PRICE" });

    const { base, amount, discountPct } = computeAmount(
      seatPrice,
      seats,
      period
    );

    // inside NEW_SUBSCRIPTION flow, after you compute base/amount/discountPct:
    const promoCode = (req.body as any)?.promoCode as string | undefined;
    let promoResult = null;
    let amountAfterPromo = amount; // INR

    if (promoCode) {
      try {
        promoResult = await computePromoDiscountAmount({
          promoCode,
          planId,
          seats,
          grossAmount: amount, // use net after YEARLY site discount as "gross" for promo
        });
        if (promoResult) {
          amountAfterPromo = Math.max(
            0,
            Math.round((amount - promoResult.discountAmount) * 100) / 100
          );
        }
      } catch (e: any) {
        // surface user-friendly error
        return res.status(400).json({ message: e.message || "PROMO_INVALID" });
      }
    }

    return res.json({
      amount: amountAfterPromo,
      base,
      discountPct,
      currency: "INR",
      period,
      seats,
      purpose: "NEW_SUBSCRIPTION",
      promo: promoResult
        ? { code: promoResult.code, discountAmount: promoResult.discountAmount }
        : null,
    });
  } catch (e) {
    console.error("quote error", e);
    return res.status(500).json({ message: "QUOTE_FAILED" });
  }
};

/**
 * POST /payment/create-order
 * - NEW_SUBSCRIPTION: { planId, userCount?, billingCycle: "quarterly"|"yearly", promoCode? }
 * - SEAT_TOPUP:       { purpose: "SEAT_TOPUP",   deltaSeats, promoCode? }
 * - PLAN_UPGRADE:     { purpose: "PLAN_UPGRADE", newPlanId, promoCode? }
 */
export const createRazorpayOrder = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    const prisma = getCorePrisma();
    const purpose =
      (req.body?.purpose as Purpose | undefined) ?? "NEW_SUBSCRIPTION";

    // =============== SEAT TOP-UP ===============
    if (purpose === "SEAT_TOPUP") {
      const userId = req.user?.id;
      const orgId = req.user?.orgId;
      const deltaSeats = Math.max(1, Number(req.body?.deltaSeats || 0));
      const promoCode = (req.body as any)?.promoCode as string | undefined;

      if (!userId || !orgId)
        return res.status(401).json({ message: "Unauthorized" });

      const sub = await prisma.subscription.findFirst({
        where: { orgId, status: "ACTIVE", isTrial: false },
        orderBy: { startDate: "desc" },
      });
      if (!sub)
        return res.status(400).json({ message: "NO_ACTIVE_PAID_SUBSCRIPTION" });
      if (sub.billingCycle !== "YEARLY" && sub.billingCycle !== "QUARTERLY") {
        return res.status(400).json({ message: "NO_BILLING_CYCLE" });
      }
      const period: Period = sub.billingCycle;
      const pid = sub.planId;
      if (!pid) {
        return res
          .status(400)
          .json({ message: "PLAN_MISSING_ON_SUBSCRIPTION" });
      }

      const priceRow = await prisma.planPrice.findUnique({
        where: { planId_period: { planId: pid, period } },
      });
      if (!priceRow)
        return res.status(400).json({ message: "PRICE_NOT_FOUND" });

      const seatPrice = Number(priceRow.price ?? 0);
      if (seatPrice <= 0)
        return res.status(400).json({ message: "INVALID_PRICE" });

      const { amountProratedInInr, factor } = computeProratedTopupAmountINR({
        seatPriceInInr: seatPrice,
        deltaSeats,
        subStart: sub.startDate,
        subEnd: sub.endDate,
      });

      // apply promo if present
      let promoResult = null;
      let amountAfterPromo = amountProratedInInr;
      if (promoCode) {
        try {
          promoResult = await computePromoDiscountAmount({
            promoCode,
            planId: pid,
            seats: deltaSeats,
            grossAmount: amountProratedInInr,
          });
          if (promoResult) {
            amountAfterPromo = Math.max(
              0,
              Math.round(
                (amountProratedInInr - promoResult.discountAmount) * 100
              ) / 100
            );
          }
        } catch (e: any) {
          return res
            .status(400)
            .json({ message: e.message || "PROMO_INVALID" });
        }
      }

      // If zero-amount after promo -> create SUCCESS payment & consume promo atomically (if promo present)
      const receipt = makeReceipt("topup", sub.id);
      if (amountAfterPromo === 0) {
        if (promoResult) {
          const [payRow] = await prisma.$transaction([
            prisma.payment.create({
              data: {
                purpose: "SEAT_TOPUP" as PaymentPurpose,
                status: "SUCCESS" as PaymentStatus,
                razorpayOrderId: "",
                razorpayPaymentId: "",
                amount: 0,
                currency: "INR",
                userId,
                subscriptionId: sub.id,
                date: new Date(),
                meta: {
                  orgId,
                  subscriptionId: sub.id,
                  planId: pid,
                  period,
                  deltaSeats,
                  receipt,
                  proration: { factor, start: sub.startDate, end: sub.endDate },
                  promoCode: promoResult.code,
                  promoDiscountAmount: promoResult.discountAmount,
                  promoApplied: true,
                },
              },
            }),
            prisma.promoCode.update({
              where: { id: promoResult.promoId },
              data: { usedCount: { increment: 1 } },
            }),
          ]);
          return res.status(200).json({
            next: "apply_direct",
            quote: {
              amount: 0,
              currency: "INR",
              period,
              seats: deltaSeats,
              proration: { factor },
            },
            paymentId: payRow.id,
          });
        } else {
          const payRow = await prisma.payment.create({
            data: {
              purpose: "SEAT_TOPUP" as PaymentPurpose,
              status: "SUCCESS" as PaymentStatus,
              razorpayOrderId: "",
              razorpayPaymentId: "",
              amount: 0,
              currency: "INR",
              userId,
              subscriptionId: sub.id,
              date: new Date(),
              meta: {
                orgId,
                subscriptionId: sub.id,
                planId: pid,
                period,
                deltaSeats,
                receipt,
                proration: { factor, start: sub.startDate, end: sub.endDate },
              },
            },
          });
          return res.status(200).json({
            next: "apply_direct",
            quote: {
              amount: 0,
              currency: "INR",
              period,
              seats: deltaSeats,
              proration: { factor },
            },
            paymentId: payRow.id,
          });
        }
      }

      // Regular order creation for non-zero
      const amountInPaise = Math.max(1, Math.round(amountAfterPromo * 100));
      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt,
        notes: {
          purpose: "SEAT_TOPUP",
          orgId,
          subscriptionId: sub.id,
          planId: pid,
          period,
          deltaSeats: String(deltaSeats),
          userId,
          prorationFactor: String(factor),
          promoCode: promoResult?.code ?? null,
          promoDiscountAmount: promoResult?.discountAmount ?? 0,
        },
      });

      const pay = await prisma.payment.create({
        data: {
          purpose: "SEAT_TOPUP" as PaymentPurpose,
          status: "PENDING" as PaymentStatus,
          razorpayOrderId: order.id,
          razorpayPaymentId: "",
          amount: amountAfterPromo, // INR
          currency: "INR",
          userId,
          subscriptionId: sub.id,
          meta: {
            orgId,
            subscriptionId: sub.id,
            planId: pid,
            period,
            deltaSeats,
            receipt,
            proration: {
              factor,
              start: sub.startDate,
              end: sub.endDate,
            },
            promoCode: promoResult?.code ?? null,
            promoDiscountAmount: promoResult?.discountAmount ?? 0,
            promoApplied: false,
          },
        },
      });

      return res.status(201).json({
        next: "checkout",
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt,
        },
        quote: {
          amount: amountAfterPromo,
          currency: "INR",
          period,
          seats: deltaSeats,
          proration: { factor },
          promo: promoResult
            ? {
                code: promoResult.code,
                discountAmount: promoResult.discountAmount,
              }
            : null,
        },
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        paymentId: pay.id,
      });
    }

    // =============== PLAN UPGRADE ===============
    if (purpose === "PLAN_UPGRADE") {
      const userId = req.user?.id;
      const orgId = req.user?.orgId;
      const newPlanId = String(req.body?.newPlanId || "");
      const promoCode = (req.body as any)?.promoCode as string | undefined;
      if (!userId || !orgId)
        return res.status(401).json({ message: "Unauthorized" });
      if (!newPlanId)
        return res.status(400).json({ message: "NEW_PLAN_REQUIRED" });

      const sub = await prisma.subscription.findFirst({
        where: { orgId, status: "ACTIVE", isTrial: false },
        orderBy: { startDate: "desc" },
      });
      if (!sub)
        return res.status(400).json({ message: "NO_ACTIVE_PAID_SUBSCRIPTION" });
      if (sub.billingCycle !== "YEARLY" && sub.billingCycle !== "QUARTERLY") {
        return res.status(400).json({ message: "NO_BILLING_CYCLE" });
      }
      const period: Period = sub.billingCycle;
      const oldPlanId = sub.planId;
      if (!oldPlanId)
        return res.status(400).json({ message: "OLD_PLAN_MISSING" });
      if (oldPlanId === newPlanId)
        return res.status(400).json({ message: "SAME_PLAN" });

      const [oldPriceRow, newPriceRow] = await Promise.all([
        prisma.planPrice.findUnique({
          where: { planId_period: { planId: oldPlanId, period } },
        }),
        prisma.planPrice.findUnique({
          where: { planId_period: { planId: newPlanId, period } },
        }),
      ]);
      if (!oldPriceRow || !newPriceRow)
        return res.status(400).json({ message: "PRICE_NOT_FOUND" });

      // Use EFFECTIVE (discounted for YEARLY) prices for upgrade comparisons
      const oldSeatRaw = Number(oldPriceRow.price ?? 0);
      const newSeatRaw = Number(newPriceRow.price ?? 0);
      const seats = Number(sub.userCount || 0);
      if (seats <= 0 || newSeatRaw <= 0)
        return res.status(400).json({ message: "INVALID_PRICING_OR_SEATS" });

      const oldSeatEff = effectiveSeatPriceForPeriod(oldSeatRaw, period);
      const newSeatEff = effectiveSeatPriceForPeriod(newSeatRaw, period);

      const { amountProratedInInr, factor, diffPerSeat } =
        computeProratedUpgradeAmountINR({
          oldSeatPriceInInr: oldSeatEff,
          newSeatPriceInInr: newSeatEff,
          seats,
          subStart: sub.startDate,
          subEnd: sub.endDate,
        });

      // apply promo if present
      let promoResult = null;
      let amountAfterPromo = amountProratedInInr;
      if (promoCode) {
        try {
          promoResult = await computePromoDiscountAmount({
            promoCode,
            planId: newPlanId,
            seats,
            grossAmount: amountProratedInInr,
          });
          if (promoResult) {
            amountAfterPromo = Math.max(
              0,
              Math.round(
                (amountProratedInInr - promoResult.discountAmount) * 100
              ) / 100
            );
          }
        } catch (e: any) {
          return res
            .status(400)
            .json({ message: e.message || "PROMO_INVALID" });
        }
      }

      // If ₹0, create an immediate SUCCESS payment row and consume promo if present
      if (amountAfterPromo === 0) {
        if (promoResult) {
          const [payRow] = await prisma.$transaction([
            prisma.payment.create({
              data: {
                purpose: "UPGRADE" as PaymentPurpose,
                status: "SUCCESS" as PaymentStatus,
                razorpayOrderId: "",
                razorpayPaymentId: "",
                amount: 0,
                currency: "INR",
                userId,
                subscriptionId: sub.id,
                date: new Date(),
                meta: {
                  orgId,
                  subscriptionId: sub.id,
                  fromPlanId: oldPlanId,
                  toPlanId: newPlanId,
                  period,
                  seats,
                  proration: {
                    factor,
                    start: sub.startDate,
                    end: sub.endDate,
                    diffPerSeat,
                  },
                  receipt: makeReceipt("upgrade0", sub.id),
                  promoCode: promoResult.code,
                  promoDiscountAmount: promoResult.discountAmount,
                  promoApplied: true,
                },
              },
            }),
            prisma.promoCode.update({
              where: { id: promoResult.promoId },
              data: { usedCount: { increment: 1 } },
            }),
          ]);
          return res.status(200).json({
            next: "apply_direct",
            quote: {
              amount: 0,
              currency: "INR",
              period,
              seats,
              proration: { factor },
              priceDiffPerSeat: diffPerSeat,
            },
            paymentId: payRow.id,
          });
        } else {
          const zeroPay = await prisma.payment.create({
            data: {
              purpose: "UPGRADE" as PaymentPurpose,
              status: "SUCCESS" as PaymentStatus,
              razorpayOrderId: "",
              razorpayPaymentId: "",
              amount: 0,
              currency: "INR",
              userId,
              subscriptionId: sub.id,
              date: new Date(),
              meta: {
                orgId,
                subscriptionId: sub.id,
                fromPlanId: oldPlanId,
                toPlanId: newPlanId,
                period,
                seats,
                proration: {
                  factor,
                  start: sub.startDate,
                  end: sub.endDate,
                  diffPerSeat,
                },
                receipt: makeReceipt("upgrade0", sub.id),
              },
            },
          });
          return res.status(200).json({
            next: "apply_direct",
            quote: {
              amount: 0,
              currency: "INR",
              period,
              seats,
              proration: { factor },
              priceDiffPerSeat: diffPerSeat,
            },
            paymentId: zeroPay.id,
          });
        }
      }

      // Regular non-zero-order flow
      const amountInPaise = Math.max(1, Math.round(amountAfterPromo * 100));
      const receipt = makeReceipt("upgrade", sub.id);

      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt,
        notes: {
          purpose: "PLAN_UPGRADE",
          orgId,
          subscriptionId: sub.id,
          fromPlanId: oldPlanId,
          toPlanId: newPlanId,
          period,
          seats: String(seats),
          userId,
          prorationFactor: String(factor),
          promoCode: promoResult?.code ?? null,
          promoDiscountAmount: promoResult?.discountAmount ?? 0,
        },
      });

      const pay = await prisma.payment.create({
        data: {
          purpose: "UPGRADE",
          status: "PENDING",
          razorpayOrderId: order.id,
          razorpayPaymentId: "",
          amount: amountAfterPromo, // INR
          currency: "INR",
          userId,
          subscriptionId: sub.id,
          meta: {
            orgId,
            subscriptionId: sub.id,
            fromPlanId: oldPlanId,
            toPlanId: newPlanId,
            period,
            seats,
            proration: {
              factor,
              start: sub.startDate,
              end: sub.endDate,
              diffPerSeat,
            },
            receipt,
            promoCode: promoResult?.code ?? null,
            promoDiscountAmount: promoResult?.discountAmount ?? 0,
            promoApplied: false,
          },
        },
      });

      return res.status(201).json({
        next: "checkout",
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt,
        },
        quote: {
          amount: amountAfterPromo,
          currency: "INR",
          period,
          seats,
          proration: { factor },
          priceDiffPerSeat: diffPerSeat, // effective
          promo: promoResult
            ? {
                code: promoResult.code,
                discountAmount: promoResult.discountAmount,
              }
            : null,
        },
        razorpayKeyId: process.env.RAZORPAY_KEY_ID,
        paymentId: pay.id,
      });
    }

    // =============== NEW SUBSCRIPTION ===============
    // handled earlier in quote flow; create order for NEW_SUBSCRIPTION here
    const { planId, userCount, billingCycle } = req.body as {
      planId: string;
      userCount?: number;
      billingCycle: BillingCycle;
    };

    const userId = req.user?.id as string | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return res.status(400).json({ message: "INVALID_PLAN" });
    const minUsers = (plan.features as any)?.limits?.minUsers ?? 1;
    const seats = Math.max(Number(userCount ?? minUsers), minUsers);

    const period = toPeriod(billingCycle);
    const priceRow = await prisma.planPrice.findUnique({
      where: { planId_period: { planId, period } },
    });
    if (!priceRow) return res.status(400).json({ message: "PRICE_NOT_FOUND" });

    const seatPrice = Number(priceRow.price ?? 0);
    if (seatPrice <= 0)
      return res.status(400).json({ message: "INVALID_PRICE" });

    const { base, amount, discountPct } = computeAmount(
      seatPrice,
      seats,
      period
    );

    const promoCodeBody = (req.body as any)?.promoCode as string | undefined;
    let promoResult = null;
    let amountAfterPromo = amount;
    if (promoCodeBody) {
      try {
        promoResult = await computePromoDiscountAmount({
          promoCode: promoCodeBody,
          planId,
          seats,
          grossAmount: amount,
        });
        if (promoResult) {
          amountAfterPromo = Math.max(
            0,
            Math.round((amount - promoResult.discountAmount) * 100) / 100
          );
        }
      } catch (e: any) {
        return res.status(400).json({ message: e.message || "PROMO_INVALID" });
      }
    }

    const receipt = makeReceipt("newsub", planId);

    if (amountAfterPromo === 0) {
      if (promoResult) {
        const [zeroPay] = await prisma.$transaction([
          prisma.payment.create({
            data: {
              purpose: "NEW_SUBSCRIPTION" as PaymentPurpose,
              status: "SUCCESS" as PaymentStatus,
              razorpayOrderId: "",
              razorpayPaymentId: "",
              amount: 0,
              currency: "INR",
              userId,
              date: new Date(),
              meta: {
                planId,
                period,
                seats,
                receipt,
                base,
                discountPct,
                promoCode: promoResult.code,
                promoDiscountAmount: promoResult.discountAmount,
                promoApplied: true,
              },
            },
          }),
          prisma.promoCode.update({
            where: { id: promoResult.promoId },
            data: { usedCount: { increment: 1 } },
          }),
        ]);
        return res.status(200).json({
          next: "apply_direct",
          quote: {
            amount: 0,
            base,
            discountPct,
            currency: "INR",
            period,
            seats,
          },
          paymentId: zeroPay.id,
        });
      } else {
        const zeroPay = await prisma.payment.create({
          data: {
            purpose: "NEW_SUBSCRIPTION" as PaymentPurpose,
            status: "SUCCESS" as PaymentStatus,
            razorpayOrderId: "",
            razorpayPaymentId: "",
            amount: 0,
            currency: "INR",
            userId,
            date: new Date(),
            meta: { planId, period, seats, receipt, base, discountPct },
          },
        });
        return res.status(200).json({
          next: "apply_direct",
          quote: {
            amount: 0,
            base,
            discountPct,
            currency: "INR",
            period,
            seats,
          },
          paymentId: zeroPay.id,
        });
      }
    }

    // Regular NEW_SUBSCRIPTION path: create Razorpay order for NET amount
    const amountInPaiseNet = Math.max(1, Math.round(amountAfterPromo * 100));
    const order = await razorpay.orders.create({
      amount: amountInPaiseNet,
      currency: "INR",
      receipt,
      notes: {
        planId,
        period,
        seats: String(seats),
        userId,
        purpose: "NEW_SUBSCRIPTION",
        promoCode: promoResult?.code ?? null,
        promoDiscountAmount: promoResult?.discountAmount ?? 0,
      },
    });

    await prisma.payment.create({
      data: {
        purpose: "NEW_SUBSCRIPTION",
        status: "PENDING",
        razorpayOrderId: order.id,
        razorpayPaymentId: "",
        amount: amountAfterPromo,
        currency: "INR",
        userId,
        meta: {
          planId,
          period,
          seats,
          receipt,
          base,
          discountPct,
          promoCode: promoResult?.code ?? null,
          promoDiscountAmount: promoResult?.discountAmount ?? 0,
          promoApplied: false,
        },
      },
    });

    return res.status(201).json({
      next: "checkout",
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      },
      quote: {
        amount: amountAfterPromo,
        base,
        discountPct,
        currency: "INR",
        period,
        seats,
        promo: promoResult
          ? {
              code: promoResult.code,
              discountAmount: promoResult.discountAmount,
            }
          : null,
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Razorpay Order Error:", err);
    return res.status(500).json({ message: "FAILED_TO_CREATE_ORDER" });
  }
};

/**
 * Verify Razorpay payment (works for all purposes).
 */
export const verifyPayment = async (
  req: Request & { user?: any },
  res: Response
) => {
  const prisma = getCorePrisma();
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body as {
        razorpay_order_id: string;
        razorpay_payment_id: string;
        razorpay_signature: string;
      };

    const userId = req.user?.id as string | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET as string)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "INVALID_SIGNATURE" });
    }

    const paymentRow = await prisma.payment.findFirst({
      where: { razorpayOrderId: razorpay_order_id },
    });
    if (!paymentRow)
      return res.status(404).json({ message: "PAYMENT_NOT_FOUND" });

    if (paymentRow.userId && paymentRow.userId !== userId) {
      return res.status(403).json({ message: "PAYMENT_OWNERSHIP_MISMATCH" });
    }

    if (paymentRow.status === "SUCCESS") {
      return res.status(200).json({
        message: "Payment already verified",
        success: true,
        paymentId: paymentRow.id,
        invoice: {
          id: paymentRow.id,
          invoiceNumber: `INV-${paymentRow.id}`,
          amount: Number(paymentRow.amount),
          planId: (paymentRow.meta as any)?.planId,
          userCount: (paymentRow.meta as any)?.seats,
          billingCycle: (paymentRow.meta as any)?.period,
          purpose: paymentRow.purpose,
        },
      });
    }

    const rpPayment = await razorpay.payments.fetch(razorpay_payment_id);
    const amountPaidInInr = Number(rpPayment.amount ?? 0) / 100;
    const currencyPaid = rpPayment.currency;

    if (
      currencyPaid !== "INR" ||
      amountPaidInInr !== Number(paymentRow.amount)
    ) {
      return res.status(400).json({
        message: "AMOUNT_CURRENCY_MISMATCH",
        expected: { amount: Number(paymentRow.amount), currency: "INR" },
        got: { amount: amountPaidInInr, currency: currencyPaid },
      });
    }

    const updated = await prisma.payment.update({
      where: { id: paymentRow.id },
      data: {
        status: "SUCCESS" as PaymentStatus,
        razorpayPaymentId: razorpay_payment_id,
        date: new Date(),
        meta: {
          ...(paymentRow.meta as any),
          rp_status: rpPayment.status,
          rp_method: rpPayment.method,
          rp_email: (rpPayment as any).email,
          rp_contact: (rpPayment as any).contact,
        },
      },
    });

    // finalize promo consumption if present and not already applied
    try {
      const pm = (updated.meta as any) ?? {};
      const code = pm?.promoCode as string | undefined;
      const promoApplied = Boolean(pm?.promoApplied);
      if (code && !promoApplied) {
        // mark promoApplied and bump usedCount in a transaction
        await prisma.$transaction([
          prisma.payment.update({
            where: { id: updated.id },
            data: {
              meta: { ...(updated.meta as any), promoApplied: true } as any,
            },
          }),
          prisma.promoCode.update({
            where: { code },
            data: { usedCount: { increment: 1 } },
          }),
        ]);
      }
    } catch (e) {
      console.error(
        "promo finalize failed for payment (verify):",
        updated.id,
        e
      );
      // don't fail the whole verify flow
    }

    // generate + upload invoice + send email (idempotent)
    try {
      const { createInvoiceAndNotify } = await import("../utils/invoice");
      // don't await forever — but we will await here to ensure invoice meta is set before returning
      await createInvoiceAndNotify(updated.id);
    } catch (err) {
      console.warn("Invoice generation failed after verifyPayment:", err);
      // intentionally continue — payment verification should not fail if invoice/email fails
    }

    return res.status(200).json({
      message: "Payment verified successfully",
      success: true,
      paymentId: updated.id,
      invoiceGenerated: (updated.meta as any)?.invoiceGenerated ?? false,
      invoiceUrl: (updated.meta as any)?.invoiceUrl ?? null,
      invoice: {
        id: updated.id,
        invoiceNumber: `INV-${updated.id}`,
        amount: Number(updated.amount),
        planId: (updated.meta as any)?.planId,
        userCount: (updated.meta as any)?.seats,
        billingCycle: (updated.meta as any)?.period,
        purpose: updated.purpose,
      },
    });
  } catch (err) {
    console.error("Payment verification error:", err);
    return res.status(500).json({ message: "SERVER_ERROR" });
  }
};

/**
 * Razorpay webhook handler (unchanged logic; works for all purposes)
 * IMPORTANT: ensure express.raw() for this route
 */
export const razorpayWebhook = async (req: Request, res: Response) => {
  try {
    const prisma = getCorePrisma();
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("Missing RAZORPAY_WEBHOOK_SECRET");
      return res.status(500).send("server_misconfigured");
    }

    const raw = req.body as Buffer;
    const signature = req.header("x-razorpay-signature") || "";
    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(raw)
      .digest("hex");
    if (signature !== expected) {
      return res.status(400).send("invalid_signature");
    }

    const payload = JSON.parse(raw.toString("utf8"));
    const event = String(payload?.event || "");

    const markSuccess = async (
      orderId: string,
      paymentId: string,
      amountInPaise?: number,
      currency?: string,
      rpMeta?: any
    ) => {
      const row = await prisma.payment.findFirst({
        where: { razorpayOrderId: orderId },
      });
      if (!row) return;
      if (row.status === "SUCCESS") return;

      const expectedAmount = Number(row.amount);
      if (typeof amountInPaise === "number" && currency) {
        const paidInInr = amountInPaise / 100;
        if (currency !== "INR" || paidInInr !== expectedAmount) {
          console.warn("Webhook amount/currency mismatch", {
            orderId,
            expected: { amount: expectedAmount, currency: "INR" },
            got: { amount: paidInInr, currency },
          });
        }
      }

      const updatedRow = await prisma.payment.update({
        where: { id: row.id },
        data: {
          status: "SUCCESS" as PaymentStatus,
          razorpayPaymentId: paymentId || row.razorpayPaymentId,
          date: new Date(),
          meta: {
            ...(row.meta as any),
            webhook_event: event,
            webhook_meta: rpMeta ?? null,
          },
        },
      });

      // finalize promo consumption if present and not already applied
      try {
        const pm = (updatedRow.meta as any) ?? {};
        const code = pm?.promoCode as string | undefined;
        const promoApplied = Boolean(pm?.promoApplied);
        if (code && !promoApplied) {
          await prisma.$transaction([
            prisma.payment.update({
              where: { id: updatedRow.id },
              data: {
                meta: {
                  ...(updatedRow.meta as any),
                  promoApplied: true,
                } as any,
              },
            }),
            prisma.promoCode.update({
              where: { code },
              data: { usedCount: { increment: 1 } },
            }),
          ]);
        }
      } catch (e) {
        console.error(
          "promo finalize failed for payment (webhook):",
          row.id,
          e
        );
      }

      // after updating payment to SUCCESS
      try {
        const { createInvoiceAndNotify } = await import("../utils/invoice");
        await createInvoiceAndNotify(row.id);
      } catch (err) {
        console.warn("Invoice generation failed in webhook markSuccess:", err);
      }
    };

    const markFailed = async (orderId: string, rpMeta?: any) => {
      const row = await prisma.payment.findFirst({
        where: { razorpayOrderId: orderId },
      });
      if (!row) return;
      if (row.status === "SUCCESS") return;
      await prisma.payment.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          meta: {
            ...(row.meta as any),
            webhook_event: event,
            webhook_meta: rpMeta ?? null,
          },
        },
      });
    };

    switch (event) {
      case "payment.captured":
      case "payment.authorized": {
        const p = payload?.payload?.payment?.entity;
        const paymentId = p?.id as string;
        const orderId = p?.order_id as string;
        const amount = p?.amount as number; // paise
        const currency = p?.currency as string;
        if (orderId && paymentId)
          await markSuccess(orderId, paymentId, amount, currency, p);
        break;
      }
      case "payment.failed": {
        const p = payload?.payload?.payment?.entity;
        const orderId = p?.order_id as string;
        if (orderId) await markFailed(orderId, p);
        break;
      }
      case "order.paid": {
        const o = payload?.payload?.order?.entity;
        const orderId = o?.id as string;
        const amountPaid = o?.amount_paid as number | undefined; // paise
        const paymentId =
          payload?.payload?.payment?.entity?.id ||
          (o?.notes?.last_payment_id as string) ||
          "";
        if (orderId)
          await markSuccess(orderId, paymentId, amountPaid, "INR", o);
        break;
      }
      default:
        break;
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("razorpayWebhook error:", err);
    return res.status(500).send("error");
  }
};

// GET /payment/list?limit=20
// Returns last N payments for the current user's org
export const listPayments = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    const prisma = getCorePrisma();
    const orgId = req.user?.orgId as string | undefined;
    if (!orgId) return res.status(401).json({ message: "Unauthorized" });

    const limitRaw = (req.query?.limit as string) || "20";
    const limit = Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 20));

    // We link payments to the org via either:
    //  - the payment's subscription -> orgId
    //  - or the payment's user     -> orgId
    // This covers NEW_SUBSCRIPTION (before convert), TOPUP, MANUAL_RENEWAL, etc.
    const rows = await prisma.payment.findMany({
      where: {
        OR: [{ subscription: { orgId } }, { user: { orgId } }],
      },
      select: {
        id: true,
        purpose: true,
        status: true,
        amount: true,
        currency: true,
        date: true, // set on SUCCESS in your code
        // createdAt: true,    // fallback if date is null
        meta: true,
      },
      orderBy: [{ date: "desc" }],
      take: limit,
    });

    const items = rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      status: r.status,
      amount: Number(r.amount || 0),
      currency: r.currency || "INR",
      date: r.date,
      meta: r.meta ?? null,
    }));

    return res.json({ payments: items });
  } catch (err) {
    console.error("listPayments error:", err);
    return res.status(500).json({ message: "SERVER_ERROR" });
  }
};