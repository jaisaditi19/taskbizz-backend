"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const calendarEventsController_1 = require("../controllers/calendarEventsController");
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
router.get("/", auth_1.authenticate, calendarEventsController_1.getCalendarEvents);
exports.default = router;
