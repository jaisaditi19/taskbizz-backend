// src/middlewares/minUsers.ts
import type { RequestHandler } from "express";
import { getLimit } from "../utils/subscription";

/**
 * For actions that *reduce* active seats/users, ensure we don't go below minUsers.
 * Assumes `req.subscriptionCtx.seats.used` reflects current (pre-change) users.
 *
 * Example usage:
 *   - deleting a user
 *   - bulk deactivating users
 *   - changing licensed seats downward (if you support that)
 */
export const enforceMinUsersFloor: RequestHandler = (req, res, next) => {
  const ctx = req.subscriptionCtx;
  if (!ctx) return res.status(401).json({ code: "NO_SUBSCRIPTION_CTX" });

  const minUsers = getLimit(req, "minUsers") ?? 1;

  // You can pass an override in body: how many users will remain after this change.
  // If not provided, we conservatively block when used === minUsers.
  const remain =
    typeof req.body?.willRemainUsers === "number"
      ? req.body.willRemainUsers
      : ctx.seats.used - 1; // default assumption: removing 1 user

  if (remain < minUsers) {
    return res.status(409).json({
      code: "MIN_USERS_FLOOR",
      minUsers,
      willRemainUsers: remain,
      message: `This action would reduce active users below the plan minimum (${minUsers}).`,
    });
  }
  next();
};
