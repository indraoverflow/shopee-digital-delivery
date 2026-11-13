import type { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy";

/** The web host answers the same liveness probe as the API, for proxy healthchecks. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (request: NextRequest) => proxyToApi(request, "/health", "/health");
export const HEAD = (request: NextRequest) => proxyToApi(request, "/health", "/health");
