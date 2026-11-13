import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { AppError } from "@qansa/core";

/**
 * Digital assets live on a private volume. Nothing here ever returns a public
 * path: a buyer receives a signed link that expires, and the file itself is
 * streamed by the API after the signature and the claim are checked.
 */

const MAX_BYTES = 50 * 1024 * 1024;

/** Extensions a digital product may ship as. Anything else is refused. */
const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".txt",
  ".csv",
  ".json",
  ".docx",
  ".xlsx",
  ".pptx",
  ".epub",
  ".mp3",
  ".mp4",
  ".notion",
  ".psd",
  ".ai",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".epub": "application/epub+zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

/**
 * The storage seam. The API serves files through this interface, so a
 * deployment can move assets to S3 without touching claim or delivery logic.
 */
export interface AssetStore {
  readonly kind: "local" | "s3";
  save(input: { fileName: string; data: Buffer }): Promise<StoredAsset>;
  read(
    storageKey: string,
  ): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number }>;
  buffer(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

/**
 * Validation shared by every driver: applying it before the upload means a
 * rejected file never reaches storage, whatever the backend.
 */
export function assertAcceptableAsset(
  fileName: string,
  sizeBytes: number,
): void {
  if (sizeBytes <= 0) throw AppError.validation("File kosong");
  if (sizeBytes > MAX_BYTES)
    throw AppError.validation("Ukuran file melebihi 50 MB");

  const extension = extname(fileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw AppError.validation(
      `Tipe file ${extension || "(tanpa ekstensi)"} tidak didukung`,
    );
  }
  if (/[\\/]/.test(fileName) || fileName.includes("..")) {
    throw AppError.validation("Nama file tidak valid");
  }
}

export interface StoredAsset {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export class LocalAssetStore implements AssetStore {
  readonly kind = "local" as const;

  constructor(private readonly root: string) {}

  /** Kept for callers that only need the check. */
  static assertAcceptable(fileName: string, sizeBytes: number): void {
    assertAcceptableAsset(fileName, sizeBytes);
  }

  async save(input: { fileName: string; data: Buffer }): Promise<StoredAsset> {
    assertAcceptableAsset(input.fileName, input.data.byteLength);
    const safeName = input.fileName.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
    const storageKey = join(
      new Date().toISOString().slice(0, 10),
      `${randomUUID()}-${safeName}`,
    );
    const target = this.resolve(storageKey);
    await mkdir(join(this.root, new Date().toISOString().slice(0, 10)), {
      recursive: true,
    });
    await writeFile(target, input.data);
    const extension = extname(safeName).toLowerCase();
    return {
      storageKey,
      fileName: safeName,
      mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
      sizeBytes: input.data.byteLength,
      sha256: createHash("sha256").update(input.data).digest("hex"),
    };
  }

  async read(
    storageKey: string,
  ): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number }> {
    const target = this.resolve(storageKey);
    const info = await stat(target);
    return { stream: createReadStream(target), sizeBytes: info.size };
  }

  async buffer(storageKey: string): Promise<Buffer> {
    return readFile(this.resolve(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    await unlink(this.resolve(storageKey)).catch(() => undefined);
  }

  /** Path traversal guard: the resolved path must stay under the root. */
  private resolve(storageKey: string): string {
    const root = normalize(this.root).replace(/\/+$/, "");
    const target = normalize(join(root, storageKey));
    if (!target.startsWith(`${root}/`)) {
      throw new AppError("INVALID_STORAGE_KEY", "Lokasi file tidak valid", 400);
    }
    return target;
  }
}
