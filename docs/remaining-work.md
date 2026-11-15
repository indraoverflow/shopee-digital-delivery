# Remaining work

Only items that are real: verified gaps, missing production requirements, external dependencies, security
gaps and operational improvements. Each one says what closes it and how you will know it is closed.
No feature ideas, no restating what already works.

Ordered by what would hurt first.

## 1. Live Shopee credentials and app approval

**CLOSED for credentials and data access; shipping still open (see item 7)**

Live partner id 2044130, a 64-character partner key, redirect `https://api.serah.id` and the PII
Necessity Declaration with the server's egress IP declared are all in place, and the main api process
now runs `SHOPEE_GATEWAY_MODE=live` with `SHOPEE_ENV=production`.

A main-account consent returns `code` + `main_account_id` and no shop id, so the callback exchanges the
code against the main account, reads `shop_id_list` and links every authorised shop. Four production
shops are connected this way.

Verified on real orders: `order/get_order_detail` returns a 12-13 digit recipient phone (unmasked) for
the shops the declaration covers; orders in markets outside it still answer `**`.

Still open: one real `ship_order` (item 7).

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

**LOW — DONE**

`docker/nginx.conf` carried per-zone rate limits, but the tunnel points at the app ports directly, so those limits never ran. App-level limits do run (12/min on claim verify, 10/5min on login).

Closed: nginx removed from the documented topology. The Cloudflare Tunnel targets app ports directly. Rate limits live in the app.

## 7. Resi format accepted by jasa kirim toko

**LOW / WAITING FOR A SHIPPABLE ORDER**

The platform ships with `DIGITAL-<order_sn>` as the tracking number. Shopee documents that field as
"assigned by the shipping carrier", so a placeholder may be refused for some channels.

`scripts/shopee-ship-probe.mts` asks the order what its channel accepts and, with `--ship --yes`, sends
the placeholder resi. Run against a real order today it answers `error_param` because every production
order is already past the shipping step (shipped, completed or cancelled); there is nothing in
`READY_TO_SHIP` to test with.

Closes when: the next paid order reaches `READY_TO_SHIP` and the probe returns `ship_order` success, or
the auto-ship switch is turned off and shipping stays manual.

## 8. Multi-tenant SaaS, if that is the direction

**DESIGN ONLY, and gated.** `docs/saas-tenant-design.md` records the tenancy model, the claim-domain
decision (subdomain per tenant by default, own domain on paid plans, path on the tenant's main domain
only for tenants already behind Cloudflare), the infrastructure plan and a four-phase estimate. Nothing
of it is implemented: there is no `tenants` table, no billing, `system_settings` is still global.

The owner has decided the product is validated internally first, so the document opens with a gate of
seven conditions that must be true before any tenant work starts: a real Shopee round trip confirmed as
Dikirim, a real e-Meterai mint, a month of own-shop traffic without a lost order, nightly backups with a
restore from the offsite copy, 2FA and IP allow list, alerts reaching a phone, and rehearsed runbooks.

Closes when that gate is met and the phases in the design document are done.

## 9. Unmapped listings at handover

**OPERATIONAL**

The demo listing is mapped, but every new listing still starts unmapped. Monitoring raises
`UNMAPPED_LISTINGS`, and an unmapped paid order stops at `VALIDATED`, so nothing is delivered silently.

Closed by process, not code: map new listings as part of publishing them.

### Catalogue breakdown after the live connection

The four production shops sync 822 listings, and only 5 mappings exist (all from the sandbox demo), so
the dashboard used to report all 822 as unmapped work. Most of that pile is not digital:

| shop                      | listings | software (101937) | other |
| ------------------------- | -------- | ----------------- | ----- |
| 1423696590 digistore apps | 291      | 285               | 6     |
| 1787682915 PixelBloom.Id  | 380      | 227               | 153   |
| 1648711865 digistoreid.sg | 100      | 97                | 3     |
| 1648711869 digistoreid.ph | 51       | 51                | 0     |

`UNMAPPED_LISTINGS` now counts only the categories listed in `DIGITAL_CATEGORY_IDS` (default `101937`,
"Komputer & Aksesoris > Software" in ID, SG and PH) and reports the rest as ignored, so the number to act
on is 660 rather than 822.

`scripts/shopee-category-report.mts` prints the category tree behind those ids for a shop; it is what
turned the 822 into the table above. Mapping itself stays manual: a listing needs its own digital product
with an asset before a paid order can be delivered.

All 660 software listings now have a mapping to a DRAFT product, created by
`scripts/map-digital-listings.sh draft` (name and slug from the listing, delivery kind `LINK`, no asset
yet). That empties the unmapped counter but moves the work rather than removing it: an order mapped to a
DRAFT product stops at `PRODUCT_NOT_ACTIVE`, so monitoring now raises `PRODUCT_NOT_ACTIVE` with the number
of products still waiting for an asset.

What is left for the operator, per listing: fill `external_url` (or upload a file), then set the product
to `ACTIVE`. Anything not sold through the portal can be archived instead, which removes it from delivery
without touching the Shopee listing.
