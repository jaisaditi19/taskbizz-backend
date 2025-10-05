"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeaturesSchema = void 0;
const zod_1 = require("zod");
exports.FeaturesSchema = zod_1.z.object({
    features: zod_1.z.object({
        tasks: zod_1.z.boolean(),
        clients: zod_1.z.boolean(),
        recurringTasks: zod_1.z.boolean(),
        emailIntegration: zod_1.z.boolean(),
        reports: zod_1.z.boolean(),
        addExtraUsers: zod_1.z.boolean(),
        whatsappIntegration: zod_1.z.boolean(),
        documentManagement: zod_1.z.boolean(),
        documentMailSend: zod_1.z.boolean(),
        clientPortal: zod_1.z.boolean(),
        activityLogs: zod_1.z.boolean(),
    }),
    limits: zod_1.z.object({
        minUsers: zod_1.z.number().int().nonnegative(),
    }),
});
