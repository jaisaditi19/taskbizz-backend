// src/routes/uploadRoutes.ts
import { Router } from "express";
import crypto from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { authenticate } from "../middlewares/auth";

const router = Router();
router.use(authenticate)

const s3 = new S3Client({
  region: process.env.SPACES_REGION!, // e.g. "ap-south-1"
  endpoint: process.env.SPACES_ENDPOINT!, // e.g. "https://nyc3.digitaloceanspaces.com"
  credentials: {
    accessKeyId: process.env.SPACES_KEY!,
    secretAccessKey: process.env.SPACES_SECRET!,
  },
});

type PresignReq = { fileName: string; contentType: string; size: number };
type PresignRes = {
  key: string;
  presignedUrl: string; // PUT here
  publicUrl: string; // load from here (if bucket is public) or pipe through a GET signer
  contentType: string;
  expiresIn: number;
};

router.post("/presign", async (req, res) => {
  try {
    const { fileName, contentType, size } = req.body as PresignReq;

    // Guardrails (adjust limits)
    if (!fileName || !contentType)
      return res.status(400).json({ error: "fileName, contentType required" });
    if (size > 25 * 1024 * 1024)
      return res.status(413).json({ error: "Max 25MB per file" });

    // Key format: org/user/year/month/random
    const user = (req as any).user as { id: string; orgId: string };
    const now = new Date();
    const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
    const key = [
      "chat",
      user.orgId,
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      `${user.id}-${crypto.randomUUID()}${ext ? "." + ext.toLowerCase() : ""}`,
    ].join("/");

    const bucket = process.env.SPACES_BUCKET!;
    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ACL: "public-read", // if you want public; otherwise omit and generate GET presigned per download
    });

    const presignedUrl = await getSignedUrl(s3, putCmd, { expiresIn: 60 }); // 60s to upload
    const publicUrl = `${
      process.env.SPACES_CDN_BASE ||
      process.env.SPACES_ENDPOINT!.replace("https://", `https://${bucket}.`)
    }/${key}`;

    const resp: PresignRes = {
      key,
      presignedUrl,
      publicUrl,
      contentType,
      expiresIn: 60,
    };
    res.json(resp);
  } catch (e) {
    console.error("presign error", e);
    res.status(500).json({ error: "Failed to presign" });
  }
});

router.get("/presign-get", async (req, res) => {
  try {
    const { key, downloadName, inline, ttl } = req.query as {
      key?: string;
      downloadName?: string;
      inline?: string; // "true" | "false"
      ttl?: string; // seconds
    };
    if (!key) return res.status(400).json({ error: "key required" });

    const bucket = process.env.SPACES_BUCKET!;
    const expiresIn = Math.min(Math.max(Number(ttl) || 300, 60), 60 * 60 * 12); // 1m–12h

    // (optional) probe metadata (also 403/404 early if missing)
    let contentType = "application/octet-stream";
    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key })
      );
      if (head.ContentType) contentType = head.ContentType;
    } catch (e) {
      return res.status(404).json({ error: "object not found" });
    }

    const disposition =
      inline === "false"
        ? `attachment${downloadName ? `; filename="${downloadName}"` : ""}`
        : // inline by default (good for images/PDF previews)
        downloadName
        ? `inline; filename="${downloadName}"`
        : undefined;

    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: disposition,
      // You can also set ResponseCacheControl here if needed
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn });
    res.json({ url, expiresIn, contentType });
  } catch (e) {
    console.error("presign-get error", e);
    res.status(500).json({ error: "Failed to presign GET" });
  }
});

export default router;
