import { changePassword, updateProfileWithLogo } from './../controllers/userController';
import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import {
  getProfile,
  updateProfile,
    inviteUser,
    getAllUsers,
    editUser,
  deleteUser,
    bulkInviteUsers
} from "../controllers/userController";
import { authorize } from "../middlewares/authorize";
import {
  attachSubscriptionContext,
  enforceSeatLimit,
  requireWriteAccess,
} from "../middlewares/subscription";
import { upload } from '../controllers/orgController';

const router = Router();

router.get("/profile", authenticate, getProfile);
router.put("/profile", authenticate, upload, updateProfileWithLogo);

router.post("/invite", authenticate, authorize("ADMIN"), attachSubscriptionContext, enforceSeatLimit,requireWriteAccess, inviteUser);
router.put("/change-password", authenticate, changePassword);
router.get("/", authenticate,  getAllUsers);
router.put("/:id", authenticate, authorize("ADMIN"), requireWriteAccess, editUser);
router.delete("/:id", authenticate, authorize("ADMIN"), requireWriteAccess, deleteUser);
router.post("/bulk-invite", authenticate, authorize("ADMIN"), requireWriteAccess, bulkInviteUsers);


export default router;
