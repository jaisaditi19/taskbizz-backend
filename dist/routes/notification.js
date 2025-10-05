"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/notification.routes.ts
const express_1 = require("express");
const notificationController_1 = require("../controllers/notificationController");
const auth_1 = require("../middlewares/auth"); // your auth
const r = (0, express_1.Router)();
// r.use(authenticate);
r.get("/", auth_1.authenticate, notificationController_1.listMyNotifications);
r.post("/:id/read", auth_1.authenticate, notificationController_1.markNotificationRead);
r.post("/read-all", auth_1.authenticate, notificationController_1.markAllNotificationsRead);
exports.default = r;
