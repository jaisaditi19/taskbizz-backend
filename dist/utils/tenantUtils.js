"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrgPrismaClient = getOrgPrismaClient;
exports.disconnectOrgClients = disconnectOrgClients;
const coreClient_1 = require("../prisma/coreClient");
const org_client_1 = require("../../prisma/generated/org-client");
const orgClientsCache = {};
function getOrgDbUrl(dbName) {
    return `postgresql://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}:${process.env.DB_PORT}/${dbName}?schema=public`;
}
async function getOrgPrismaClient(orgId) {
    if (!orgId)
        throw new Error("Org ID is required");
    if (orgClientsCache[orgId])
        return orgClientsCache[orgId];
    const org = await coreClient_1.prisma.organization.findUnique({
        where: { id: orgId },
    });
    if (!org)
        throw new Error(`Organization ${orgId} not found`);
    if (!org.dbName)
        throw new Error(`Organization ${orgId} DB not configured`);
    const prismaClient = new org_client_1.PrismaClient({
        datasources: { db: { url: getOrgDbUrl(org.dbName) } },
    });
    try {
        await prismaClient.$connect();
    }
    catch (err) {
        console.error(`Failed to connect to org DB ${org.dbName}:`, err);
        throw err;
    }
    orgClientsCache[orgId] = prismaClient;
    return prismaClient;
}
function disconnectOrgClients() {
    for (const client of Object.values(orgClientsCache)) {
        client.$disconnect().catch(console.error);
    }
}
