import { describe, expect, it } from "vitest";
import { documentPath, formatCspViolation, readCspViolations } from "../lib/csp-report.js";

/**
 * Both report shapes reach the endpoint, and the legacy one is still what
 * `report-uri` produces in every current browser. The privacy assertion matters
 * as much as the parsing one: a claim page URL carries the order number, and the
 * log is on a shared host.
 */

describe("CSP report parsing", () => {
  it("reads the legacy csp-report body", () => {
    const violations = readCspViolations({
      "csp-report": {
        "document-uri": "https://claim.example/klaim?order=260101REV0001",
        "violated-directive": "script-src",
        "effective-directive": "script-src-elem",
        "blocked-uri": "inline",
        "script-sample": "self.__next_f.push([1,\"abc\"])",
        "line-number": 1,
      },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      directive: "script-src-elem",
      blocked: "inline",
      sample: "self.__next_f.push([1,\"abc\"])",
      document: "/klaim",
    });
  });

  it("reads the Reporting API array", () => {
    const violations = readCspViolations([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://claim.example/admin/login",
          effectiveDirective: "connect-src",
          blockedURL: "wss://example.test/socket",
          sample: "",
        },
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.directive).toBe("connect-src");
    expect(violations[0]?.document).toBe("/admin/login");
  });

  it("keeps only the path, so an order number never reaches the log", () => {
    expect(documentPath("https://claim.example/klaim?order=260101REV0001#step")).toBe("/klaim");
    expect(documentPath("")).toBe("-");
    expect(documentPath("not a url")).toBe("/not%20a%20url");
  });

  it("answers an empty list for a body it does not understand", () => {
    expect(readCspViolations({})).toEqual([]);
    expect(readCspViolations("nonsense")).toEqual([]);
    expect(readCspViolations([{ type: "other" }])).toEqual([]);
  });

  it("clips a long sample so one report stays one line", () => {
    const long = "a".repeat(200);
    const [violation] = readCspViolations({
      "csp-report": { "effective-directive": "script-src", "blocked-uri": "inline", "script-sample": long },
    });
    expect(violation?.sample.length).toBeLessThan(80);
    expect(violation?.sample.endsWith("...")).toBe(true);
    expect(formatCspViolation(violation!)).not.toContain("\n");
  });
});
