# example.com: second Cloudflare account, and the Shopee live application

This is the runbook for moving the Shopee-facing surface to `example.com`, while the platform
keeps running on the same server. It exists because two things are easy to get wrong: a
tunnel belongs to one Cloudflare account, and Shopee wants exact URLs registered in the
partner console.

## Where things stand

| Item                    | State on 2026-11-13                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `example.com` registration | registered, created 2026-11-13T11:04Z, registrar PT Jagoan Hosting Indonesia, expires 2027-11-13 |
| Nameservers             | still `ns1/ns2.jagoanhosting.com`, so the domain is not on Cloudflare yet                        |
| Hostnames               | none resolve yet; nothing is served from this domain                                             |
| Shopee credentials      | still missing; gateway runs in fixture mode                                                      |

## Phase 1: what the Shopee application actually needs

Shopee keeps two redirect domains, one per environment, and both must answer over HTTPS:

    Test Redirect URL Domain   https://sandbox-api.example.com
    Live Redirect URL Domain   https://api.example.com
    push (webhook)             https://api.example.com/webhook/shopee

The test domain is served by a second API process started with `SHOPEE_ENV=sandbox`. This is
not decoration: the environment decides which Shopee host the OAuth code is exchanged
against, so a single process pointed at production would fail every sandbox callback with
`exchange_failed`. Two processes from one image cost about 25 MB.

Some console versions accept only a domain in those two fields and append their own path.
If that is what you see, copy the exact path the console shows and put the full URL into
`SHOPEE_REDIRECT_URL`; the code compares nothing else.

Nothing else on the platform has to move for the application. Keep `claim.qansa.web.id` and
`admin.qansa.web.id` where they are until the partner app is approved: fewer moving parts
during a review, and no buyer-facing change to explain.

### 1. Put example.com on the second Cloudflare account

1. Cloudflare dashboard, the second account, "Add a site", enter `example.com`, choose Free.
2. Cloudflare shows two nameservers, typically `xxx.ns.cloudflare.com` and `yyy.ns.cloudflare.com`.
3. At Jagoan Hosting, replace the two `ns1/ns2.jagoanhosting.com` records with those two.
4. Wait for Cloudflare to say "Active". Usually under an hour, up to 24.

### 2. Create the tunnel in that account

Zero Trust, Networks, Tunnels, "Create a tunnel", Cloudflared, name it
`qansa-delivery-serah`. Copy the token and put it in `.env` on the server:

    CF_TUNNEL_TOKEN_SERAH=eyJh...

Then add three public hostnames in the tunnel, all pointing at the containers that are
already running on the same compose network:

| Subdomain   | Domain   | Service                   |
| ----------- | -------- | ------------------------- |
| api         | example.com | `http://api:4000`         |
| sandbox-api | example.com | `http://api-sandbox:4000` |
| claim       | example.com | `http://web:3000`         |
| admin       | example.com | `http://web:3000`         |

If you prefer the tunnel to be defined in git instead of the dashboard, use
`docker/cloudflared/config.example.yml` with a credentials file, same as
`docker-compose.cloudflare.yml` does for the first account.

### 3. Start the second tunnel

    docker compose -f docker-compose.yml -f docker-compose.cloudflare-tunnel.yml \
      -f docker-compose.shopee-sandbox.yml up -d cloudflared-serah api-sandbox

Check it from outside, not from the server:

    curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/health
    curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/ready
    curl -sS -o /dev/null -w '%{http_code}\n' https://sandbox-api.example.com/health

Both must be 200 before anything is submitted to Shopee. A webhook that answers 404 or a
Cloudflare error page is the most common reason an application is sent back.

### 4. Point the platform at the new URLs

    SHOPEE_PUSH_URL=https://api.example.com/webhook/shopee
    SHOPEE_REDIRECT_URL=https://api.example.com/api/integration/shopee/callback

`SHOPEE_ENV` stays `production` in `.env`; the sandbox instance overrides it in
`docker-compose.shopee-sandbox.yml` and gets its own redirect URL there.

Restart `api` after changing them; `SHOPEE_PUSH_URL` is also what the preflight probe signs
against, so a mismatch shows up as a failing check rather than as silent webhook rejects.

## Phase 2: optional, only after approval

Moving the buyer portal and the console to `example.com` is a separate decision:

    CLAIM_ORIGIN=https://claim.example.com
    ADMIN_ORIGIN=https://admin.example.com

Two consequences worth planning: sessions are cookies scoped to a host, so every operator is
logged out once, and any buyer link already sent out still points at the old domain, which
must keep working until those claims expire.

## What goes into the Shopee partner application

Fill these in the partner console. The URLs are the ones above, exactly, including the path
and without a trailing slash.

| Field                    | Value                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| App name                 | Serah Terima                                                                   |
| App type                 | ERP / Seller In House System, whichever the console offers as order management |
| Test Redirect URL Domain | `https://sandbox-api.example.com`                                                 |
| Live Redirect URL Domain | `https://api.example.com`                                                         |
| Push URL                 | `https://api.example.com/webhook/shopee`                                          |
| Permissions              | Shop, Order, Product, Logistics, Auth: see `docs/live-shopee-checklist.md`     |
| Platform                 | Web                                                                            |
| Data handled             | Order and product data for the seller's own shop, no buyer contact data        |

A short description that matches what the code does, avoid claiming anything else:

> Serah Terima memproses pesanan toko sendiri: menerima push pesanan dari Shopee, memverifikasi
> pembeli, menyerahkan produk digital (kode, tautan, berkas, atau akses Google Drive), lalu
> menandai pesanan sebagai dikirim di Shopee. Hanya mengakses data toko yang memberi izin.

Shopee will also ask for the business documents, an app icon, and often a privacy policy
page. The policy page does not exist yet; publishing `/privacy` on `claim.example.com` is a
half-day task and should be done before submitting, not after being asked.

## Verification before submitting

    # from outside the homelab
    curl -sS https://api.example.com/health | jq .status
    curl -sS -X POST https://api.example.com/webhook/shopee -H 'content-type: application/json' -d '{}' -w '\n%{http_code}\n'

The second call must answer `401` with a signature complaint, not 200 and not 500: it proves
the endpoint exists and refuses unsigned traffic, which is exactly what a reviewer probes.

Then run the repo's own probes against the new origin:

    API_URL=https://api.example.com CLAIM_URL=https://claim.example.com ADMIN_URL=https://admin.example.com \
      node scripts/smoke.mjs
    API_URL=https://api.example.com node scripts/preflight.mjs

## Apex and www

`example.com` and `www.example.com` are one permanent redirect to `claim.example.com`, so the address a
shop puts in its bio is the short one and every claim still happens on a single host.

Two details keep that working:

- The apex keeps a proxied `A` record pointing at `192.0.2.1`, a documentation address. A
  redirect rule only fires once traffic reaches Cloudflare, and a proxied record is what gets
  it there; the origin is never contacted because the rule answers first. Leaving the old
  `103.163.138.39` there would have kept pointing buyers at a hosting server that does not
  serve this domain.
- `www` is a CNAME to the apex, so it inherits the same rule.

The rule is a zone ruleset, `http_request_dynamic_redirect`:

    (http.host eq "example.com") or (http.host eq "www.example.com")
      -> 301 concat("https://claim.example.com", http.request.uri.path), query preserved

Deleting this rule turns the apex into a Cloudflare error page, not into a working site: the
placeholder record answers nothing on its own.

## Rollback

The second tunnel is additive. Stopping `cloudflared-serah` removes the domain from the
internet without touching the running platform, and reverting the two `SHOPEE_*` values in
`.env` restores the previous URLs.
