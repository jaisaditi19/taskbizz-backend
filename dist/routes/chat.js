"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/chat.ts
const express_1 = require("express");
const auth_1 = require("../middlewares/auth");
const chatController_1 = require("../controllers/chatController");
const router = (0, express_1.Router)();
// internal hook (secure this with your own guard or shared secret)
router.post("/directory/user-upsert", chatController_1.upsertDirectoryUser);
// all chat endpoints require auth (org-scoped via req.user.orgId)
router.use(auth_1.authenticate);
router.get("/conversations", chatController_1.listConversations);
router.post("/conversations", chatController_1.createConversation);
router.get("/conversations/:id/messages", chatController_1.listMessages);
router.post("/conversations/:id/messages", chatController_1.sendMessage);
router.post("/messages/:id/read", chatController_1.markMessageRead);
exports.default = router;
