import type { NextConfig } from "next";

/**
 * The browser talks to this app only. /api/backend, /webhook and /health are
 * proxy route handlers (app/api/backend/[...path], app/webhook/[...path],
 * app/health) rather than rewrites: a rewrite is resolved when Next builds, so
 * the API_URL of the build machine would be baked into the image and a container
 * could never reach a sibling container. Read next.config's own comment history
 * before moving them back.
 */
/**
 * The portal is public and shows buyer-specific data, and until now it carried
 * every header except a policy. This one is Report-Only on purpose: the policy
 * below is the one we intend to enforce, and a week of reports says which parts
 * of it the app actually violates before a browser blocks anything for a buyer.
 *
 * `script-src` deliberately omits 'unsafe-inline'. Next ships an inline
 * bootstrap, so reports naming inline scripts are expected and are the reason a
 * nonce (middleware) or hashes comes before enforcement. Do not silence them
 * with 'unsafe-inline': a policy that allows inline script is close to no policy
 * at all.
 *
 * `style-src` does keep 'unsafe-inline', because React writes inline `style`
 * attributes for layout and a policy needs a nonce to allow those otherwise.
 * The reporting endpoint is same-origin and only writes to the container log.
 *
 * When the nonce middleware is stable and the report-only period is over,
 * change `Content-Security-Policy-Report-Only` to `Content-Security-Policy`
 * and add `'nonce-<value>'` to `script-src` via the middleware header.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
  "report-uri /api/csp-report",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  transpilePackages: ["@qansa/core"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
        ],
      },
    ];
  },
};

export default nextConfig;
