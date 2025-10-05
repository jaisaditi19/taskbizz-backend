// src/di/container.ts
import { PrismaClient } from "@prisma/client";
import type { PrismaClient as OrgPrismaClient } from "../../prisma/generated/org-client";
import type { LRUCache } from "lru-cache";

// Function form: (orgId) => Promise<OrgPrismaClient>
export type OrgFactoryFn = (orgId: string) => Promise<OrgPrismaClient>;

// Object factory form returned by createOrgPrismaFactory(...)
export type OrgFactoryObject = {
  getOrgPrismaClient: OrgFactoryFn;
  invalidateOrgMeta?: (orgId: string) => Promise<void> | void;
  disconnectAll?: () => Promise<void>;
  _cache?: LRUCache<string, OrgPrismaClient> | unknown;
};

export type OrgFactory = OrgFactoryFn | OrgFactoryObject;

const container: {
  corePrisma?: PrismaClient;
  getOrgPrisma?: OrgFactoryFn;
  invalidateOrgMeta?: (orgId: string) => Promise<void> | void;
  _orgFactory?: OrgFactoryObject | null;
} = {
  _orgFactory: null,
};

export function registerCorePrisma(p: PrismaClient) {
  container.corePrisma = p;
}

export function getCorePrisma(): PrismaClient {
  if (!container.corePrisma) throw new Error("Core Prisma not registered");
  return container.corePrisma;
}

/**
 * Register either:
 *  - a function (orgId => Promise<OrgPrismaClient>) OR
 *  - the full factory object returned by createOrgPrismaFactory()
 *
 * The implementation accepts both shapes and normalizes into container.getOrgPrisma + invalidateOrgMeta.
 */
export function registerOrgPrismaFactory(factory: OrgFactory) {
  if (!factory) throw new Error("Org factory is required");

  if (typeof factory === "function") {
    // function form
    container.getOrgPrisma = factory;
    container.invalidateOrgMeta = undefined;
    container._orgFactory = null;
  } else {
    // object form
    // defensive binding in case methods are not bound
    container.getOrgPrisma = factory.getOrgPrismaClient.bind(factory);
    container.invalidateOrgMeta = factory.invalidateOrgMeta
      ? factory.invalidateOrgMeta.bind(factory)
      : undefined;
    container._orgFactory = factory;
  }
}

export function getOrgPrisma(orgId: string) {
  if (!container.getOrgPrisma)
    throw new Error("Org Prisma factory not registered");
  return container.getOrgPrisma(orgId);
}

/**
 * Invalidate cached org metadata / evict client for an org.
 * Throws if not available.
 */
export async function invalidateOrgMeta(orgId: string): Promise<void> {
  if (!container.invalidateOrgMeta)
    throw new Error(
      "invalidateOrgMeta not available. Register a full org factory to enable it."
    );
  // ensure we await if the registered fn returns a promise
  await container.invalidateOrgMeta(orgId);
}

/** Optional: expose the underlying org factory (for diagnostics) */
export function getRegisteredOrgFactory(): OrgFactoryObject | null {
  return container._orgFactory ?? null;
}
