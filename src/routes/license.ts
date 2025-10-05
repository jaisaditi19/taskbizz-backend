// src/routes/licenses.ts
import { Router } from "express";
import multer from "multer";
import {
  listLicenses,
  getLicense,
  createLicense,
  updateLicense,
  renewLicense,
  addAttachments,
  deleteAttachment,
  deleteAttachments,
  deleteLicense,
  bulkRenewLicenses, // <-- add
  bulkDeleteLicenses,
  bulkImportLicenses,
  bulkSetResponsible,
} from "../controllers/licenseController";
import { authenticate } from "../middlewares/auth";

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});


// List / Get / Create / Update / Renew
router.post("/bulk/renew", bulkRenewLicenses);
router.post("/bulk/import", bulkImportLicenses);
router.post("/bulk/responsible", bulkSetResponsible);
router.post("/bulk/delete", bulkDeleteLicenses);

router.get("/", listLicenses);
router.get("/:id", getLicense);
router.post("/", createLicense);
router.patch("/:id", updateLicense);
router.post("/:id/renew", renewLicense);

// Attachments
router.post(
  "/:id/attachments",
  upload.array("files", 10),
  addAttachments
);

router.delete("/:id/attachments/:attId", deleteAttachment);
router.delete("/:id/attachments/:attId", deleteAttachment);
router.post("/:id/attachments:bulk-delete", deleteAttachments); // JSON: { ids: ["...","..."] }

router.delete("/:id", deleteLicense);

export default router;
