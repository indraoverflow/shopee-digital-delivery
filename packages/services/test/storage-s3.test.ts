import { afterEach, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  S3AssetStore,
  createAssetStore,
  signS3Request,
} from "../src/storage-s3.js";

/**
 * The signer is verified by an independently written implementation of SigV4
 * that runs inside the fake S3 server: if the two disagree, the upload fails
 * with a 403 just as real S3 would answer.
 */

const config = {
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "qansa-assets",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  forcePathStyle: true,
};

interface FakeS3 {
  url: string;
  objects: Map<string, Buffer>;
  requests: Array<{
    method: string;
    path: string;
    signatureValid: boolean;
    payloadHash: string;
  }>;
  mode: "ok" | "deny" | "missing";
  close: () => Promise<void>;
}

/** A second, independent implementation of the signature. */
function expectedSignature(
  request: IncomingMessage,
  pathWithBucket: string,
  payloadHash: string,
  date: string,
  amzDate: string,
): string {
  const headers = request.headers as Record<
    string,
    string | string[] | undefined
  >;
  const signed: Record<string, string> = {
    "content-type": String(headers["content-type"] ?? ""),
    host: String(headers["host"] ?? ""),
    "x-amz-content-sha256": String(headers["x-amz-content-sha256"] ?? ""),
    "x-amz-date": String(headers["x-amz-date"] ?? ""),
  };
  const names = Object.keys(signed)
    .filter((name) => signed[name] !== "")
    .sort();
  const canonicalHeaders =
    names.map((name) => `${name}:${signed[name]}`).join("\n") + "\n";
  const canonicalRequest = [
    request.method ?? "GET",
    pathWithBucket,
    "",
    canonicalHeaders,
    names.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${date}/us-east-1/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;

  let key: Buffer = createHmac("sha256", `AWS4${config.secretAccessKey}`)
    .update(date)
    .digest();
  for (const part of ["us-east-1", "s3", "aws4_request"])
    key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(toSign).digest("hex");
}

async function fakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const requests: FakeS3["requests"] = [];
  const state: { mode: "ok" | "deny" | "missing" } = { mode: "ok" };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const payloadHash = createHash("sha256").update(body).digest("hex");

      const authorization = String(request.headers.authorization ?? "");
      const match = authorization.match(
        /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/,
      );
      const amzDate = String(request.headers["x-amz-date"] ?? "");
      const valid =
        Boolean(match) &&
        match![5] ===
          expectedSignature(
            request,
            url.pathname,
            String(request.headers["x-amz-content-sha256"] ?? payloadHash),
            match![2]!,
            amzDate,
          );

      requests.push({
        method: request.method ?? "GET",
        path: url.pathname,
        signatureValid: valid,
        payloadHash,
      });

      if (state.mode === "deny" || !valid)
        return response.writeHead(403).end("denied");

      const key = url.pathname.replace(`/${config.bucket}/`, "");
      if (request.method === "PUT") {
        objects.set(key, body);
        return response.writeHead(200, { etag: `"${payloadHash}"` }).end();
      }
      if (request.method === "GET") {
        const object = objects.get(key);
        if (!object || state.mode === "missing")
          return response.writeHead(404).end();
        return response
          .writeHead(200, { "content-length": String(object.byteLength) })
          .end(object);
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return response.writeHead(204).end();
      }
      return response.writeHead(405).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests,
    get mode() {
      return state.mode;
    },
    set mode(value: "ok" | "deny" | "missing") {
      state.mode = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let s3: FakeS3 | undefined;

afterEach(async () => {
  await s3?.close();
  s3 = undefined;
});

describe("signS3Request", () => {
  it("produces a well-formed authorization header", () => {
    const signed = signS3Request({
      method: "PUT",
      endpoint: config.endpoint,
      bucket: config.bucket,
      key: "2026/01/01/file.pdf",
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      contentType: "application/pdf",
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(signed.url).toBe(
      "http://127.0.0.1:9000/qansa-assets/2026/01/01/file.pdf",
    );
    expect(signed.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260101\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(signed.headers["x-amz-date"]).toBe("20260101T000000Z");
  });

  it("is deterministic and signs the payload, not just the request", () => {
    const base = {
      method: "PUT" as const,
      endpoint: config.endpoint,
      bucket: config.bucket,
      key: "a/b.pdf",
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      now: new Date("2026-01-01T00:00:00Z"),
    };
    const first = signS3Request(base);
    const second = signS3Request(base);
    const otherPayload = signS3Request({
      ...base,
      payloadHash: createHash("sha256").update("lain").digest("hex"),
    });

    expect(first.headers.authorization).toBe(second.headers.authorization);
    expect(first.headers.authorization).not.toBe(
      otherPayload.headers.authorization,
    );
  });

  it("uses virtual-hosted style when path style is off", () => {
    const signed = signS3Request({
      method: "GET",
      endpoint: "https://s3.example.com",
      bucket: "my-bucket",
      key: "x.txt",
      region: "eu-west-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      forcePathStyle: false,
    });
    expect(signed.url).toBe("https://my-bucket.s3.example.com/x.txt");
    expect(signed.headers.host).toBe("my-bucket.s3.example.com");
  });

  it("escapes object keys rather than trusting them", () => {
    const signed = signS3Request({
      method: "GET",
      endpoint: "http://127.0.0.1:9000",
      bucket: "b",
      key: "folder/na me+plus.txt",
      region: "us-east-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    });
    expect(signed.url).toContain("na%20me%2Bplus.txt");
  });
});

describe("S3AssetStore", () => {
  it("uploads, streams back and deletes a file the way S3 expects", async () => {
    s3 = await fakeS3();
    const store = new S3AssetStore({ ...config, endpoint: s3.url });

    const stored = await store.save({
      fileName: "panduan.pdf",
      data: Buffer.from("%PDF-1.4 contoh"),
    });
    expect(stored.mimeType).toBe("application/pdf");
    expect(stored.storageKey).toMatch(
      /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}-panduan.pdf$/,
    );
    expect(stored.sha256).toBe(
      createHash("sha256").update("%PDF-1.4 contoh").digest("hex"),
    );

    // Every request the fake received must carry a signature it accepted.
    expect(s3.requests.every((request) => request.signatureValid)).toBe(true);
    expect(s3.requests[0]).toMatchObject({
      method: "PUT",
      path: `/qansa-assets/${stored.storageKey}`,
    });

    expect((await store.buffer(stored.storageKey)).toString()).toBe(
      "%PDF-1.4 contoh",
    );

    const chunks: Buffer[] = [];
    const { stream, sizeBytes } = await store.read(stored.storageKey);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("%PDF-1.4 contoh");
    expect(sizeBytes).toBe(Buffer.byteLength("%PDF-1.4 contoh"));

    await store.remove(stored.storageKey);
    expect(s3.objects.size).toBe(0);
  });

  it("rejects a disallowed file type before it reaches storage", async () => {
    s3 = await fakeS3();
    const store = new S3AssetStore({ ...config, endpoint: s3.url });

    await expect(
      store.save({ fileName: "payload.sh", data: Buffer.from("curl evil") }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(s3.requests).toHaveLength(0);
  });

  it("rejects an oversized file before it reaches storage", async () => {
    s3 = await fakeS3();
    const store = new S3AssetStore({ ...config, endpoint: s3.url });

    await expect(
      store.save({
        fileName: "besar.pdf",
        data: Buffer.alloc(51 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(s3.requests).toHaveLength(0);
  });

  it("maps a rejected upload and a missing object to readable errors", async () => {
    s3 = await fakeS3();
    const store = new S3AssetStore({ ...config, endpoint: s3.url });

    s3.mode = "deny";
    await expect(
      store.save({ fileName: "a.pdf", data: Buffer.from("x") }),
    ).rejects.toMatchObject({ code: "ASSET_UPLOAD_FAILED", status: 502 });

    s3.mode = "missing";
    await expect(store.buffer("2026/01/01/hilang.pdf")).rejects.toMatchObject({
      code: "ASSET_MISSING",
      status: 404,
    });
    await expect(store.read("2026/01/01/hilang.pdf")).rejects.toMatchObject({
      code: "ASSET_MISSING",
      status: 404,
    });
  });

  it("refuses a file name that tries to escape the key prefix", async () => {
    s3 = await fakeS3();
    const store = new S3AssetStore({ ...config, endpoint: s3.url });

    await expect(
      store.save({
        fileName: "../../etc/passwd.txt",
        data: Buffer.from("aman"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(s3.requests).toHaveLength(0);
  });

  it("createAssetStore picks the configured driver", () => {
    expect(
      createAssetStore({ driver: "local", directory: "/tmp/x" }).kind,
    ).toBe("local");
    expect(
      createAssetStore({ driver: "s3", directory: "/tmp/x", s3: config }).kind,
    ).toBe("s3");
    expect(() =>
      createAssetStore({ driver: "s3", directory: "/tmp/x" }),
    ).toThrow(/S3 configuration/);
  });
});
