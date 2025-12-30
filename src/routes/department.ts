import { authenticate } from './../middlewares/auth';
import { Router } from "express";
import {
  getDepartments,
  addDepartment,
  updateDepartment,
  deleteDepartment,
} from "../controllers/departmentController";
// import { authenticate } from "../middleware/requireAuth";

const router = Router();

router.get("/", authenticate, getDepartments);
router.post("/", authenticate, addDepartment);
router.put("/:id", authenticate, updateDepartment);
router.delete("/:id", authenticate, deleteDepartment);

export default router;
