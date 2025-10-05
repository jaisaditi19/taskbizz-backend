// src/utils/s3Utils.ts
import { s3 } from "../config/s3";
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { cacheGetJson, cacheSetJson, orgKey, cacheDel } from "./cache";

// Upload a single file buffer to S3
export async function uploadFileToS3(
  file: Express.Multer.File,
  orgId: string
): Promise<string> {
  const key = `tasks/${orgId}/${Date.now()}-${file.originalname}`;
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET!,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  });
  await s3.send(command);
  return key;
}

// Get a signed URL for a file key
export async function getFileUrlFromS3(key: string) {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET!,
    Key: key,
  });
  const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour
  return url;
}

// Delete a file from S3
export async function deleteFileFromS3(key: string) {
  const command = new DeleteObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET!,
    Key: key,
  });
  await s3.send(command);
}


export async function getCachedFileUrlFromS3(
  key: string,
  orgId: string,
  urlTtlSeconds = 60 * 60 // assuming presigned URLs valid 1 hour
): Promise<string> {
  const cacheKey = orgKey(orgId, "s3url", encodeURIComponent(key));
  const cached = await cacheGetJson<string>(cacheKey);
  if (cached) return cached;

  // call your existing function (rename as needed)
  // if your function is in the same file and named getFileUrlFromS3, call it directly
  const url = await getFileUrlFromS3(key);
  // cache slightly less than real expiry
  const ttl = Math.max(30, urlTtlSeconds - 60);
  await cacheSetJson(cacheKey, url, ttl);
  return url;
}

/**
 * Invalidate a specific s3 url (use when deleting an attachment)
 */
export async function invalidateS3Url(key: string, orgId: string) {
  const cacheKey = orgKey(orgId, "s3url", encodeURIComponent(key));
  try {
    await cacheSetJson(cacheKey, null, 1); // cheap overwrite then delete is fine
  } catch (e) {
    // best-effort
    try {
      await cacheDel(cacheKey);
    } catch {}
  }
}