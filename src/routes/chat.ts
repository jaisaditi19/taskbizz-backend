// src/routes/chat.ts
import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import {
  listConversations,
  createConversation,
  listMessages,
  sendMessage,
  markMessageRead,
  upsertDirectoryUser,
  markAllConversationsRead,
} from "../controllers/chatController";

const router = Router();

// internal hook (secure this with your own guard or shared secret)
router.post("/directory/user-upsert", upsertDirectoryUser);

// all chat endpoints require auth (org-scoped via req.user.orgId)
router.use(authenticate);

router.get("/conversations", listConversations);
router.post("/conversations", createConversation);
router.post("/conversations/read-all", markAllConversationsRead);

router.get("/conversations/:id/messages", listMessages);
router.post("/conversations/:id/messages", sendMessage);

router.post("/messages/:id/read", markMessageRead);

export default router;
