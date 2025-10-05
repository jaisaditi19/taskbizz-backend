import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import {
  createClient,
  getClients,
  updateClient,
  deleteClient,
  bulkUpload,
  bulkUpdateClientCommunication,
  bulkDeleteClients
} from "../controllers/clientController";
import { authorize } from "../middlewares/authorize";
import { requireWriteAccess } from "../middlewares/subscription";

const router = Router();

router.post("/", authenticate, authorize("ADMIN"),requireWriteAccess, createClient);
router.get("/", authenticate, getClients);
router.put("/:id", authenticate, authorize("ADMIN"),requireWriteAccess, updateClient);
router.delete("/:id", authenticate, authorize("ADMIN"), requireWriteAccess, deleteClient);
// POST /client/bulk
router.post("/bulk", authenticate, authorize("ADMIN"),requireWriteAccess, bulkUpload);

router.post("/bulk/client-communication", bulkUpdateClientCommunication);
router.post("/bulk/delete", bulkDeleteClients);

export default router;