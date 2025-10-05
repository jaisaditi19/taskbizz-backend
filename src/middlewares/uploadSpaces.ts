import multer from "multer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { spaces } from "../config/spaces";

const storage = multer.memoryStorage();
export const upload = multer({ storage });

export const uploadToSpaces = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.file) return next();

  const extension = path.extname(req.file.originalname || "") || "";
  const fileName = `${Date.now()}-${randomUUID()}${extension}`;

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.SPACES_BUCKET!,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await spaces.send(command);

    // Save only the key
    (req as any).fileKey = fileName;

    next();
  } catch (error) {
    console.error("Spaces Upload Error:", error);
    res.status(500).json({ message: "File upload failed" });
  }
};
