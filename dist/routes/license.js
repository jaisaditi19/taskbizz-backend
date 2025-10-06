"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/licenses.ts
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const licenseController_1 = require("../controllers/licenseController");
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});
// List / Get / Create / Update / Renew
router.post("/bulk/renew", licenseController_1.bulkRenewLicenses);
router.post("/bulk/import", licenseController_1.bulkImportLicenses);
router.post("/bulk/responsible", licenseController_1.bulkSetResponsible);
router.post("/bulk/delete", licenseController_1.bulkDeleteLicenses);
router.get("/", licenseController_1.listLicenses);
router.get("/:id", licenseController_1.getLicense);
router.post("/", licenseController_1.createLicense);
router.patch("/:id", licenseController_1.updateLicense);
router.post("/:id/renew", licenseController_1.renewLicense);
// Attachments
router.post("/:id/attachments", upload.array("files", 10), licenseController_1.addAttachments);
router.delete("/:id/attachments/:attId", licenseController_1.deleteAttachment);
router.delete("/:id/attachments/:attId", licenseController_1.deleteAttachment);
router.post("/:id/attachments/bulk-delete", licenseController_1.deleteAttachments); // JSON: { ids: ["...","..."] }
router.delete("/:id", licenseController_1.deleteLicense);
exports.default = router;
