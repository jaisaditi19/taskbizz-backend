import { Role } from "@prisma/client";
import type { SubscriptionCtx } from "../shared/subscription";
import type { Server as SocketIOServer } from "socket.io";

declare global {
  namespace Express {
    interface Request {
      io: SocketIOServer;
      user?: {
        id: string;
        name?: string;
        email?: string;
        role?: Role;
        password?: string;
        orgId?: string;
        panNumber?: string;
      };
      subscriptionCtx?: SubscriptionCtx;
    }
  }
}

export {};
