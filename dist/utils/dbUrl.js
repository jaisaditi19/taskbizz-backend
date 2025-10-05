"use strict";
// src/utils/dbUrl.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrgDbUrl = getOrgDbUrl;
function getOrgDbUrl(dbName) {
    if (!dbName) {
        throw new Error("dbName is required to build org DB URL");
    }
    const user = process.env.DB_USER;
    const pass = process.env.DB_PASS;
    const host = process.env.DB_HOST;
    const port = process.env.DB_PORT || "5432";
    if (!user || !pass || !host) {
        throw new Error("Database credentials (DB_USER, DB_PASS, DB_HOST) are not set");
    }
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${dbName}?pgbouncer=true&schema=public&connect_timeout=15`;
}
