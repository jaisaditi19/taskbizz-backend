import express from "express";
import {
  bulkUploadProjects,
  createProject,
  deleteProject,
  getProjects,
  updateProject,
  bulkUpdateProjectHeads,
} from "../controllers/projectController";
import { authenticate } from "../middlewares/auth";
import { requireWriteAccess } from "../middlewares/subscription";

const router = express.Router();

// Create a new project (POST /projects)
router.post("/", authenticate,requireWriteAccess, createProject);
router.post("/bulk-upload", authenticate,requireWriteAccess, bulkUploadProjects);


// List projects (GET /projects?orgDbUrl=...)
router.get("/", authenticate, getProjects);

router.put("/:id", authenticate,requireWriteAccess, updateProject);
router.delete("/:id", authenticate,requireWriteAccess, deleteProject);
router.post("/bulk/head", bulkUpdateProjectHeads);

export default router;
