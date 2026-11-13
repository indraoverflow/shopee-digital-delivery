import type { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy";

/**
 * Shopee pushes normally land on api.qansa.web.id, straight at Fastify. This
 * keeps the web host usable for them too, for a single-hostname deployment.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = (request: NextRequest) => proxyToApi(request, "/webhook", "/webhook");

export { handler as GET, handler as POST };
