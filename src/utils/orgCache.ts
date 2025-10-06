// src/utils/orgCache.ts
import redisClient from "../config/redisClient";
import { getCorePrisma } from "../di/container";

const ORG_SNAPSHOT_TTL = 60 * 10; // 10 minutes
const USER_ORG_TTL = 60 * 60 * 24; // 24 hours

export type OrgSnapshot = {
  id: string;
  name: string;
  status?: string | null;
  logoUrl?: string | null;
};

function orgKey(orgId: string) {
  return `org:snap:${orgId}`;
}
function userOrgKey(userId: string) {
  return `user:${userId}:org`;
}

export async function cacheUserOrgPointer(
  userId: string,
  orgId: string | null
) {
  if (!orgId) {
    await redisClient.del(userOrgKey(userId)).catch(() => {});
    return;
  }
  await redisClient.set(userOrgKey(userId), orgId, { EX: USER_ORG_TTL });
}

export async function getCachedUserOrgId(
  userId: string
): Promise<string | null> {
  try {
    const v = await redisClient.get(userOrgKey(userId));
    return v ?? null;
  } catch {
    return null;
  }
}

export async function getOrgSnapshot(
  orgId: string
): Promise<OrgSnapshot | null> {
  // 1) Try cache
  try {
    const raw = await redisClient.get(orgKey(orgId));
    if (raw) return JSON.parse(raw) as OrgSnapshot;
  } catch {
    // ignore redis errors
  }

  // 2) Fallback DB (no `plan` select)
  const prisma = getCorePrisma();
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, logoUrl: true },
  });
  if (!org) return null;

  const snap: OrgSnapshot = {
    id: org.id,
    name: org.name,
    logoUrl: org.logoUrl ?? null,
  };

  // 3) Write-through cache
  try {
    await redisClient.set(orgKey(orgId), JSON.stringify(snap), {
      EX: ORG_SNAPSHOT_TTL,
    });
  } catch {
    // ignore
  }

  return snap;
}

export async function primeOrgSnapshot(orgId: string) {
  await getOrgSnapshot(orgId);
}

export async function invalidateOrgSnapshot(orgId: string) {
  try {
    await redisClient.del(orgKey(orgId));
  } catch {
    // ignore
  }
}
