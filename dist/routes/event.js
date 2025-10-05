"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/calendarRoutes.ts
const express_1 = require("express");
const eventController_1 = require("../controllers/eventController");
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
router.get("/events", auth_1.authenticate, eventController_1.getEvents);
exports.default = router;
