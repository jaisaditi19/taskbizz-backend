// src/middlewares/upload.ts
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Multer memory storage (keeps file in memory for direct upload to S3)
const storage = multer.memoryStorage();
export const upload = multer({ storage });

export const uploadToS3 = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.file) return next();

  const fileName = `${Date.now()}-${randomUUID()}${path.extname(
    req.file.originalname
  )}`;

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET!,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await s3.send(command);

    // Save S3 file URL for later usage
    (
      req as any
    ).fileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

    next();
  } catch (error) {
    console.error("S3 Upload Error:", error);
    res.status(500).json({ message: "File upload failed" });
  }
};
