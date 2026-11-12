import { NextResponse, type NextRequest } from "next/server";

/**
 * Two public hostnames, one application. admin.qansa.web.id serves the console,
 * claim.qansa.web.id serves the buyer portal, and a stray /admin on the claim
 * host is redirected rather than duplicated.
 */
export default function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const { pathname } = request.nextUrl;

  const isAdminHost = host.startsWith("admin.");
  const isClaimHost = host.startsWith("claim.");

  if (!isAdminHost && !isClaimHost) return NextResponse.next();

  if (isAdminHost && !pathname.startsWith("/admin") && !pathname.startsWith("/login") && !pathname.startsWith("/api") && !pathname.startsWith("/_next")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname === "/" ? "/admin" : `/admin${pathname}`;
    return NextResponse.rewrite(url);
  }

  if (isClaimHost && (pathname.startsWith("/admin") || pathname.startsWith("/login"))) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.replace(/^\/admin/, "") || "/";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
