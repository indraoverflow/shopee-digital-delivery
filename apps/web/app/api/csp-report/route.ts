import type { NextRequest } from "next/server";
import { formatCspViolation, readCspViolations } from "@/lib/csp-report";

/**
 * The collection point for the report-only CSP. It answers 204 whatever it
 * receives: a reporting endpoint that fails loudly makes a browser retry, and
 * no buyer should ever see an error because a policy report went wrong.
 *
 * Reports land in the container's stdout, so `docker compose logs web` is where
 * to read them. Nothing is stored; a week of measurement is the whole point, and
 * a table nobody queries is worse than a log line that greps.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_LOGGED = 5;

const noContent = () => new Response(null, { status: 204 });

export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return noContent();

  let body: string;
  try {
    body = await request.text();
  } catch {
    return noContent();
  }
  if (body.length > MAX_BODY_BYTES) return noContent();

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return noContent();
  }

  const violations = readCspViolations(payload);
  const shown = violations.slice(0, MAX_LOGGED);
  const suppressed = violations.length - shown.length;
  for (const violation of shown) {
    console.warn(`csp-report ${formatCspViolation(violation)}`);
  }
  if (suppressed > 0) {
    console.warn(`csp-report suppressed=${suppressed}`);
  }

  return noContent();
}
