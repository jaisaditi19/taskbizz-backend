"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildJwtPayload = buildJwtPayload;
function buildJwtPayload(user) {
    return { id: user.id, role: user.role, orgId: user.orgId ?? null };
}
