import { Request, Response, NextFunction } from "express";
// import {prisma} from "../prisma/coreClient";
import { getCorePrisma } from "../di/container";

export const authorize = (role: "ADMIN" | "EMPLOYEE") => {
  return async (req: any, res: Response, next: NextFunction) => {
    const prisma = await getCorePrisma();
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

export const authorizeAny = (
  roles: Array<"ADMIN" | "MANAGER" | "EMPLOYEE">
) => {
  return async (req: any, res: Response, next: NextFunction) => {
    const prisma = await getCorePrisma();
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    if (user.status !== "ACTIVE")
      return res.status(403).json({ message: "Account not active" });
    if (!roles.includes(user.role as any))
      return res.status(403).json({ message: "Forbidden" });
    req.currentUser = user; // cache for downstream policies
    next();
  };
};