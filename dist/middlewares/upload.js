"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadToS3 = exports.upload = void 0;
// src/middlewares/upload.ts
const multer_1 = __importDefault(require("multer"));
const client_s3_1 = require("@aws-sdk/client-s3");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const s3 = new client_s3_1.S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});
// Multer memory storage (keeps file in memory for direct upload to S3)
const storage = multer_1.default.memoryStorage();
exports.upload = (0, multer_1.default)({ storage });
const uploadToS3 = async (req, res, next) => {
    if (!req.file)
        return next();
    const fileName = `${Date.now()}-${(0, crypto_1.randomUUID)()}${path_1.default.extname(req.file.originalname)}`;
    try {
        const command = new client_s3_1.PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        });
        await s3.send(command);
        // Save S3 file URL for later usage
        req.fileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
        next();
    }
    catch (error) {
        console.error("S3 Upload Error:", error);
        res.status(500).json({ message: "File upload failed" });
    }
};
exports.uploadToS3 = uploadToS3;
