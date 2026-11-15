import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Single middleware that handles:
 * - Host-based routing: admin.claim.* vs claim.* hostnames
 * - CSP nonce generation per response
 */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(request: NextRequest) {
  // 1. Host-based routing (from old proxy.ts)
  const host = request.headers.get("host") ?? "";
  const { pathname } = request.nextUrl;

  const isAdminHost = host.startsWith("admin.");
  const isClaimHost = host.startsWith("claim.");

  if (!isAdminHost && !isClaimHost) {
    // 2. CSP nonce for non-routed requests too
    const nonce = makeNonce();
    const response = NextResponse.next();
    response.headers.set("x-csp-nonce", nonce);
    return response;
  }

  if (
    isAdminHost &&
    !pathname.startsWith("/admin") &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/api") &&
    !pathname.startsWith("/_next")
  ) {
    const url = request.nextUrl.clone();
    url.pathname = pathname === "/" ? "/admin" : `/admin${pathname}`;
    const response = NextResponse.rewrite(url);
    const nonce = makeNonce();
    response.headers.set("x-csp-nonce", nonce);
    return response;
  }

  if (
    isClaimHost &&
    (pathname.startsWith("/admin") || pathname.startsWith("/login"))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.replace(/^\/admin/, "") || "/";
    const response = NextResponse.redirect(url);
    const nonce = makeNonce();
    response.headers.set("x-csp-nonce", nonce);
    return response;
  }

  // 2. CSP nonce for all other requests
  const nonce = makeNonce();
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
