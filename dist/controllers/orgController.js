"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDailyProgress = exports.getOrganizationDetails = exports.createOrganization = exports.upload = void 0;
const container_1 = require("../di/container");
const child_process_1 = require("child_process");
const util_1 = require("util");
const container_2 = require("../di/container");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const spaces_1 = require("../config/spaces");
const client_s3_1 = require("@aws-sdk/client-s3");
const crypto_1 = require("crypto");
const multer_1 = __importDefault(require("multer"));
const spacesUtils_1 = require("../utils/spacesUtils");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const storage = multer_1.default.memoryStorage();
exports.upload = (0, multer_1.default)({ storage }).single("logo");
const addDays = (d, days) => new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
const addMonths = (d, months) => {
    const x = new Date(d);
    const m = x.getMonth() + months;
    x.setMonth(m);
    // Handle month overflow (e.g., Jan 31 + 1 month)
    if (x.getMonth() !== ((m % 12) + 12) % 12)
        x.setDate(0);
    return x;
};
const slug = (s) => s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
const createOrganization = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        const user = req.user;
        // ---- Normalize inputs from BOTH payload shapes ----
        // Shape A (current frontend): dbName, planId, paymentId?, userCount?, billingCycle? ("yearly"|"quarterly"), name, industry
        // Shape B (older flow):       name, industry, selectedPlanId, mode ("trial"|"paid"), period ("QUARTERLY"|"YEARLY"), seats, paymentId
        const raw = req.body;
        const name = (raw.name ?? "").toString().trim();
        const industry = raw.industry ? raw.industry.toString().trim() : undefined;
        // Plan id (support both names)
        const planId = (raw.planId ?? raw.selectedPlanId)
            ?.toString()
            ?.trim();
        // Paid vs trial (detect by presence of mode/paymentId)
        const mode = raw.mode === "trial" || raw.mode === "paid"
            ? raw.mode
            : raw.paymentId
                ? "paid"
                : undefined;
        // Period / billingCycle
        const rawPeriod = (raw.period /* "QUARTERLY"|"YEARLY" */ ?? raw.billingCycle) /* "yearly"|"quarterly" */
            ?.toString();
        let period = null;
        if (rawPeriod) {
            const p = rawPeriod.toUpperCase();
            if (p === "YEARLY" || p === "QUARTERLY")
                period = p;
            else if (p === "YEARLY".toLowerCase() || p === "QUARTERLY".toLowerCase())
                period = p.toUpperCase();
        }
        // Seats
        const seats = raw.seats !== undefined
            ? Number(raw.seats)
            : raw.userCount !== undefined
                ? Number(raw.userCount)
                : undefined;
        // Payment
        const paymentId = raw.paymentId
            ? raw.paymentId.toString().trim()
            : undefined;
        // dbName: prefer provided (frontend “A”), else derive from name + user id
        const clientDbName = raw.dbName ? raw.dbName.toString().trim() : undefined;
        // ---- Basic validations ----
        if (!planId)
            return res
                .status(400)
                .json({ message: "MISSING_FIELD", field: "planId" });
        // If mode not given, infer: if paymentId present => paid, else trial
        const resolvedMode = mode ?? (paymentId ? "paid" : "trial");
        const corePrisma = (0, container_2.getCorePrisma)();
        // Fetch plan + minUsers
        const plan = await corePrisma.plan.findUnique({ where: { id: planId } });
        if (!plan)
            return res.status(400).json({ message: "INVALID_PLAN" });
        const minUsers = plan.features?.limits?.minUsers ?? 1;
        // Seats resolved later after checking payment meta
        let licensedSeats = minUsers;
        let cycle = null;
        if (resolvedMode === "trial") {
            if (plan.name !== "Starter") {
                return res.status(400).json({ message: "TRIAL_ONLY_STARTER" });
            }
            licensedSeats = minUsers;
            cycle = null;
        }
        else {
            // paid
            if (!paymentId)
                return res.status(400).json({ message: "PAYMENT_ID_REQUIRED" });
            // Fetch payment
            const pay = await corePrisma.payment.findUnique({
                where: { id: paymentId },
            });
            if (!pay)
                return res.status(404).json({ message: "PAYMENT_NOT_FOUND" });
            if (pay.userId !== user.id)
                return res.status(403).json({ message: "PAYMENT_OWNERSHIP_MISMATCH" });
            if (pay.status !== "SUCCESS")
                return res.status(400).json({ message: "PAYMENT_NOT_SUCCESS" });
            if (pay.purpose !== "NEW_SUBSCRIPTION")
                return res.status(400).json({ message: "PAYMENT_WRONG_PURPOSE" });
            const meta = pay.meta ?? {};
            const quotedPlanId = meta.planId;
            const quotedPeriod = meta.period;
            const quotedSeats = Number(meta.seats) || minUsers;
            if (quotedPlanId !== planId)
                return res.status(400).json({ message: "PLAN_MISMATCH" });
            // If client sent a period, it must match; otherwise use the quoted period
            if (period && quotedPeriod && period !== quotedPeriod)
                return res.status(400).json({ message: "PERIOD_MISMATCH" });
            cycle = period ?? quotedPeriod ?? null;
            if (!cycle)
                return res.status(400).json({ message: "PERIOD_REQUIRED" });
            // Seat resolution: default to quoted, but allow client to send (must match to be strict)
            const requestedSeats = Number.isFinite(seats)
                ? Number(seats)
                : quotedSeats;
            licensedSeats = Math.max(requestedSeats, minUsers);
            if (licensedSeats !== quotedSeats) {
                return res.status(400).json({
                    message: "SEAT_MISMATCH",
                    expected: quotedSeats,
                    got: licensedSeats,
                });
            }
        }
        // ---- Ensure tenant migrations exist ----
        const migrationDir = path_1.default.join(__dirname, "../../prisma/org");
        if (!fs_1.default.existsSync(migrationDir) ||
            fs_1.default.readdirSync(migrationDir).length === 0) {
            return res.status(500).json({
                message: "No tenant migrations found. Run `npx prisma migrate dev --schema=prisma/org/org-schema.prisma --name init` first.",
            });
        }
        // ---- Derive a safe dbName (prefer client-provided if valid) ----
        const slug = (s) => s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 32);
        let dbName;
        if (clientDbName) {
            if (!/^[a-zA-Z0-9]+$/.test(clientDbName)) {
                return res.status(400).json({
                    message: "INVALID_DB_NAME",
                    hint: "Use only letters and numbers",
                });
            }
            dbName = clientDbName;
        }
        else {
            const base = slug(name || plan.name || "org") || "org";
            dbName = `${base}_${user.id.slice(0, 8)}_${Date.now()}`;
        }
        // ---- Create org-specific DB (ignore 'already exists') ----
        const dbUser = process.env.DB_USER || "aditijaiswal";
        const dbHost = process.env.DB_CORE_HOST || "localhost";
        const dbPort = process.env.DB_CORE_PORT || "5433";
        const dbPassword = process.env.DB_PASS || "ads4good";
        const sslMode = process.env.NODE_ENV === "production" ? "require" : "prefer";
        // ---- Create org-specific DB using Prisma (more reliable) ----
        try {
            // Connect to the default postgres database to create new database
            const { PrismaClient } = require("@prisma/client");
            const adminPrisma = new PrismaClient({
                datasources: {
                    db: {
                        url: `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/coreDB?sslmode=require&connect_timeout=60`,
                    },
                },
            });
            try {
                // Check if database already exists
                const existingDb = await adminPrisma.$queryRaw `
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `;
                if (Array.isArray(existingDb) && existingDb.length === 0) {
                    // Database doesn't exist, create it
                    await adminPrisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
                    // console.log(`Database ${dbName} created successfully`);
                }
                else {
                    console.warn(`Database ${dbName} already exists. Skipping creation.`);
                }
            }
            finally {
                await adminPrisma.$disconnect();
            }
        }
        catch (dbErr) {
            console.error("Database creation failed:", {
                message: dbErr.message,
                code: dbErr.code,
                dbName,
            });
            throw new Error(`Failed to create database: ${dbErr.message}`);
        }
        // ---- Apply migrations with proper SSL connection ----
        const migrationDbUrl = `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}?sslmode=require&connect_timeout=60`;
        try {
            console.log(`Applying migrations to database: ${dbName}`);
            const schemaPath = path_1.default.join(__dirname, "../../prisma/org/org-schema.prisma");
            // console.log("Schema path:", schemaPath);
            // console.log(
            //   "Target database URL (masked):",
            //   migrationDbUrl.replace(dbPassword, "***")
            // );
            // Create a clean environment with all required variables
            const cleanEnv = {
                PATH: process.env.PATH || "",
                NODE_ENV: process.env.NODE_ENV || "",
                DATABASE_URL: migrationDbUrl,
                DIRECT_URL: migrationDbUrl, // Add this - same as DATABASE_URL for org databases
            };
            const migrationCommand = `npx prisma migrate deploy --schema="${schemaPath}"`;
            // console.log("Running command:", migrationCommand);
            // console.log(
            //   "With clean environment DATABASE_URL:",
            //   migrationDbUrl.replace(dbPassword, "***")
            // );
            const { stdout, stderr } = await execAsync(migrationCommand, {
                env: cleanEnv,
                cwd: process.cwd(),
                timeout: 180000,
                maxBuffer: 1024 * 1024 * 10,
            });
            // console.log("Migration stdout:", stdout);
            if (stderr && !stderr.includes("warn")) {
                console.error("Migration stderr:", stderr);
            }
            console.log(`✅ Migrations applied successfully to ${dbName}`);
        }
        catch (migrationError) {
            console.error("❌ Migration failed:", {
                message: migrationError.message,
                stdout: migrationError.stdout,
                stderr: migrationError.stderr,
                dbName,
            });
            // Cleanup failed database
            try {
                await corePrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
                console.log(`🧹 Cleaned up failed database: ${dbName}`);
            }
            catch (cleanupErr) {
                console.error("Failed to cleanup database:", cleanupErr.message);
            }
            throw new Error(`Migration failed for database ${dbName}: ${migrationError.message}`);
        }
        // ---- Upload logo (if file provided by Multer) ----
        let logoUrl;
        if (req.file) {
            const extension = path_1.default.extname(req.file.originalname || "") || ".png";
            const fileName = `org_logos/${Date.now()}-${(0, crypto_1.randomUUID)()}${extension}`;
            await spaces_1.spaces.send(new client_s3_1.PutObjectCommand({
                Bucket: process.env.SPACES_BUCKET,
                Key: fileName,
                Body: req.file.buffer,
                ContentType: req.file.mimetype || "image/png",
            }));
            logoUrl = fileName; // save only key in DB
        }
        // ---- Compute subscription dates ----
        const now = new Date();
        const addDays = (d, days) => new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
        const addMonths = (d, months) => {
            const x = new Date(d);
            const m = x.getMonth() + months;
            x.setMonth(m);
            if (x.getMonth() !== ((m % 12) + 12) % 12)
                x.setDate(0);
            return x;
        };
        const startDate = now;
        const endDate = resolvedMode === "trial"
            ? addDays(now, 30)
            : cycle === "YEARLY"
                ? addMonths(now, 12)
                : addMonths(now, 3);
        // ---- Write central records in a single transaction ----
        const { org, subscription } = await corePrisma.$transaction(async (tx) => {
            const organization = await tx.organization.create({
                data: {
                    name: name || dbName,
                    dbName,
                    ownerId: user.id,
                    logoUrl,
                    industry,
                },
            });
            const sub = await tx.subscription.create({
                data: {
                    orgId: organization.id,
                    planId,
                    status: "ACTIVE",
                    startDate,
                    endDate,
                    userCount: licensedSeats,
                    billingCycle: resolvedMode === "trial" ? null : cycle, // null for trial
                    isTrial: resolvedMode === "trial",
                    graceUntil: null,
                    cancelAtPeriodEnd: false,
                },
            });
            if (resolvedMode === "paid" && paymentId) {
                await tx.payment.update({
                    where: { id: paymentId },
                    data: { subscriptionId: sub.id },
                });
            }
            await tx.user.update({
                where: { id: user.id },
                data: { orgId: organization.id },
            });
            return { org: organization, subscription: sub };
        });
        // ---- Mint JWT with orgId ----
        const token = jsonwebtoken_1.default.sign({
            id: user.id,
            email: user.email,
            orgId: org.id,
            role: user.role,
        }, process.env.JWT_SECRET || "supersecret", { expiresIn: "7d" });
        // ---- Smoke test org DB connectivity ----
        const orgPrisma = await (0, container_1.getOrgPrisma)(org.id);
        await orgPrisma.$queryRaw `SELECT 1`;
        return res.status(201).json({
            message: "Organization created",
            org,
            subscriptionId: subscription.id,
            user: { ...user, orgId: org.id },
            token,
        });
    }
    catch (error) {
        console.error("Error creating organization:", {
            message: error.message,
            code: error.code,
            stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
            userId: req.user?.id,
            dbName: req.body.dbName,
        });
        // Return more specific error messages
        if (error.message?.includes("connection") ||
            error.message?.includes("SSL")) {
            return res.status(500).json({
                message: "Database connection failed. Please check network configuration.",
            });
        }
        return res.status(500).json({ message: "Internal Server Error" });
    }
};
exports.createOrganization = createOrganization;
const getOrganizationDetails = async (req, res) => {
    try {
        const corePrisma = (0, container_2.getCorePrisma)();
        if (!req.user?.orgId) {
            return res.status(400).json({ message: "No organization assigned" });
        }
        const org = await corePrisma.organization.findUnique({
            where: { id: req.user.orgId },
            select: {
                name: true,
                logoUrl: true,
            },
        });
        if (!org) {
            return res.status(404).json({ message: "Organization not found" });
        }
        // Generate signed URL for logo if exists
        if (org.logoUrl) {
            org.logoUrl = await (0, spacesUtils_1.getCachedFileUrlFromSpaces)(org.logoUrl, req.user.orgId, 60 * 60);
        }
        res.json(org);
    }
    catch (err) {
        console.error("Error fetching org details:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};
exports.getOrganizationDetails = getOrganizationDetails;
const getDailyProgress = async (req, res) => {
    const corePrisma = (0, container_2.getCorePrisma)();
    if (!req.user?.orgId || req.user.role !== "ADMIN") {
        return res.status(403).json({ message: "Forbidden" });
    }
    const { start: startStr, end: endStr } = (req.query ?? {});
    try {
        const orgPrisma = await (0, container_1.getOrgPrisma)(req.user.orgId);
        if (!orgPrisma) {
            console.error("getDailyProgress: orgPrisma unavailable", {
                orgId: req.user.orgId,
            });
            return res.status(500).json({ message: "Org database unavailable" });
        }
        // --- date helpers (inclusive day bounds, UTC) ---
        const parseDateUnsafe = (d) => (d ? new Date(d) : undefined);
        const toUtcDayStart = (d) => {
            const x = new Date(d);
            x.setUTCHours(0, 0, 0, 0);
            return x;
        };
        const toUtcDayEnd = (d) => {
            const x = new Date(d);
            x.setUTCHours(23, 59, 59, 999);
            return x;
        };
        const startRaw = parseDateUnsafe(startStr);
        const endRaw = parseDateUnsafe(endStr);
        const startAt = startRaw ? toUtcDayStart(startRaw) : undefined;
        const endAt = endRaw ? toUtcDayEnd(endRaw) : undefined;
        if (startAt && endAt && startAt > endAt) {
            return res.status(400).json({ message: "Invalid range: start > end" });
        }
        // ✅ Filter only on fields that exist in your schema
        const whereClause = startAt && endAt
            ? {
                OR: [
                    { startDate: { gte: startAt, lte: endAt } }, // started in range
                    { completedAt: { gte: startAt, lte: endAt } }, // completed in range
                    {
                        AND: [
                            // fallback: completed w/o completedAt
                            { isCompleted: true },
                            {
                                OR: [
                                    { dueDate: { gte: startAt, lte: endAt } },
                                    { startDate: { gte: startAt, lte: endAt } },
                                ],
                            },
                        ],
                    },
                ],
            }
            : {};
        // Pull occurrences (no relation includes)
        const occs = await orgPrisma.taskOccurrence.findMany({
            where: whereClause,
            select: {
                id: true,
                title: true,
                startDate: true,
                dueDate: true,
                status: true,
                isCompleted: true,
                completedAt: true,
                assignedToId: true,
                projectId: true,
            },
            orderBy: { startDate: "asc" },
        });
        // Fetch project names for occurrences’ projectIds
        const projectIds = [
            ...new Set(occs.map((o) => o.projectId).filter(Boolean)),
        ];
        let projectMap = {};
        if (projectIds.length) {
            const projects = await orgPrisma.project.findMany({
                where: { id: { in: projectIds } },
                select: { id: true, name: true },
            });
            projectMap = Object.fromEntries(projects.map((p) => [p.id, p]));
        }
        // Fetch user names from core DB (optional, for employeePerformance labels)
        const userIds = [
            ...new Set(occs.map((o) => o.assignedToId).filter(Boolean)),
        ];
        let userMap = {};
        if (userIds.length) {
            const users = await corePrisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, name: true, email: true },
            });
            userMap = Object.fromEntries(users.map((u) => [u.id, u]));
        }
        // Helpers
        const isOccCompleted = (o) => o?.isCompleted === true ||
            String(o?.status || "").toUpperCase() === "COMPLETED";
        const completionAnchor = (o) => (o?.completedAt ? new Date(o.completedAt) : null) ||
            (o?.dueDate ? new Date(o.dueDate) : null) ||
            (o?.startDate ? new Date(o.startDate) : null);
        const inRange = (d) => {
            if (!d)
                return false;
            if (startAt && endAt) {
                const t = d.getTime();
                return t >= startAt.getTime() && t <= endAt.getTime();
            }
            return true;
        };
        // Aggregations
        const projectProgress = {};
        const dailyTrend = {};
        const employeePerformance = {};
        for (const o of occs) {
            const projName = o.projectId
                ? projectMap[o.projectId]?.name ?? null
                : null;
            const completed = isOccCompleted(o);
            // Project Progress
            if (projName) {
                if (!projectProgress[projName]) {
                    projectProgress[projName] = {
                        project: projName,
                        total: 0,
                        completed: 0,
                    };
                }
                projectProgress[projName].total += 1;
                if (completed)
                    projectProgress[projName].completed += 1;
            }
            // Daily Trend
            let startKey = null;
            if (o.startDate) {
                const sDate = new Date(o.startDate);
                if (inRange(sDate)) {
                    startKey = sDate.toISOString().split("T")[0];
                    if (!dailyTrend[startKey])
                        dailyTrend[startKey] = { date: startKey, total: 0, completed: 0 };
                    dailyTrend[startKey].total += 1;
                }
            }
            if (completed) {
                const cDate = completionAnchor(o);
                if (cDate && inRange(cDate)) {
                    const compKey = cDate.toISOString().split("T")[0];
                    if (!dailyTrend[compKey])
                        dailyTrend[compKey] = { date: compKey, total: 0, completed: 0 };
                    dailyTrend[compKey].completed += 1;
                    if (compKey !== startKey)
                        dailyTrend[compKey].total += 1;
                }
            }
            // Employee Performance
            const uid = o.assignedToId;
            if (uid) {
                if (!employeePerformance[uid]) {
                    const u = userMap[uid];
                    employeePerformance[uid] = {
                        userId: uid,
                        name: u?.name || "Unknown",
                        total: 0,
                        completed: 0,
                    };
                }
                employeePerformance[uid].total += 1;
                if (completed)
                    employeePerformance[uid].completed += 1;
            }
        }
        const withRate = (arr) => arr.map((x) => ({
            ...x,
            total: Number(x.total || 0),
            completed: Number(x.completed || 0),
            completionRate: x.total ? Math.round((x.completed / x.total) * 100) : 0,
        }));
        const taskTrendArr = withRate(Object.values(dailyTrend).sort((a, b) => a.date.localeCompare(b.date)));
        const projectProgressArr = withRate(Object.values(projectProgress));
        const employeePerformanceArr = withRate(Object.values(employeePerformance));
        return res.json({
            projectProgress: projectProgressArr,
            taskTrend: taskTrendArr,
            employeePerformance: employeePerformanceArr,
        });
    }
    catch (err) {
        console.error("Error fetching daily progress dashboard:", {
            userId: req.user?.id,
            orgId: req.user?.orgId,
            start: startStr,
            end: endStr,
            message: err?.message,
            code: err?.code,
            stack: err?.stack,
        });
        const isDev = process.env.NODE_ENV !== "production";
        return res.status(500).json({
            message: isDev
                ? err?.message || "Internal server error"
                : "Internal server error",
        });
    }
};
exports.getDailyProgress = getDailyProgress;
