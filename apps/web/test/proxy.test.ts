import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { proxyToApi } from "../lib/proxy.js";

/**
 * The proxy must read API_URL per request, not at module load. The bug this
 * covers was a Next rewrite that baked the build machine's API_URL into the
 * image, which only shows up when the web container tries to reach the API
 * container.
 */

const originalFetch = globalThis.fetch;

function request(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): NextRequest {
  return {
    url: `https://claim.qansa.web.id${path}`,
    method: init.method ?? "GET",
    headers: new Headers(init.headers ?? {}),
    arrayBuffer: async () => new TextEncoder().encode(init.body ?? "").buffer,
  } as unknown as NextRequest;
}

beforeEach(() => {
  process.env.API_URL = "http://api:4000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.API_URL;
  vi.restoreAllMocks();
});

describe("proxyToApi", () => {
  it("resolves the API host on every call, not at import time", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await proxyToApi(request("/api/backend/auth/login"), "/api/backend", "/api");
    process.env.API_URL = "http://127.0.0.1:4100";
    await proxyToApi(request("/api/backend/auth/login"), "/api/backend", "/api");

    expect(calls).toEqual(["http://api:4000/api/auth/login", "http://127.0.0.1:4100/api/auth/login"]);
  });

  it("keeps the query string and the path suffix", async () => {
    let seen = "";
    globalThis.fetch = (async (url: string) => {
      seen = String(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await proxyToApi(request("/api/backend/admin/orders?state=FULFILLED&page=2"), "/api/backend", "/api");
    expect(seen).toBe("http://api:4000/api/admin/orders?state=FULFILLED&page=2");
  });

  it("forwards the body and the CSRF header, and drops hop-by-hop headers", async () => {
    let seen: { method?: string; headers?: Headers; body?: string } = {};
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      seen = {
        ...(init.method ? { method: init.method } : {}),
        ...(init.headers ? { headers: init.headers as Headers } : {}),
        body: init.body ? Buffer.from(init.body as ArrayBuffer).toString() : undefined,
      };
      void url;
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    await proxyToApi(request("/api/backend/claim/verify", { method: "POST", body: '{"orderSn":"1"}', headers: { "x-csrf-token": "abc", connection: "keep-alive", host: "claim.qansa.web.id" } }), "/api/backend", "/api");

    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"orderSn":"1"}');
    expect(seen.headers?.get("x-csrf-token")).toBe("abc");
    expect(seen.headers?.get("connection")).toBeNull();
    expect(seen.headers?.get("host")).toBeNull();
  });

  it("relays both session cookies separately", async () => {
    globalThis.fetch = (async () => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "qansa_session=abc; Path=/; HttpOnly");
      headers.append("set-cookie", "qansa_csrf=def; Path=/");
      return new Response("{}", { status: 200, headers });
    }) as typeof fetch;

    const response = await proxyToApi(request("/api/backend/auth/login", { method: "POST", body: "{}" }), "/api/backend", "/api");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.join(";")).toContain("qansa_session=abc");
    expect(cookies.join(";")).toContain("qansa_csrf=def");
  });

  it("answers 502 with a readable error when the API is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
    }) as typeof fetch;

    const response = await proxyToApi(request("/api/backend/auth/me"), "/api/backend", "/api");
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("API_UNREACHABLE");
    expect(body.error.message).toContain("Coba lagi");
  });
});
