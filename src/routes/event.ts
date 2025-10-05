// src/routes/calendarRoutes.ts
import { Router } from "express";
import { getEvents } from "../controllers/eventController";
import { authenticate } from "../middlewares/auth";

const router = Router();
router.get("/events", authenticate, getEvents);
export default router;
