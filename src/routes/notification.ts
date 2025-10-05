// src/routes/notification.routes.ts
import { Router } from "express";
import {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../controllers/notificationController";
import { authenticate } from "../middlewares/auth"; // your auth

const r = Router();
// r.use(authenticate);

r.get("/", authenticate, listMyNotifications);
r.post("/:id/read",authenticate, markNotificationRead);
r.post("/read-all",authenticate, markAllNotificationsRead);

export default r;
