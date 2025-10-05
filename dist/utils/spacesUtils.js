"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadLicenseToSpaces = uploadLicenseToSpaces;
exports.uploadFileToSpaces = uploadFileToSpaces;
exports.getFileUrlFromSpaces = getFileUrlFromSpaces;
exports.deleteFileFromSpaces = deleteFileFromSpaces;
exports.getCachedFileUrlFromSpaces = getCachedFileUrlFromSpaces;
// src/utils/spacesUtils.ts
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const cache_1 = require("./cache");
// ✅ Use one naming scheme. Here I standardize on SPACES_*.
const spacesClient = new client_s3_1.S3Client({
    region: process.env.SPACES_REGION || "nyc3",
    credentials: {
        accessKeyId: process.env.SPACES_KEY || "",
        secretAccessKey: process.env.SPACES_SECRET || "",
    },
    endpoint: process.env.SPACES_ENDPOINT || undefined,
    forcePathStyle: false,
});
const BUCKET = process.env.SPACES_BUCKET;
async function uploadWithPrefix(file, { prefix, contentType, inline = true }) {
    const ext = path_1.default.extname(file.originalname || "").toLowerCase();
    const key = `${prefix}/${(0, crypto_1.randomUUID)()}${ext || ""}`;
    await spacesClient.send(new client_s3_1.PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: contentType ?? file.mimetype ?? "application/octet-stream",
        ACL: "private",
        // ✅ Helps in-tab preview (PDF/image/video)
        ContentDisposition: inline ? "inline" : undefined,
        CacheControl: "private, max-age=0, no-cache",
    }));
    return key;
}
// ---- License-specific uploader (wraps the generic) ----
async function uploadLicenseToSpaces(file, orgId) {
    if (!orgId) {
        // You can also default to "global" if you prefer:
        // orgId = "global";
        throw new Error("orgId required for license upload");
    }
    const prefix = `licenses/${orgId}`;
    return uploadWithPrefix(file, {
        prefix,
        contentType: file.mimetype,
        inline: true,
    });
}
// (Keep the old one only if other features need `tasks/` uploads; otherwise delete it)
async function uploadFileToSpaces(file, orgId) {
    const prefix = `tasks/${orgId ?? "global"}`;
    return uploadWithPrefix(file, {
        prefix,
        contentType: file.mimetype,
        inline: true,
    });
}
async function getFileUrlFromSpaces(key, expiresInSeconds = 3600) {
    const cmd = new client_s3_1.GetObjectCommand({ Bucket: BUCKET, Key: key });
    return (0, s3_request_presigner_1.getSignedUrl)(spacesClient, cmd, { expiresIn: expiresInSeconds });
}
async function deleteFileFromSpaces(key) {
    await spacesClient.send(new client_s3_1.DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
async function getCachedFileUrlFromSpaces(key, orgId, urlTtlSeconds = 3600) {
    const cacheKey = (0, cache_1.orgKey)(orgId, "spacesurl", encodeURIComponent(key));
    const cached = await (0, cache_1.cacheGetJson)(cacheKey);
    if (cached)
        return cached;
    const url = await getFileUrlFromSpaces(key, urlTtlSeconds);
    // leave some margin so cached URL doesn't expire right after retrieval
    const ttl = Math.max(30, urlTtlSeconds - 60);
    await (0, cache_1.cacheSetJson)(cacheKey, url, ttl);
    return url;
}
