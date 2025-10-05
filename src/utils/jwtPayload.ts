// src/utils/jwtPayload.ts
export type JwtUserPayload = {
  id: string;
  role: "ADMIN" | "EMPLOYEE" | "MANAGER";
  orgId: string | null; // may be null before org creation
};

export function buildJwtPayload(user: {
  id: string;
  role: "ADMIN" | "EMPLOYEE" | "MANAGER";
  orgId: string | null;
}): JwtUserPayload {
  return { id: user.id, role: user.role, orgId: user.orgId ?? null };
}
