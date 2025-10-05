"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spaces = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
exports.spaces = new client_s3_1.S3Client({
    region: process.env.SPACES_REGION || "us-east-1",
    endpoint: process.env.SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
    credentials: {
        accessKeyId: process.env.SPACES_KEY,
        secretAccessKey: process.env.SPACES_SECRET,
    },
});
