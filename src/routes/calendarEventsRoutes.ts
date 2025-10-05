import { Router } from "express";
import { getCalendarEvents } from "../controllers/calendarEventsController";
import { authenticate } from "../middlewares/auth";

const router = Router();
router.get("/", authenticate, getCalendarEvents);
export default router;
