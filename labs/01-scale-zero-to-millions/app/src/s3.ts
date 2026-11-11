// S3 client for attachments. Same code talks to AWS S3: only the endpoint changes.
import http from "node:http";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const BUCKET = "attachments";

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://seaweedfs:8333",
  region: "us-east-1",
  forcePathStyle: true, // http://host/bucket/key, not http://bucket.host/key (no wildcard DNS here)
  credentials: { accessKeyId: "lab", secretAccessKey: "labsecret" },
  // Checksums on every GET cost CPU; S3-compatible servers do not all support them.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  // Reuse TCP connections to the object store, like the nginx -> API keepalive.
  requestHandler: { httpAgent: new http.Agent({ keepAlive: true, maxSockets: 128 }) },
});

export const getObject = (key: string) => s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

// Presigning is local CPU (HMAC-SHA256 over the request), no call to S3.
export const presign = (key: string, expiresIn = 60) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
