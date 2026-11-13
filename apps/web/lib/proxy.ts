import type { NextRequest } from "next/server";

/**
 * Runtime proxy from the web app to the Fastify API.
 *
 * This used to be a rewrite in next.config.ts, which is evaluated at BUILD time:
 * the image baked in whatever API_URL existed on the build machine, so a
 * containerised web served a working page and then failed every API call with
 * ECONNREFUSED to 127.0.0.1. A route handler reads the environment per request,
 * which is the only version that survives being built once and run anywhere.
 */

/**
 * Read per request, never captured in a module constant: the test below sets
 * API_URL between calls, and a constant would silently freeze the first value.
 */
function apiUrl(): string {
  return (process.env.API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

/** Headers that belong to one hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export async function proxyToApi(request: NextRequest, prefix: string, target: string): Promise<Response> {
  const incoming = new URL(request.url);
  const suffix = incoming.pathname.startsWith(prefix) ? incoming.pathname.slice(prefix.length) : "";
  const url = `${apiUrl()}${target}${suffix}${incoming.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = !["GET", "HEAD"].includes(request.method);

  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      ...(hasBody ? { body: Buffer.from(await request.arrayBuffer()) } : {}),
      redirect: "manual",
      cache: "no-store",
      // @ts-expect-error -- undici accepts duplex for streamed bodies; harmless elsewhere.
      duplex: "half",
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "API_UNREACHABLE",
          message: "Server sedang tidak dapat dijangkau. Coba lagi sebentar.",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 502 },
    );
  }

  const out = new Headers();
  response.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === "set-cookie" || HOP_BY_HOP.has(name) || name === "content-encoding") return;
    out.set(key, value);
  });

  // A login response sets two cookies; the merged header would drop one of them.
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    out.append("set-cookie", cookie);
  }

  return new Response(response.body, { status: response.status, headers: out });
}
