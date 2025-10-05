import { prisma as corePrisma } from "../prisma/coreClient";
import { PrismaClient as OrgPrismaClient } from "../../prisma/generated/org-client";

const orgClientsCache: Record<string, OrgPrismaClient> = {};

function getOrgDbUrl(dbName: string) {
  return `postgresql://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}:${process.env.DB_PORT}/${dbName}?schema=public`;
}

export async function getOrgPrismaClient(
  orgId: string
): Promise<OrgPrismaClient> {
  if (!orgId) throw new Error("Org ID is required");

  if (orgClientsCache[orgId]) return orgClientsCache[orgId];

  const org = await corePrisma.organization.findUnique({
    where: { id: orgId },
  });
  if (!org) throw new Error(`Organization ${orgId} not found`);
  if (!org.dbName) throw new Error(`Organization ${orgId} DB not configured`);

  const prismaClient = new OrgPrismaClient({
    datasources: { db: { url: getOrgDbUrl(org.dbName) } },
  });

  try {
    await prismaClient.$connect();
  } catch (err) {
    console.error(`Failed to connect to org DB ${org.dbName}:`, err);
    throw err;
  }

  orgClientsCache[orgId] = prismaClient;
  return prismaClient;
}

export function disconnectOrgClients() {
  for (const client of Object.values(orgClientsCache)) {
    client.$disconnect().catch(console.error);
  }
}
