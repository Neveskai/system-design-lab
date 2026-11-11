// Seed the attachments bucket: ATTACH_COUNT objects of ATTACH_KB each (random bytes,
// so nothing compresses). Idempotent: skips if the last object already has the right size.
// Run: docker compose run --rm api node src/seed-s3.ts
// Overwrite one object (CDN staleness demo): ... node src/seed-s3.ts att-1.bin
import { randomBytes } from "node:crypto";
import { CreateBucketCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, s3 } from "./s3.ts";

const COUNT = Number(process.env.ATTACH_COUNT ?? 500);
const KB = Number(process.env.ATTACH_KB ?? 256);
const put = (Key: string) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body: randomBytes(KB * 1024), ContentType: "application/octet-stream" }));

await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((e) => {
  if (!/BucketAlready/.test(e.name)) throw e;
});

const only = process.argv[2];
if (only) {
  const r = await put(only);
  console.log(`overwrote ${only} etag=${r.ETag}`);
  process.exit(0);
}

const last = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `att-${COUNT}.bin` })).catch(() => null);
if (last?.ContentLength === KB * 1024) {
  console.log(`bucket already seeded (${COUNT} x ${KB} KB)`);
  process.exit(0);
}
for (let i = 1; i <= COUNT; i += 20) {
  await Promise.all(Array.from({ length: Math.min(20, COUNT - i + 1) }, (_, j) => put(`att-${i + j}.bin`)));
}
console.log(`seeded ${COUNT} x ${KB} KB`);
