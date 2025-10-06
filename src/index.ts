// src/index.ts
import http from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { authenticate } from "./middlewares/auth";
import { attachSocket } from "./realtime/socket";

// DI & Prisma
import { PrismaClient } from "@prisma/client";
import { registerCorePrisma, registerOrgPrismaFactory } from "./di/container";
import { createOrgPrismaFactory } from "./di/orgPrismaFactory";
import { orgMiddleware } from "./middlewares/orgMiddleware";

// Routes Import
import authRoutes from "./routes/auth";
import paymentRoutes from "./routes/payment";
import organizationRoutes from "./routes/org";
import userRoutes from "./routes/user";
import clientRoutes from "./routes/client";
import projectRoutes from "./routes/project";
import taskRoutes from "./routes/task";
import planRoutes from "./routes/plan";
import calendarEntryRoutes from "./routes/calendarEntryRoutes";
import calendarEventsRoutes from "./routes/calendarEventsRoutes";
import billingRoutes from "./routes/billing";
import notificationRoutes from "./routes/notification";
import chatRoutes from "./routes/chat";
import pincodeRoute from "./routes/pincode";
import leaveRoutes from "./routes/leave";
import licenseRoutes from "./routes/license";

// Jobs / other middlewares
import "./jobs/cleanup";
import "./jobs/cronMailer";
import { attachSubscriptionContext } from "./middlewares/subscription";

dotenv.config();
const app = express();

// ---------- CORS ----------
const allowedOrigins = process.env.WEB_ORIGIN?.split(",").map((o) =>
  o.trim()
) ?? ["http://localhost:5173", "https://portal.taskbizz.com"];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  optionsSuccessStatus: 200,
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control"],
};

// Apply normal CORS middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// ---------- Manual catch-all for OPTIONS (Express 5 safe) ----------
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Origin", req.headers.origin || "");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Cache-Control"
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    return res.sendStatus(204);
  }
  next();
});

// ---------- HTTP + Socket ----------
const server = http.createServer(app);
const io = attachSocket(server);

// expose io on req
declare global {
  namespace Express {
    interface Request {
      io: typeof io;
      orgPrisma?: any;
    }
  }
}
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// ------------------- DI: Core Prisma + Org Factory -------------------
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  var __core_prisma__: PrismaClient | undefined;
}

const corePrisma =
  global.__core_prisma__ ??
  new PrismaClient({
    log: ["warn", "error", "info"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__core_prisma__ = corePrisma;
}

async function initPrismaAndFactories() {
  await corePrisma.$connect();
  registerCorePrisma(corePrisma);
  const orgFactory = createOrgPrismaFactory(corePrisma);
  registerOrgPrismaFactory(orgFactory);
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
app.use("/api/auth", authRoutes);
app.use("/api/pincode", pincodeRoute);

// ---------- Auth + Subscription (protected) ----------
app.use(authenticate);
app.use(orgMiddleware);
app.use(attachSubscriptionContext);

// ---------- Routes (protected) ----------
app.use("/api/payment", paymentRoutes);
app.use("/api/org", organizationRoutes);
app.use("/api/user", userRoutes);
app.use("/api/client", clientRoutes);
app.use("/api/project", projectRoutes);
app.use("/api/task", taskRoutes);
app.use("/api/plan", planRoutes);
app.use("/api/calendar/entries", calendarEntryRoutes);
app.use("/api/calendar/events", calendarEventsRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/notification", notificationRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/licenses", licenseRoutes);

// ---------- Start server & graceful shutdown ----------
const PORT = process.env.PORT || 8080;

initPrismaAndFactories()
  .then(({ orgFactory }) => {
    server.listen(PORT, () =>
      console.log(`Server running on port ${PORT} (pid=${process.pid})`)
    );

    const shutdown = async () => {
      console.log("Shutting down server...");
      server.close();

      try {
        await corePrisma.$disconnect();
      } catch (e) {
        console.error("Error disconnecting core prisma", e);
      }

      try {
        await orgFactory.disconnectAll();
      } catch (e) {
        console.error("Error disconnecting org clients", e);
      }

      setTimeout(() => process.exit(0), 200);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("uncaughtException", (err) => {
      console.error("uncaughtException:", err);
      shutdown();
    });
    process.on("unhandledRejection", (reason) => {
      console.error("unhandledRejection:", reason);
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize Prisma or factories:", err);
    process.exit(1);
  });
