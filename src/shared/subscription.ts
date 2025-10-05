import { z } from "zod";

// src/shared/subscription.ts
export type FeatureKey =
  | "tasks"
  | "clients"
  | "recurringTasks"
  | "emailIntegration"
  | "reports"
  | "addExtraUsers"
  | "whatsappIntegration"
  | "documentManagement"
  | "documentMailSend"
  | "clientPortal"
  | "activityLogs";

export type LimitKey = "minUsers"; // extend later (e.g., "maxClients" | "maxStorageMb")

export type PlanFeaturesJSON = {
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, number>;
};

export type BillingCycle = "QUARTERLY" | "YEARLY" | null;

export type SubscriptionCtx = {
  access: "full" | "view-only";
  isTrial: boolean;
  plan: {
    id: string;
    name: string;
    features: PlanFeaturesJSON; // JSON from Plan.features (after any overrides)
    highlighted: boolean;
    badge: string | null;
    minUsers: number | null; // legacy field in your model
    description: string | null;
  };
  seats: {
    licensed: number; // how many seats are paid/licensed (or minUsers if trial)
    used: number; // active, non-suspended users
    remaining: number; // Math.max(licensed - used, 0)
  };
  cycle: {
    start: Date;
    end: Date;
    billingCycle: BillingCycle;
  };
  status: string; // keep as string unless you export your Prisma enum
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
};

export const FeaturesSchema = z.object({
  features: z.object({
    tasks: z.boolean(),
    clients: z.boolean(),
    recurringTasks: z.boolean(),
    emailIntegration: z.boolean(),
    reports: z.boolean(),
    addExtraUsers: z.boolean(),
    whatsappIntegration: z.boolean(),
    documentManagement: z.boolean(),
    documentMailSend: z.boolean(),
    clientPortal: z.boolean(),
    activityLogs: z.boolean(),
  }),
  limits: z.object({
    minUsers: z.number().int().nonnegative(),
  }),
});

export type FeaturesSchemaType = z.infer<typeof FeaturesSchema>;