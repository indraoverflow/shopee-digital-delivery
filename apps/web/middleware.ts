import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

/**
 * A tiny middleware that:
 * - Generates a CSP nonce for each response
 * - Attaches it to response headers so the CSP can allow inline scripts by nonce
 * - Does nothing else: no auth, no redirect, no rewrite.
 *
 * The nonce is also exposed on `res.headers.get("x-csp-nonce")` for any
 * server component that wants to render it into a script tag, but the
 * current CSP report-only does not yet enforce script-src with nonce.
 * When enforcement starts, change `script-src 'self'` to
 * `script-src 'self' 'nonce-<value>'` and make sure Next's inline bootstrap
 * gets the nonce (see next.config.ts headers).
 */
export function middleware(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const response = NextResponse.next();
  response.headers.set("x-csp-nonce", nonce);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    "/((?!_next/static|_next/image|favicon.ico|public/).*)",
  ],
};