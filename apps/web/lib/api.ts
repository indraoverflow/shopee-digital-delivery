"use client";

/**
 * The only place that talks to the API. Every request goes through the Next
 * rewrite at /api/backend, carries the CSRF header on mutations, and surfaces a
 * typed error the UI can show without leaking a stack trace.
 */

export const API_BASE = "/api/backend";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** multipart uploads pass a FormData and skip the JSON content type. */
  form?: FormData;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };

  if (method !== "GET") {
    const csrf = readCookie("qansa_csrf");
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: "same-origin",
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.form ? { body: options.form } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? `Permintaan gagal (${response.status})`, error?.details);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiFetch<T>(path, { ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", ...(body === undefined ? {} : { body }) }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PATCH", ...(body === undefined ? {} : { body }) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => apiFetch<T>(path, { method: "POST", form }),
};
