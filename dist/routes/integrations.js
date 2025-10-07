"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const gstController_1 = require("../controllers/gstController");
const router = (0, express_1.Router)();
router.get("/gst/gstin/:gstin", gstController_1.getGstinDetails);
exports.default = router;
