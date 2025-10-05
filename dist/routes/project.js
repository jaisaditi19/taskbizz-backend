"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const projectController_1 = require("../controllers/projectController");
const auth_1 = require("../middlewares/auth");
const subscription_1 = require("../middlewares/subscription");
const router = express_1.default.Router();
// Create a new project (POST /projects)
router.post("/", auth_1.authenticate, subscription_1.requireWriteAccess, projectController_1.createProject);
router.post("/bulk-upload", auth_1.authenticate, subscription_1.requireWriteAccess, projectController_1.bulkUploadProjects);
// List projects (GET /projects?orgDbUrl=...)
router.get("/", auth_1.authenticate, projectController_1.getProjects);
router.put("/:id", auth_1.authenticate, subscription_1.requireWriteAccess, projectController_1.updateProject);
router.delete("/:id", auth_1.authenticate, subscription_1.requireWriteAccess, projectController_1.deleteProject);
router.post("/bulk/head", projectController_1.bulkUpdateProjectHeads);
exports.default = router;
