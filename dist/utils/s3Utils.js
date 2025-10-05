"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadFileToS3 = uploadFileToS3;
exports.getFileUrlFromS3 = getFileUrlFromS3;
exports.deleteFileFromS3 = deleteFileFromS3;
exports.getCachedFileUrlFromS3 = getCachedFileUrlFromS3;
exports.invalidateS3Url = invalidateS3Url;
// src/utils/s3Utils.ts
const s3_1 = require("../config/s3");
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const cache_1 = require("./cache");
// Upload a single file buffer to S3
async function uploadFileToS3(file, orgId) {
    const key = `tasks/${orgId}/${Date.now()}-${file.originalname}`;
    const command = new client_s3_1.PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
    });
    await s3_1.s3.send(command);
    return key;
}
// Get a signed URL for a file key
async function getFileUrlFromS3(key) {
    const command = new client_s3_1.GetObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
    });
    const url = await (0, s3_request_presigner_1.getSignedUrl)(s3_1.s3, command, { expiresIn: 3600 }); // 1 hour
    return url;
}
// Delete a file from S3
async function deleteFileFromS3(key) {
    const command = new client_s3_1.DeleteObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
    });
    await s3_1.s3.send(command);
}
async function getCachedFileUrlFromS3(key, orgId, urlTtlSeconds = 60 * 60 // assuming presigned URLs valid 1 hour
) {
    const cacheKey = (0, cache_1.orgKey)(orgId, "s3url", encodeURIComponent(key));
    const cached = await (0, cache_1.cacheGetJson)(cacheKey);
    if (cached)
        return cached;
    // call your existing function (rename as needed)
    // if your function is in the same file and named getFileUrlFromS3, call it directly
    const url = await getFileUrlFromS3(key);
    // cache slightly less than real expiry
    const ttl = Math.max(30, urlTtlSeconds - 60);
    await (0, cache_1.cacheSetJson)(cacheKey, url, ttl);
    return url;
}
/**
 * Invalidate a specific s3 url (use when deleting an attachment)
 */
async function invalidateS3Url(key, orgId) {
    const cacheKey = (0, cache_1.orgKey)(orgId, "s3url", encodeURIComponent(key));
    try {
        await (0, cache_1.cacheSetJson)(cacheKey, null, 1); // cheap overwrite then delete is fine
    }
    catch (e) {
        // best-effort
        try {
            await (0, cache_1.cacheDel)(cacheKey);
        }
        catch { }
    }
}
