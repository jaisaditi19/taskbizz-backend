"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeAny = exports.authorize = void 0;
// import {prisma} from "../prisma/coreClient";
const container_1 = require("../di/container");
const authorize = (role) => {
    return async (req, res, next) => {
        const prisma = await (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
        });
        if (!user || user.role !== role) {
            return res.status(403).json({ message: "Forbidden" });
        }
        if (user.status !== "ACTIVE") {
            return res.status(403).json({ message: "Account not active" });
        }
        next();
    };
};
exports.authorize = authorize;
const authorizeAny = (roles) => {
    return async (req, res, next) => {
        const prisma = await (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user)
            return res.status(401).json({ message: "Unauthorized" });
        if (user.status !== "ACTIVE")
            return res.status(403).json({ message: "Account not active" });
        if (!roles.includes(user.role))
            return res.status(403).json({ message: "Forbidden" });
        req.currentUser = user; // cache for downstream policies
        next();
    };
};
exports.authorizeAny = authorizeAny;
