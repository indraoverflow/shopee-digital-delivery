#!/usr/bin/env node
/**
 * Proves the S3 driver against a real S3-compatible server.
 *
 *   S3_ENDPOINT=http://127.0.0.1:19000 S3_BUCKET=qansa-assets \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npx tsx scripts/verify-s3.ts
 *
 * Creates the bucket if it is missing, writes an object, reads it back, compares
 * the bytes, then deletes it. Anything that disagrees with a real implementation
 * of SigV4 fails here rather than in production.
 */

import { createHash } from "node:crypto";
import { S3AssetStore, signS3Request } from "../packages/services/src/storage-s3.js";

const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:19000";
const bucket = process.env.S3_BUCKET ?? "qansa-assets";
const region = process.env.S3_REGION ?? "us-east-1";
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "qansa";
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "qansa-s3-secret";
const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false";

const config = { endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle };
const full = { ...config, endpoint };

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

async function ensureBucket(): Promise<void> {
  const signed = signS3Request({ ...full, method: "PUT", key: "" });
  const response = await fetch(`${signed.url.replace(/\/$/, "")}/`, { method: "PUT", headers: signed.headers });
  // 200 on create, 409 when it already exists, 200 again on some gateways.
  check("bucket usable", [200, 204, 409].includes(response.status), { status: response.status });
}

async function main(): Promise<void> {
  console.log(`verify-s3: ${endpoint} bucket=${bucket} pathStyle=${forcePathStyle}`);
  await ensureBucket();

  const store = new S3AssetStore(full);
  const body = Buffer.from(`qansa s3 interop ${new Date().toISOString()}\n`);
  const expectedSha = createHash("sha256").update(body).digest("hex");

  const stored = await store.save({ fileName: "interop.txt", data: body });
  check("object uploaded", stored.storageKey.length > 0, stored);
  check("sha256 recorded", stored.sha256 === expectedSha, stored.sha256);

  const fetched = await store.buffer(stored.storageKey);
  check("bytes round-trip", fetched.equals(body), { expected: body.toString(), got: fetched.toString() });

  const { stream, sizeBytes } = await store.read(stored.storageKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  const streamed = Buffer.concat(chunks);
  check("stream matches", streamed.equals(body), { sizeBytes, got: streamed.toString() });

  await store.remove(stored.storageKey);
  const afterDelete = await store
    .buffer(stored.storageKey)
    .then(() => "still-there")
    .catch((error: { code?: string }) => error.code ?? "error");
  check("object deleted", afterDelete === "ASSET_MISSING" || afterDelete === "ASSET_READ_FAILED", afterDelete);

  console.log(failures === 0 ? "\nverify-s3: PASS" : `\nverify-s3: ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("verify-s3: crashed", error);
  process.exitCode = 1;
});
