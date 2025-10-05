import { Router } from "express";
import {
  createCalendarEntry,
  getCalendarEntries,
  getCalendarEntry,
  updateCalendarEntry,
  deleteCalendarEntry,
} from "../controllers/calendarEntryController";
import { authenticate } from "../middlewares/auth";
import { requireWriteAccess } from "../middlewares/subscription";

const router = Router();

router.post("/", authenticate,requireWriteAccess, createCalendarEntry);
router.get("/", authenticate, getCalendarEntries);
router.get("/:id", authenticate, getCalendarEntry);
router.patch("/:id", authenticate,requireWriteAccess, updateCalendarEntry);
router.delete("/:id", authenticate,requireWriteAccess, deleteCalendarEntry);

export default router;
