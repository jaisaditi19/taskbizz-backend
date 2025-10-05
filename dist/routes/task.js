"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const express_1 = __importDefault(require("express"));
const taskController_1 = require("../controllers/taskController");
const auth_1 = require("../middlewares/auth");
const authorize_1 = require("../middlewares/authorize");
const subscription_1 = require("../middlewares/subscription");
const router = express_1.default.Router();
// Master Task Routes
router.post("/", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), subscription_1.requireWriteAccess, taskController_1.createTask); // Create new task (master template)
router.get("/", auth_1.authenticate, taskController_1.listTaskOccurrences); // List all occurrences (with filters)
router.put("/:id", auth_1.authenticate, subscription_1.requireWriteAccess, taskController_1.updateTask); // Update master task (affects future occurrences)
router.patch("/occurrence/:id/status", auth_1.authenticate, subscription_1.requireWriteAccess, taskController_1.updateOccurrenceStatus); // Update master task status
router.post("/bulk-upload", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), subscription_1.requireWriteAccess, taskController_1.bulkUploadTasks);
// Task Occurrence Routes
router.put("/occurrence/:id", auth_1.authenticate, subscription_1.requireWriteAccess, taskController_1.updateOccurrence); // Update specific occurrence
router.post("/occurrence/:id/complete", auth_1.authenticate, subscription_1.requireWriteAccess, taskController_1.completeOccurrence); // Complete specific occurrence
router.get("/by-project", auth_1.authenticate, taskController_1.listTasksByProject); // List occurrences by project
// Administrative Routes
router.post("/generate-occurrences", auth_1.authenticate, subscription_1.requireWriteAccess, taskController_1.generateOccurrencesForAllTasks); // Background job for generating occurrences
// Legacy/Utility Routes (optional - for backward compatibility)
// router.get("/:id/preview", authenticate, previewNextOccurrences);    // Preview future occurrences (less needed now)
router.post("/custom-fields", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), subscription_1.requireWriteAccess, taskController_1.createCustomField);
router.post("/send-to-client", auth_1.authenticate, subscription_1.requireWriteAccess, taskController_1.sendTaskToClient);
router.get("/custom-fields", auth_1.authenticate, taskController_1.listCustomFields);
router.delete("/custom-fields/:id", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), subscription_1.requireWriteAccess, taskController_1.deleteCustomField);
router.get("/dashboard", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), taskController_1.getDashboard);
router.get("/occurrence/:id/docs", auth_1.authenticate, taskController_1.getOccurrenceDocs);
router.delete("/:id/docs/:id", auth_1.authenticate, taskController_1.deleteTaskAttachment);
router.patch("/occurrence/bulk", auth_1.authenticate, taskController_1.bulkUpdateOccurrences);
router.post("/occurrence/copy-attachments", auth_1.authenticate, taskController_1.copyOccurrenceAttachments);
router.delete("/occurrence/:occurrenceId/docs/:attachmentId", auth_1.authenticate, taskController_1.deleteOccurrenceAttachment);
exports.default = router;
