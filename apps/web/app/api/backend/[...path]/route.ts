import type { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy";

/**
 * The browser only ever talks to this app. Keeping the API behind the same
 * origin means session cookies stay first-party on the claim and admin hosts and
 * no CORS preflight is needed in production.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = (request: NextRequest) => proxyToApi(request, "/api/backend", "/api");

export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE, handler as OPTIONS };
