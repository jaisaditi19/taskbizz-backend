// src/lib/subscription.ts
import type { Request } from "express";
import type { FeatureKey, LimitKey } from "../shared/subscription";

export const hasFeature = (req: Request, key: FeatureKey): boolean =>
  !!req.subscriptionCtx?.plan.features.features[key];

export const getLimit = (req: Request, key: LimitKey): number | undefined =>
  req.subscriptionCtx?.plan.features.limits[key];

export class LimitError extends Error {
  constructor(public detail: { key: string; limit: number; reason?: string }) {
    super("Limit reached");
  }
}

/**
 * Generic "max" enforcer for future numeric limits you may add
 * (e.g., maxClients, maxStorageMb, reportsMonthly, etc.)
 */
export async function enforceMax(
  req: Request,
  key: LimitKey,
  currentCountFn: () => Promise<number>
) {
  const max = getLimit(req, key);
  if (typeof max !== "number") return;
  const count = await currentCountFn();
  if (count >= max) throw new LimitError({ key, limit: max });
}
