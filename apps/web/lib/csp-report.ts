/**
 * The portal runs a CSP in report-only mode, so every page load can send the
 * browser's complaints to `/api/csp-report`. Two formats arrive: the legacy
 * `{"csp-report": {...}}` body that `report-uri` produces, and the array of
 * `{"type": "csp-violation"}` entries from the newer Reporting API.
 *
 * Only fields that identify the offending resource are kept. `document-uri` is
 * reduced to its path because the query string of a claim page carries an order
 * number, and a log line is not a place for a buyer's order details.
 */

export type CspViolation = {
  directive: string;
  blocked: string;
  sample: string;
  document: string;
};

const MAX_SAMPLE = 60;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A path without query or fragment, so no buyer data reaches the log. */
export function documentPath(uri: string): string {
  if (!uri) return "-";
  try {
    const url = new URL(uri, "https://placeholder.invalid");
    return url.pathname || "/";
  } catch {
    return "-";
  }
}

function clip(value: string, limit = MAX_SAMPLE): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function readCspViolations(payload: unknown): CspViolation[] {
  const out: CspViolation[] = [];

  const legacy = (payload as { "csp-report"?: Record<string, unknown> } | null)?.["csp-report"];
  if (legacy && typeof legacy === "object") {
    out.push({
      directive: text(legacy["effective-directive"]) || text(legacy["violated-directive"]) || "-",
      blocked: clip(text(legacy["blocked-uri"]) || "-"),
      sample: clip(text(legacy["script-sample"])),
      document: documentPath(text(legacy["document-uri"])),
    });
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const body = (entry as { body?: Record<string, unknown> } | null)?.body;
      if (!body || typeof body !== "object") continue;
      out.push({
        directive: text(body.effectiveDirective) || text(body.violatedDirective) || "-",
        blocked: clip(text(body.blockedURL) || "-"),
        sample: clip(text(body.sample)),
        document: documentPath(text(body.documentURL)),
      });
    }
  }

  return out;
}

/** One line per violation, in the shape `key=value` so it greps cleanly. */
export function formatCspViolation(violation: CspViolation): string {
  const parts = [`directive=${violation.directive}`, `blocked=${violation.blocked}`, `page=${violation.document}`];
  if (violation.sample) parts.push(`sample=${JSON.stringify(violation.sample)}`);
  return parts.join(" ");
}
