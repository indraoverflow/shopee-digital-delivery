import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { AppError } from "@qansa/core";
import {
  LocalAssetStore,
  assertAcceptableAsset,
  type AssetStore,
  type StoredAsset,
} from "./assets.js";

/**
 * S3-compatible object storage for digital assets.
 *
 * Implemented against the S3 REST API with SigV4 signing rather than an SDK: the
 * surface needed here is three verbs (put, get, delete) and a dependency-free
 * signer keeps the image small. Works with AWS S3, MinIO, Backblaze B2 and the
 * Cloudflare R2 endpoint.
 */

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted gateways need path style. */
  forcePathStyle?: boolean;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac("sha256", key).update(value).digest();

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function amzDate(now: Date): { amz: string; date: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

/**
 * Builds a signed request. Canonicalisation follows the S3 documentation:
 * sorted headers, sorted query, URI-encoded path, hashed payload, then the
 * four-step key derivation.
 */
export function signS3Request(input: {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  endpoint: string;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash?: string;
  contentType?: string;
  forcePathStyle?: boolean;
  now?: Date;
}): SignedRequest {
  const now = input.now ?? new Date();
  const { amz, date } = amzDate(now);
  const payloadHash = input.payloadHash ?? sha256Hex("");

  const base = new URL(input.endpoint);
  const pathStyle = input.forcePathStyle ?? true;
  const objectPath = pathStyle
    ? `/${input.bucket}/${input.key}`
    : `/${input.key}`;
  const host = pathStyle ? base.host : `${input.bucket}.${base.host}`;
  const canonicalUri = encodePath(
    objectPath.startsWith("/") ? objectPath : `/${objectPath}`,
  );

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...(input.contentType ? { "content-type": input.contentType } : {}),
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  return {
    url: `${base.protocol}//${host}${canonicalUri}`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export class S3AssetStore implements AssetStore {
  readonly kind = "s3" as const;

  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async save(input: { fileName: string; data: Buffer }): Promise<StoredAsset> {
    assertAcceptableAsset(input.fileName, input.data.byteLength);
    const safeName = input.fileName.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
    const storageKey = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
    const contentType = contentTypeFor(safeName);
    const payloadHash = sha256Hex(input.data);

    const signed = signS3Request({
      ...this.config,
      method: "PUT",
      key: storageKey,
      payloadHash,
      contentType,
    });
    const response = await this.fetchImpl(signed.url, {
      method: "PUT",
      headers: {
        ...signed.headers,
        "content-length": String(input.data.byteLength),
      },
      body: input.data,
    });

    if (!response.ok) {
      throw new AppError(
        "ASSET_UPLOAD_FAILED",
        `Object storage menolak unggahan (${response.status})`,
        502,
      );
    }

    return {
      storageKey,
      fileName: safeName,
      mimeType: contentType,
      sizeBytes: input.data.byteLength,
      sha256: payloadHash,
    };
  }

  async read(
    storageKey: string,
  ): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number }> {
    const signed = signS3Request({
      ...this.config,
      method: "GET",
      key: storageKey,
    });
    const response = await this.fetchImpl(signed.url, {
      method: "GET",
      headers: signed.headers,
    });

    if (response.status === 404)
      throw new AppError(
        "ASSET_MISSING",
        "Berkas tidak ditemukan di object storage",
        404,
      );
    if (!response.ok || !response.body) {
      throw new AppError(
        "ASSET_READ_FAILED",
        `Object storage menolak pembacaan (${response.status})`,
        502,
      );
    }

    const sizeBytes = Number(response.headers.get("content-length") ?? 0);
    return {
      stream: Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      ),
      sizeBytes,
    };
  }

  async buffer(storageKey: string): Promise<Buffer> {
    const signed = signS3Request({
      ...this.config,
      method: "GET",
      key: storageKey,
    });
    const response = await this.fetchImpl(signed.url, {
      method: "GET",
      headers: signed.headers,
    });
    if (response.status === 404)
      throw new AppError(
        "ASSET_MISSING",
        "Berkas tidak ditemukan di object storage",
        404,
      );
    if (!response.ok)
      throw new AppError(
        "ASSET_READ_FAILED",
        `Object storage menolak pembacaan (${response.status})`,
        502,
      );
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(storageKey: string): Promise<void> {
    const signed = signS3Request({
      ...this.config,
      method: "DELETE",
      key: storageKey,
    });
    await this.fetchImpl(signed.url, {
      method: "DELETE",
      headers: signed.headers,
    }).catch(() => undefined);
  }
}

function contentTypeFor(fileName: string): string {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    epub: "application/epub+zip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  };
  return map[extension] ?? "application/octet-stream";
}

export interface AssetStoreConfig {
  driver: "local" | "s3";
  directory: string;
  s3?: S3Config;
}

/** Picks the driver from configuration; local disk stays the default. */
export function createAssetStore(config: AssetStoreConfig): AssetStore {
  if (config.driver === "s3") {
    if (!config.s3)
      throw new Error("S3 asset store selected without S3 configuration");
    return new S3AssetStore(config.s3);
  }
  return new LocalAssetStore(config.directory) as AssetStore;
}
