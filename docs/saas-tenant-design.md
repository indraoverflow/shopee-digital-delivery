# Multi-tenant SaaS: design note

**Status: design only.** Nothing in this document is implemented. It records the decisions and the
trade-offs agreed on 2026-11-13 so the next session starts from a decision instead of re-deriving one.

The application today is a single-tenant deployment: one company, one settings row, one set of admin
users, any number of Shopee stores. Turning it into a SaaS means adding tenancy and billing, not adding
features.

## 1. Tenancy

- New `tenants` table: id, slug, name, status, plan, created_at.
- `tenant_id` on every table that carries tenant data: stores, tokens, products, variations, mappings,
  orders, order items, events, fulfillments, claims, claim sessions, attempts, delivery logs, sync jobs,
  jobs, audit logs, claim requests, users, settings.
- Every query scoped by tenant, and PostgreSQL Row Level Security enabled as the second lock, so a query
  that forgets the filter returns nothing instead of a neighbour's row.
- One encryption key per tenant (tokens, activation codes, e-Meterai password), derived from
  `APP_ENCRYPTION_KEY` plus the tenant id, so rotating one tenant's key is not a global event.
- `system_settings` stops being global: settings become per tenant, with the platform keeping only what
  is genuinely global (list of plans, feature flags).

## 2. How a buyer claims, and where

Three options were weighed.

| Option                  | Entry                                     | Tenant resolved by  | Trade-off                                                                           |
| ----------------------- | ----------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| A. Subdomain per tenant | `<slug>.<platform>`                       | host                | clean isolation, zero onboarding work, one wildcard DNS and cert                    |
| B. Shared portal        | `claim.<platform>`                        | order number lookup | no DNS work, but every lookup crosses tenants and all tenants share one cookie host |
| C. Hybrid               | A by default, custom domain on paid plans | host                | best product answer, two code paths                                                 |

**Decision: option C, with A as the effective default.**

- Free tier: `<slug>.<platform>`, for example `tokoahmad.example.com`. One wildcard `*.<platform>` record to
  the tunnel and one wildcard certificate covers every tenant, and a new tenant needs no DNS work.
- `claim.<platform>` is not a tenant host. It is the marketing page and the fallback entry for a buyer who
  does not know the shop's subdomain. There the tenant is resolved from the order number, with two rules
  that must not be softened: a lookup that finds the order in no tenant answers exactly like an unknown
  order, and attempt limits are counted per tenant plus IP.
- Paid tier: the tenant's own domain, `klaim.tokoahmad.com` by CNAME. Automatic certificates only with
  Cloudflare for SaaS; otherwise the host is added to `tenant_domains` and verified by hand.

**Path on the tenant's main domain (`tokoahmad.com/klaim`) is a premium option, never the default.**

Reasons, in order of weight:

1. The domain belongs to the tenant. Serving a path means either they move nameservers to Cloudflare or
   their host supports a per-path reverse proxy. Shared hosting and hosted storefronts usually do not, so
   half the customers would be unable to finish onboarding.
2. A claim cookie on a domain the platform does not control can be driven by any script on that domain.
   Mitigable with `HttpOnly`, `SameSite=Lax`, `Secure`, a non-colliding cookie name and CSRF, but the
   trust boundary is wider than a subdomain's.
3. One Next.js build serves every tenant, and `basePath` is a build-time setting. Serving the same build
   under different paths needs a rewrite layer that strips the prefix, which is easy to get subtly wrong
   for assets, manifests and API routes.

Path mode is accepted only when all of these hold: tenant nameservers on Cloudflare, a `/klaim/*` route to
a Worker proxying to the platform origin, claim cookies `HttpOnly` + `SameSite=Lax` + `Secure` under a
name that cannot clash, and CSRF plus tenant-bound sessions intact. If the first condition fails, the
answer is the subdomain.

## 3. What the buyer experiences

Unchanged from today, which is the point: one page, order number, one verification that follows the
policy of the store that owns the order. The only thing SaaS adds is "whose page is this", and that is
decided by the URL the seller shared, never by input the buyer can edit.

Additional work inside the console: a **copy claim link** button that renders the URL for that tenant's
current mode, so the seller never has to guess whether it is a subdomain or a path.

## 4. e-Meterai stays per tenant

Each tenant stores its own e-Meterai account (already supported), so minting spends their balance, not the
platform's. This removes the platform from the money path for stamping and removes the largest financial
risk from the SaaS model. It also means the private-API risk described in
`docs/emeterai-integration.md` lands on the tenant, and the contract must say so.

## 5. Billing and quotas

- Plans differentiate on: stores, orders per month, minted links per month, custom domain, retention.
- Payment: Midtrans or Xendit, subscription plus paid invoices; trial with a hard cap on orders.
- Quota enforcement belongs in the job pipeline, not the UI: a tenant over its order quota stops creating
  new fulfilments and raises an alert, it does not silently lose orders.
- No platform-side e-Meterai balance, so no billing reconciliation for stamping.

## 6. Onboarding, compliance, operations

- Self-serve: sign up, create tenant, connect Shopee via the existing OAuth callback, map one product,
  receive the claim link. Today only the middle steps exist.
- UU PDP 27/2022: the tenant is the data controller, the platform is the processor. Needed before selling:
  DPA, privacy page, per-tenant retention policy (the retention sweep already exists, it needs a tenant
  scope), and a documented answer to "where is buyer data stored".
- Operations per tenant: per-tenant backup and restore, per-tenant monitoring view, status page, and an
  incident runbook that can name affected tenants.

## 7. Phasing

| Phase | Work                                                                | Estimate     |
| ----- | ------------------------------------------------------------------- | ------------ |
| 1     | tenant model, scoped queries, RLS, per-tenant keys, isolation tests | 2 to 3 weeks |
| 2     | self-serve onboarding, billing, quotas                              | 2 weeks      |
| 3     | PDP documents, per-tenant retention and backups, status page        | 1 to 2 weeks |
| 4     | pilot with 3 to 5 paying shops, then general availability           | 2 weeks      |

## 8. Decisions still open

1. **Licence.** `package.json` and the vendor package are MIT, which lets anyone resell this code. If the
   SaaS is meant to be closed, the platform code needs a proprietary licence; the integration package can
   stay MIT as an on-ramp.
2. **Shopee partner status.** One partner app may serve many sellers, but the app must pass review and each
   seller authorises separately. Administrative, and it blocks selling more than it blocks coding.
3. **Domain.** `example.com` is used in this note as a placeholder. Registration was not done; availability was
   checked on 2026-11-13 and it was free at that moment.
4. **Path mode.** Whether to offer `tokoahmad.com/klaim` at all, given it only works for tenants already on
   Cloudflare.
