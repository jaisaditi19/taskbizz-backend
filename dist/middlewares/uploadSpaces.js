"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadToSpaces = exports.upload = void 0;
const multer_1 = __importDefault(require("multer"));
const client_s3_1 = require("@aws-sdk/client-s3");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const spaces_1 = require("../config/spaces");
const storage = multer_1.default.memoryStorage();
exports.upload = (0, multer_1.default)({ storage });
const uploadToSpaces = async (req, res, next) => {
    if (!req.file)
        return next();
    const extension = path_1.default.extname(req.file.originalname || "") || "";
    const fileName = `${Date.now()}-${(0, crypto_1.randomUUID)()}${extension}`;
    try {
        const command = new client_s3_1.PutObjectCommand({
            Bucket: process.env.SPACES_BUCKET,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        });
        await spaces_1.spaces.send(command);
        // Save only the key
        req.fileKey = fileName;
        next();
    }
    catch (error) {
        console.error("Spaces Upload Error:", error);
        res.status(500).json({ message: "File upload failed" });
    }
};
exports.uploadToSpaces = uploadToSpaces;
