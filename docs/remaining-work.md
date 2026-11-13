# Remaining work

Only items that are real: verified gaps, missing production requirements, external dependencies, security
gaps and operational improvements. Each one says what closes it and how you will know it is closed.
No feature ideas, no restating what already works.

Ordered by what would hurt first.

## 1. Live Shopee credentials and app approval

**EXTERNAL DEPENDENCY**

Without `SHOPEE_PARTNER_ID` and `SHOPEE_PARTNER_KEY` (and an approved app that carries the Order,
Product and Logistics modules) the platform cannot leave fixture mode. No amount of code work closes
this.

Closed when: `docs/live-shopee-checklist.md` section 6 has been run end to end, including the Seller
Centre check that a real order moved to **Dikirim**.

## 2. Second factor on the owner account

**HIGH**

There is exactly one owner account, `admin@qansa.web.id`, and TOTP is off. A stolen password currently
means the whole console, including token rotation and the audit log, is open.

Closes when: `/admin/security` shows an active authenticator, recovery codes are stored offline, and a
login without the code is refused.

## 3. Scheduled backups

**MEDIUM**

`scripts/backup.sh` works and has been restore-tested, but nothing calls it. A backup nobody runs is a
backup nobody has.

Closes when: a cron entry or systemd timer runs it nightly, the dump lands on a different disk, and one
restore from the scheduled location has been performed.

## 4. Content-Security-Policy on the buyer portal

**MEDIUM**

The web app sends `X-Frame-Options: DENY`, `nosniff` and a referrer policy, but no CSP. The portal is
public and shows buyer-specific data, so a policy is the remaining cheap hardening step. Start with
`default-src 'self'`, allow the Next.js inline runtime via nonce or hash, and report-only for a week
before enforcing.

Closes when: `curl -sI https://claim.qansa.web.id/` shows a `content-security-policy` header and the
portal still renders and claims correctly with it enforced.

## 5. Console IP allow list

**MEDIUM**

`ADMIN_IP_ALLOWLIST` is empty, so the console accepts logins from anywhere. It is behind a password and
(eventually) a second factor, but a fixed operator range would cut the attack surface to near zero.

Closes when: the variable holds the operator CIDRs, an off-range request to `/api/admin/*` is refused,
and the operator's own access still works.

## 6. nginx in the deployed path, or not at all

**LOW**

`docker/nginx.conf` carries per-zone rate limits, but the tunnel points at the app ports directly, so
those limits never run. App-level limits do run (12/min on claim verify, 10/5min on login), so this is
tidy-up, not a hole.

Closes when: either the tunnel targets nginx and the limits are exercised, or nginx is removed from the
documented topology so nobody assumes protection that is not there.

## 7. Resi format accepted by jasa kirim toko

**LOW / EXTERNAL DEPENDENCY**

The platform ships with `DIGITAL-<order_sn>` as the tracking number. Shopee documents that field as
"assigned by the shipping carrier", so a placeholder may be refused for some channels. This cannot be
settled without a live call.

Closes when: one real `ship_order` with a placeholder resi returns `ship_order` success, or the decision
is made to keep shipping manual and the auto-ship switch is turned off.

## 8. Unmapped listings at handover

**OPERATIONAL**

The demo listing is mapped, but every new listing still starts unmapped. Monitoring raises
`UNMAPPED_LISTINGS`, and an unmapped paid order stops at `VALIDATED`, so nothing is delivered silently.

Closed by process, not code: map new listings as part of publishing them.
