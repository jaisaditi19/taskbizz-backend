import { Role } from "@prisma/client";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import redisClient from "../config/redisClient";

export const authenticate = async (
  req: Request & { user?: any },
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Check if token is blacklisted
    const isBlacklisted = await redisClient.get(`blacklist_${token}`);
    if (isBlacklisted) {
      return res
        .status(401)
        .json({ message: "Token is invalidated (logged out)" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      id: string;
      name: string;
      email: string;
      role: Role;
      password: string;
      phone: string | null;
      orgId: string | null;
    };

    req.user = decoded;

    // console.log("Authenticated user:", req.user);
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};