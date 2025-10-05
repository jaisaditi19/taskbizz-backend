import { S3Client } from "@aws-sdk/client-s3";

export const spaces = new S3Client({
  region: process.env.SPACES_REGION || "us-east-1",
  endpoint:
    process.env.SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
  credentials: {
    accessKeyId: process.env.SPACES_KEY!,
    secretAccessKey: process.env.SPACES_SECRET!,
  },
});
