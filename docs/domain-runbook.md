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

Shopee asks for two URLs, and both must answer over HTTPS:

    push (webhook)  https://api.example.com/webhook/shopee
    redirect        https://api.example.com/api/integration/shopee/callback

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

| Subdomain | Domain   | Service           |
| --------- | -------- | ----------------- |
| api       | example.com | `http://api:4000` |
| claim     | example.com | `http://web:3300` |
| admin     | example.com | `http://web:3300` |

If you prefer the tunnel to be defined in git instead of the dashboard, use
`docker/cloudflared/config.example.yml` with a credentials file, same as
`docker-compose.cloudflare.yml` does for the first account.

### 3. Start the second tunnel

    docker compose -f docker-compose.yml -f docker-compose.cloudflare-tunnel.yml up -d cloudflared-serah

Check it from outside, not from the server:

    curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/health
    curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/ready

Both must be 200 before anything is submitted to Shopee. A webhook that answers 404 or a
Cloudflare error page is the most common reason an application is sent back.

### 4. Point the platform at the new URLs

    SHOPEE_PUSH_URL=https://api.example.com/webhook/shopee
    SHOPEE_REDIRECT_URL=https://api.example.com/api/integration/shopee/callback

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

| Field        | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| App name     | Serah Terima                                                                   |
| App type     | ERP / Seller In House System, whichever the console offers as order management |
| Redirect URL | `https://api.example.com/api/integration/shopee/callback`                         |
| Push URL     | `https://api.example.com/webhook/shopee`                                          |
| Permissions  | Shop, Order, Product, Logistics, Auth: see `docs/live-shopee-checklist.md`     |
| Platform     | Web                                                                            |
| Data handled | Order and product data for the seller's own shop, no buyer contact data        |

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

## Rollback

The second tunnel is additive. Stopping `cloudflared-serah` removes the domain from the
internet without touching the running platform, and reverting the two `SHOPEE_*` values in
`.env` restores the previous URLs.
