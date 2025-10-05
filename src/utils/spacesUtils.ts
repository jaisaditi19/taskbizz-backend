// src/utils/spacesUtils.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import path from "path";
import { randomUUID } from "crypto";
import { cacheGetJson, cacheSetJson, orgKey } from "./cache";

// ✅ Use one naming scheme. Here I standardize on SPACES_*.
const spacesClient = new S3Client({
  region: process.env.SPACES_REGION || "nyc3",
  credentials: {
    accessKeyId: process.env.SPACES_KEY || "",
    secretAccessKey: process.env.SPACES_SECRET || "",
  },
  endpoint: process.env.SPACES_ENDPOINT || undefined,
  forcePathStyle: false,
});

const BUCKET = process.env.SPACES_BUCKET!;

// ---- Generic, prefix-aware uploader (recommended) ----
type UploadOpts = {
  prefix: string; // required: e.g. `licenses/${orgId}`
  contentType?: string | null; // optional override
  inline?: boolean; // default true
};

async function uploadWithPrefix(
  file: Express.Multer.File,
  { prefix, contentType, inline = true }: UploadOpts
): Promise<string> {
  const ext = path.extname(file.originalname || "").toLowerCase();
  const key = `${prefix}/${randomUUID()}${ext || ""}`;

  await spacesClient.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: contentType ?? file.mimetype ?? "application/octet-stream",
      ACL: "private",
      // ✅ Helps in-tab preview (PDF/image/video)
      ContentDisposition: inline ? "inline" : undefined,
      CacheControl: "private, max-age=0, no-cache",
    })
  );

  return key;
}

// ---- License-specific uploader (wraps the generic) ----
export async function uploadLicenseToSpaces(
  file: Express.Multer.File,
  orgId?: string
): Promise<string> {
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
export async function uploadFileToSpaces(
  file: Express.Multer.File,
  orgId?: string
): Promise<string> {
  const prefix = `tasks/${orgId ?? "global"}`;
  return uploadWithPrefix(file, {
    prefix,
    contentType: file.mimetype,
    inline: true,
  });
}

export async function getFileUrlFromSpaces(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(spacesClient, cmd, { expiresIn: expiresInSeconds });
}

export async function deleteFileFromSpaces(key: string): Promise<void> {
  await spacesClient.send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: key })
  );
}

export async function getCachedFileUrlFromSpaces(
  key: string,
  orgId: string,
  urlTtlSeconds = 3600
) {
  const cacheKey = orgKey(orgId, "spacesurl", encodeURIComponent(key));
  const cached = await cacheGetJson<string>(cacheKey);
  if (cached) return cached;

  const url = await getFileUrlFromSpaces(key, urlTtlSeconds);
  // leave some margin so cached URL doesn't expire right after retrieval
  const ttl = Math.max(30, urlTtlSeconds - 60);
  await cacheSetJson(cacheKey, url, ttl);
  return url;
}
