"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseRenewSchema = exports.licenseUpdateSchema = exports.licenseCreateSchema = void 0;
const zod_1 = require("zod");
exports.licenseCreateSchema = zod_1.z.object({
    title: zod_1.z.string().min(1),
    licenseNumber: zod_1.z.string().trim().optional().nullable(),
    type: zod_1.z.string().trim().optional().nullable(),
    holder: zod_1.z.enum(["ORG", "CLIENT"]),
    clientId: zod_1.z.string().optional().nullable(),
    projectId: zod_1.z.string().optional().nullable(),
    serviceId: zod_1.z.string().optional().nullable(),
    vendorId: zod_1.z.string().optional().nullable(),
    issuedOn: zod_1.z.string().datetime().optional().nullable(),
    validFrom: zod_1.z.string().datetime().optional().nullable(),
    expiresOn: zod_1.z.string().datetime(), // ISO
    remindOffsets: zod_1.z.array(zod_1.z.number().int()).optional(), // negative ints, we'll normalize
    gracePeriodDays: zod_1.z.number().int().min(0).max(365).optional(),
    muted: zod_1.z.boolean().optional(),
    responsibleId: zod_1.z.string().min(1),
    assigneeIds: zod_1.z.array(zod_1.z.string().min(1)).optional().default([]),
    createdById: zod_1.z.string().min(1).optional(), // fallback to req.user.id
});
exports.licenseUpdateSchema = exports.licenseCreateSchema.partial().extend({
    id: zod_1.z.string().min(1),
});
exports.licenseRenewSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    newExpiresOn: zod_1.z.string().datetime(),
    newValidFrom: zod_1.z.string().datetime().optional().nullable(),
    newLicenseNumber: zod_1.z.string().optional().nullable(),
    remindOffsets: zod_1.z.array(zod_1.z.number().int()).optional(),
    gracePeriodDays: zod_1.z.number().int().min(0).max(365).optional(),
});
