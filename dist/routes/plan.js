"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// routes/plans.ts
const express_1 = require("express");
const coreClient_1 = require("../prisma/coreClient");
// import { PrismaClient } from "@prisma/client";
const router = (0, express_1.Router)();
// const prisma = new PrismaClient();
// GET /plans - fetch all plans with full details
router.get("/", async (req, res) => {
    try {
        const plans = await coreClient_1.prisma.plan.findMany({
            include: {
                prices: true, // include all related plan prices
            },
            orderBy: {
                id: "asc",
            },
        });
        console.log(plans);
        res.json(plans);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Failed to fetch plans." });
    }
});
// GET /plans/:id - fetch single plan with full details
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const plan = await coreClient_1.prisma.plan.findUnique({
            where: { id },
            include: {
                prices: true, // include all prices
            },
        });
        if (!plan) {
            return res
                .status(404)
                .json({ success: false, message: "Plan not found." });
        }
        res.json({ data: plan });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Failed to fetch plan." });
    }
});
exports.default = router;
