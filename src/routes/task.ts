// src/server.ts
import express from "express";
import {
  createTask,
  listTaskOccurrences,
  completeOccurrence,
  updateTask,
  // updateTaskStatus,
  updateOccurrence,
  generateOccurrencesForAllTasks,
  listTasksByProject,
  uploadTaskFiles,
  updateOccurrenceStatus,
  createCustomField,
  listCustomFields,
  bulkUploadTasks,
  deleteCustomField,
  sendTaskToClient,
  getDashboard,
  getOccurrenceDocs,
  deleteTaskAttachment,
  bulkUpdateOccurrences,
  copyOccurrenceAttachments,
  deleteOccurrenceAttachment,
} from "../controllers/taskController";
import { authenticate } from "../middlewares/auth";
import { authorize, authorizeAny } from "../middlewares/authorize";
import { requireWriteAccess } from "../middlewares/subscription";
import { canManageWithinProject } from "../middlewares/managerPolicies";

const router = express.Router();

// Master Task Routes
router.post(
  "/",
  authenticate,
  authorizeAny(["ADMIN", "MANAGER"]),
  requireWriteAccess,
  createTask
); // Create new task (master template)
router.get("/", authenticate, listTaskOccurrences); // List all occurrences (with filters)
router.put("/:id", authenticate,requireWriteAccess, updateTask); // Update master task (affects future occurrences)
router.patch(
  "/occurrence/:id/status",
  authenticate,requireWriteAccess,
  updateOccurrenceStatus
); // Update master task status
router.post(
  "/bulk-upload",
  authenticate,
  authorizeAny(["ADMIN", "MANAGER"]),
  requireWriteAccess,
  bulkUploadTasks
);


// Task Occurrence Routes
router.put("/occurrence/:id", authenticate,requireWriteAccess, updateOccurrence); // Update specific occurrence
router.post("/occurrence/:id/complete", authenticate,requireWriteAccess, completeOccurrence); // Complete specific occurrence
router.get("/by-project", authenticate, listTasksByProject); // List occurrences by project

// Administrative Routes
router.post(
  "/generate-occurrences",
  authenticate,
  requireWriteAccess,
  generateOccurrencesForAllTasks
); // Background job for generating occurrences

// Legacy/Utility Routes (optional - for backward compatibility)
// router.get("/:id/preview", authenticate, previewNextOccurrences);    // Preview future occurrences (less needed now)

router.post(
  "/custom-fields",
  authenticate,
  authorizeAny(["ADMIN", "MANAGER"]),
  requireWriteAccess,
  createCustomField
);
router.post(
  "/send-to-client",
  authenticate,
  requireWriteAccess,
  sendTaskToClient
);

router.get(
  "/custom-fields",
  authenticate,
  listCustomFields
);

router.delete(
  "/custom-fields/:id",
  authenticate,
  authorizeAny(["ADMIN", "MANAGER"]),
  requireWriteAccess,
  deleteCustomField
);

router.get(
  "/dashboard",
  authenticate,
  authorizeAny(["ADMIN", "MANAGER"]),
  getDashboard
);

router.get("/occurrence/:id/docs", authenticate, getOccurrenceDocs);
router.delete("/:id/docs/:id", authenticate, deleteTaskAttachment);
router.patch(
  "/occurrence/bulk",
  authenticate,
  bulkUpdateOccurrences
);

router.post(
  "/occurrence/copy-attachments",
  authenticate,
  copyOccurrenceAttachments
);

router.delete(
  "/occurrence/:occurrenceId/docs/:attachmentId",
  authenticate,
  deleteOccurrenceAttachment
);


export default router;
