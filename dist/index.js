"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts
const http_1 = __importDefault(require("http"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const dotenv_1 = __importDefault(require("dotenv"));
const auth_1 = require("./middlewares/auth");
const socket_1 = require("./realtime/socket");
// DI & Prisma
const client_1 = require("@prisma/client");
const container_1 = require("./di/container");
const orgPrismaFactory_1 = require("./di/orgPrismaFactory");
const orgMiddleware_1 = require("./middlewares/orgMiddleware"); // path you used earlier
// Routes Import
const auth_2 = __importDefault(require("./routes/auth"));
const payment_1 = __importDefault(require("./routes/payment"));
const org_1 = __importDefault(require("./routes/org"));
const user_1 = __importDefault(require("./routes/user"));
const client_2 = __importDefault(require("./routes/client"));
const project_1 = __importDefault(require("./routes/project"));
const task_1 = __importDefault(require("./routes/task"));
const plan_1 = __importDefault(require("./routes/plan"));
// import eventRoutes from "./routes/event";
const calendarEntryRoutes_1 = __importDefault(require("./routes/calendarEntryRoutes"));
const calendarEventsRoutes_1 = __importDefault(require("./routes/calendarEventsRoutes"));
const billing_1 = __importDefault(require("./routes/billing"));
const notification_1 = __importDefault(require("./routes/notification"));
const chat_1 = __importDefault(require("./routes/chat"));
const pincode_1 = __importDefault(require("./routes/pincode"));
const leave_1 = __importDefault(require("./routes/leave"));
const license_1 = __importDefault(require("./routes/license"));
// Jobs / other middlewares
require("./jobs/cleanup");
require("./jobs/cronMailer");
const subscription_1 = require("./middlewares/subscription");
dotenv_1.default.config();
const app = (0, express_1.default)();
// ---------- CORS ----------
const allowedOrigins = process.env.WEB_ORIGIN?.split(",").map((o) => o.trim()) ?? ["http://localhost:5173", "https://portal.taskbizz.com"];
const corsOptions = {
    origin: allowedOrigins,
    credentials: true,
    optionsSuccessStatus: 200,
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control"],
};
app.use((0, cors_1.default)(corsOptions));
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
// ---------- HTTP + Socket ----------
const server = http_1.default.createServer(app);
const io = (0, socket_1.attachSocket)(server);
app.use((req, _res, next) => {
    req.io = io;
    next();
});
const corePrisma = global.__core_prisma__ ??
    new client_1.PrismaClient({
        log: ["warn", "error", "info"],
    });
if (process.env.NODE_ENV !== "production") {
    global.__core_prisma__ = corePrisma;
}
async function initPrismaAndFactories() {
    await corePrisma.$connect();
    // register core prisma in your tiny container
    (0, container_1.registerCorePrisma)(corePrisma);
    // create the org factory (LRU) and register the resolver function in the container
    const orgFactory = (0, orgPrismaFactory_1.createOrgPrismaFactory)(corePrisma);
    // If your container expects a function, register the getOrgPrismaClient
    (0, container_1.registerOrgPrismaFactory)(orgFactory);
    return { orgFactory };
}
// ---------- Health & root ----------
app.get("/", (_req, res) => {
    res.json({
        message: "TaskBizz API is running!",
        status: "success",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
    });
});
app.get("/health", (_req, res) => {
    res.status(200).json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
    });
});
// ---------- Routes (public) ----------
app.use("/api/auth", auth_2.default);
app.use("/api/pincode", pincode_1.default);
// ---------- Auth + Subscription (protected) ----------
app.use(auth_1.authenticate);
app.use(orgMiddleware_1.orgMiddleware);
app.use(subscription_1.attachSubscriptionContext);
// ---------- Org middleware (resolve org prisma lazily) ----------
// Place this AFTER authenticate so you can derive orgId from req.user.
// It will set req.orgPrisma when an orgId is present (or you can call getOrgPrisma manually)
// ---------- Routes (protected) ----------
app.use("/api/payment", payment_1.default);
app.use("/api/org", org_1.default);
app.use("/api/user", user_1.default);
app.use("/api/client", client_2.default);
app.use("/api/project", project_1.default);
app.use("/api/task", task_1.default);
app.use("/api/plan", plan_1.default);
app.use("/api/calendar/entries", calendarEntryRoutes_1.default);
app.use("/api/calendar/events", calendarEventsRoutes_1.default);
app.use("/api/billing", billing_1.default);
app.use("/api/notification", notification_1.default);
app.use("/api/chat", chat_1.default);
app.use("/api/leaves", leave_1.default);
app.use("/api/licenses", license_1.default);
// ---------- Start server & graceful shutdown ----------
const PORT = process.env.PORT || 8080;
initPrismaAndFactories()
    .then(({ orgFactory }) => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT} (pid=${process.pid})`));
    const shutdown = async () => {
        console.log("Shutting down server...");
        server.close();
        try {
            // disconnect core prisma
            await corePrisma.$disconnect();
        }
        catch (e) {
            console.error("Error disconnecting core prisma", e);
        }
        try {
            // disconnect all org clients
            await orgFactory.disconnectAll();
        }
        catch (e) {
            console.error("Error disconnecting org clients", e);
        }
        // allow some time for logs to flush then exit
        setTimeout(() => process.exit(0), 200);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // in case of uncaught exceptions, try to shutdown cleanly
    process.on("uncaughtException", (err) => {
        console.error("uncaughtException:", err);
        shutdown();
    });
    process.on("unhandledRejection", (reason) => {
        console.error("unhandledRejection:", reason);
        // don't call shutdown immediately for rejections — but log for now
        process.exit(1);
    });
})
    .catch((err) => {
    console.error("Failed to initialize Prisma or factories:", err);
    process.exit(1);
});
