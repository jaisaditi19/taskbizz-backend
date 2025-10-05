import { z } from "zod";

export const licenseCreateSchema = z.object({
  title: z.string().min(1),
  licenseNumber: z.string().trim().optional().nullable(),
  type: z.string().trim().optional().nullable(),
  holder: z.enum(["ORG", "CLIENT"]),
  clientId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  serviceId: z.string().optional().nullable(),
  vendorId: z.string().optional().nullable(),

  issuedOn: z.string().datetime().optional().nullable(),
  validFrom: z.string().datetime().optional().nullable(),
  expiresOn: z.string().datetime(), // ISO

  remindOffsets: z.array(z.number().int()).optional(), // negative ints, we'll normalize
  gracePeriodDays: z.number().int().min(0).max(365).optional(),
  muted: z.boolean().optional(),

  responsibleId: z.string().min(1),
  assigneeIds: z.array(z.string().min(1)).optional().default([]),
  createdById: z.string().min(1).optional(), // fallback to req.user.id
});

export const licenseUpdateSchema = licenseCreateSchema.partial().extend({
  id: z.string().min(1),
});

export const licenseRenewSchema = z.object({
  id: z.string().min(1),
  newExpiresOn: z.string().datetime(),
  newValidFrom: z.string().datetime().optional().nullable(),
  newLicenseNumber: z.string().optional().nullable(),
  remindOffsets: z.array(z.number().int()).optional(),
  gracePeriodDays: z.number().int().min(0).max(365).optional(),
});
