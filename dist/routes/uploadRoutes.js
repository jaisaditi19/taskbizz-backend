"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/uploadRoutes.ts
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const s3 = new client_s3_1.S3Client({
    region: process.env.SPACES_REGION, // e.g. "ap-south-1"
    endpoint: process.env.SPACES_ENDPOINT, // e.g. "https://nyc3.digitaloceanspaces.com"
    credentials: {
        accessKeyId: process.env.SPACES_KEY,
        secretAccessKey: process.env.SPACES_SECRET,
    },
});
router.post("/presign", async (req, res) => {
    try {
        const { fileName, contentType, size } = req.body;
        // Guardrails (adjust limits)
        if (!fileName || !contentType)
            return res.status(400).json({ error: "fileName, contentType required" });
        if (size > 25 * 1024 * 1024)
            return res.status(413).json({ error: "Max 25MB per file" });
        // Key format: org/user/year/month/random
        const user = req.user;
        const now = new Date();
        const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
        const key = [
            "chat",
            user.orgId,
            now.getUTCFullYear(),
            String(now.getUTCMonth() + 1).padStart(2, "0"),
            `${user.id}-${crypto_1.default.randomUUID()}${ext ? "." + ext.toLowerCase() : ""}`,
        ].join("/");
        const bucket = process.env.SPACES_BUCKET;
        const putCmd = new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: contentType,
            ACL: "public-read", // if you want public; otherwise omit and generate GET presigned per download
        });
        const presignedUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3, putCmd, { expiresIn: 60 }); // 60s to upload
        const publicUrl = `${process.env.SPACES_CDN_BASE ||
            process.env.SPACES_ENDPOINT.replace("https://", `https://${bucket}.`)}/${key}`;
        const resp = {
            key,
            presignedUrl,
            publicUrl,
            contentType,
            expiresIn: 60,
        };
        res.json(resp);
    }
    catch (e) {
        console.error("presign error", e);
        res.status(500).json({ error: "Failed to presign" });
    }
});
router.get("/presign-get", async (req, res) => {
    try {
        const { key, downloadName, inline, ttl } = req.query;
        if (!key)
            return res.status(400).json({ error: "key required" });
        const bucket = process.env.SPACES_BUCKET;
        const expiresIn = Math.min(Math.max(Number(ttl) || 300, 60), 60 * 60 * 12); // 1m–12h
        // (optional) probe metadata (also 403/404 early if missing)
        let contentType = "application/octet-stream";
        try {
            const head = await s3.send(new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: key }));
            if (head.ContentType)
                contentType = head.ContentType;
        }
        catch (e) {
            return res.status(404).json({ error: "object not found" });
        }
        const disposition = inline === "false"
            ? `attachment${downloadName ? `; filename="${downloadName}"` : ""}`
            : // inline by default (good for images/PDF previews)
                downloadName
                    ? `inline; filename="${downloadName}"`
                    : undefined;
        const cmd = new client_s3_1.GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ResponseContentType: contentType,
            ResponseContentDisposition: disposition,
            // You can also set ResponseCacheControl here if needed
        });
        const url = await (0, s3_request_presigner_1.getSignedUrl)(s3, cmd, { expiresIn });
        res.json({ url, expiresIn, contentType });
    }
    catch (e) {
        console.error("presign-get error", e);
        res.status(500).json({ error: "Failed to presign GET" });
    }
});
exports.default = router;
