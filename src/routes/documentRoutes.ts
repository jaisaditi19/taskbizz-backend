import { Router } from "express";
import { getDocumentsTree } from "../controllers/documentController";

const router = Router();

router.get("/tree", getDocumentsTree);

export default router;
