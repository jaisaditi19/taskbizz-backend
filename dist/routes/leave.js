"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// routes/leaveRoutes.ts
const express_1 = require("express");
const leaveCtrl = __importStar(require("../controllers/leaveController"));
const auth_1 = require("../middlewares/auth"); // ensures req.user & req.orgId
const authorize_1 = require("../middlewares/authorize");
const router = (0, express_1.Router)();
router.post("/", auth_1.authenticate, leaveCtrl.createLeave);
router.get("/", auth_1.authenticate, leaveCtrl.listLeaves);
router.get("/:id", auth_1.authenticate, leaveCtrl.getLeave);
router.post("/:id/approve", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), leaveCtrl.approveLeave); // admin only - controller checks role
router.post("/:id/reject", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), leaveCtrl.rejectLeave); // admin only
router.post("/:id/cancel", auth_1.authenticate, leaveCtrl.cancelLeave); // requester only
router.post("/:id/admin-cancel", leaveCtrl.adminCancelLeave);
exports.default = router;
