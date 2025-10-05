"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middlewares/auth");
const clientController_1 = require("../controllers/clientController");
const authorize_1 = require("../middlewares/authorize");
const subscription_1 = require("../middlewares/subscription");
const router = (0, express_1.Router)();
router.post("/", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), subscription_1.requireWriteAccess, clientController_1.createClient);
router.get("/", auth_1.authenticate, clientController_1.getClients);
router.put("/:id", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), subscription_1.requireWriteAccess, clientController_1.updateClient);
router.delete("/:id", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), subscription_1.requireWriteAccess, clientController_1.deleteClient);
// POST /client/bulk
router.post("/bulk", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), subscription_1.requireWriteAccess, clientController_1.bulkUpload);
router.post("/bulk/client-communication", clientController_1.bulkUpdateClientCommunication);
router.post("/bulk/delete", clientController_1.bulkDeleteClients);
exports.default = router;
