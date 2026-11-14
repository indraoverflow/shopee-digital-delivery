# Deployment

## Prerequisites

- Docker 24+ with Compose v2, or Node 22 + pnpm 10 + PostgreSQL 15+
- Three DNS records: `claim.qansa.web.id`, `admin.qansa.web.id`, `api.qansa.web.id`
- TLS at the edge (Cloudflare tunnel or nginx with certificates)
- A Shopee partner account when you switch to live mode

## Compose stack

```
postgres   postgres:17-alpine, internal only (host binding 127.0.0.1:55433 for debugging)
migrate    same image as api, runs bootstrap (migrations + seed) once, exits
api        Fastify, :4000, healthcheck /health
worker     same image, different command
web        Next.js standalone, :3000
nginx      optional profile "proxy", serves the three hostnames
```

```bash
git clone --recurse-submodules git@github.com:indraoverflow/shopee-digital-delivery.git
cd shopee-digital-delivery
cp .env.example .env
openssl rand -hex 32   # APP_ENCRYPTION_KEY
openssl rand -hex 32   # DOWNLOAD_SIGNING_SECRET
$EDITOR .env
docker compose up -d --build
docker compose logs -f migrate     # migrations + owner account, then it exits
```

First login: `ADMIN_EMAIL` with the password from `ADMIN_PASSWORD` (or the generated one printed once
by the migrate container). Change it from the console after signing in; the API revokes existing
sessions when you do.

### Hostnames

| Host                 | Serves       | Notes                                                       |
| -------------------- | ------------ | ----------------------------------------------------------- |
| `claim.qansa.web.id` | Buyer portal | `/` only; `/admin` redirects to the console host            |
| `admin.qansa.web.id` | Console      | `/` rewrites to `/admin`                                    |
| `api.qansa.web.id`   | Fastify      | `/webhook/shopee`, OAuth callback, signed downloads, health |

Both web hosts point at the same container. `proxy.ts` decides by `Host`.

### With the bundled nginx

```bash
docker compose --profile proxy up -d
```

nginx listens on `:8080` and routes by `server_name`. Put your tunnel or TLS terminator in front and
forward `Host` unchanged; the web app relies on it.

### With a Cloudflare tunnel

There are two ways to run it, and the difference matters when a hostname has to be added later.

**A. Dashboard-managed tunnel (token mode).** The tunnel is started with `--token`, so the ingress
list lives in Cloudflare, not in this repository. Add one _Public Hostname_ per row:

| Public hostname      | Type | URL              |
| -------------------- | ---- | ---------------- |
| `claim.qansa.web.id` | HTTP | `localhost:3300` |
| `admin.qansa.web.id` | HTTP | `localhost:3300` |
| `api.qansa.web.id`   | HTTP | `localhost:4000` |

`localhost` works because the cloudflared container runs with host networking
(`--network host`). If the tunnel runs as a compose service on the project network instead, the targets
are `web:3000` and `api:4000`.

The CNAME records must exist in the zone and point at `<tunnel-id>.cfargotunnel.com`, proxied. The
dashboard creates them when the hostname is added; to create them ahead of time:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" \
  -d '{"type":"CNAME","name":"claim","content":"<tunnel-id>.cfargotunnel.com","proxied":true}'
```

**B. Git-managed tunnel (recommended once the hostnames settle).** The ingress lives in
[`docker/cloudflared/config.yml`](../docker/cloudflared/config.yml), so adding a hostname is a commit:

```bash
cloudflared tunnel login                                   # browser, one time
cloudflared tunnel create qansa-delivery                   # writes credentials.json
cp ~/.cloudflared/<tunnel-id>.json docker/cloudflared/credentials.json
# set `tunnel:` in docker/cloudflared/config.yml to the created name
docker compose -f docker-compose.yml -f docker-compose.cloudflare.yml up -d cloudflared
cloudflared tunnel route dns qansa-delivery claim.qansa.web.id
cloudflared tunnel route dns qansa-delivery admin.qansa.web.id
cloudflared tunnel route dns qansa-delivery api.qansa.web.id
```

The credentials file is gitignored; only `config.yml` is committed.

Either way, the application has to be told it is public:

```bash
NODE_ENV=production
SESSION_COOKIE_SECURE=true
ADMIN_ORIGIN=https://admin.qansa.web.id
CLAIM_ORIGIN=https://claim.qansa.web.id
API_PUBLIC_ORIGIN=https://api.qansa.web.id
SHOPEE_PUSH_URL=https://api.qansa.web.id/webhook/shopee
```

and register `SHOPEE_PUSH_URL` in the Shopee console. A trailing slash or a different scheme breaks the
signature.

Verify from outside, in this order:

```bash
curl -s https://api.qansa.web.id/health                  # {"ok":true,...}
curl -sI https://claim.qansa.web.id | head -1            # 200
curl -sI https://admin.qansa.web.id/login | head -1      # 200
```

A `404` from Cloudflare means the DNS record exists but the tunnel has no hostname for it: the ingress
row is missing. A Cloudflare `1033` means the tunnel is not connected at all.

## Environment

All variables are in [`.env.example`](../.env.example). Minimum for a working deployment:

```bash
DATABASE_URL=postgres://qansa:<password>@postgres:5432/qansa_delivery
APP_ENCRYPTION_KEY=<64 hex>
DOWNLOAD_SIGNING_SECRET=<32+ chars>
ADMIN_ORIGIN=https://admin.qansa.web.id
CLAIM_ORIGIN=https://claim.qansa.web.id
API_PUBLIC_ORIGIN=https://api.qansa.web.id
API_URL=http://api:4000          # web container -> api container
UPLOAD_DIR=/data/uploads
SHOPEE_GATEWAY_MODE=fixture      # live when credentials are in place
```

`EXTRA_ORIGINS` only exists for a second front-end host; leave it empty otherwise.

## Migrations

Applied automatically by the `migrate` service. Manually:

```bash
docker compose run --rm migrate
# or, with a local checkout and DATABASE_URL set:
pnpm --filter @qansa/db migrate
```

The API performs a schema probe at boot and refuses to start with
`database schema mismatch (did the migrations run?)` when the database is behind.

## Backups

`scripts/backup.sh` does the whole set and refuses to call it a backup until the dump can be read back:

```bash
scripts/backup.sh /data/backups          # or the default ./backups
KEEP_BACKUPS=14 scripts/backup.sh /data/backups
```

It writes `qansa-<stamp>.dump` (custom format), `qansa-uploads-<stamp>.tar.gz`, and a copy of `.env`
as `qansa-<stamp>.env`, then verifies the dump with `pg_restore --list` and prints how many tables of
data it contains. The `.env` copy is the part people forget: tokens, activation codes and TOTP secrets
are encrypted with `APP_ENCRYPTION_KEY`, so the dump alone restores rows you cannot read. Move that copy
to a password manager rather than leaving it on the same disk.

The same steps by hand, when the script is not an option:

```bash
docker compose exec -T postgres pg_dump -U qansa -Fc qansa_delivery > qansa-$(date +%F).dump
docker run --rm -v qansa-delivery_uploads:/data -v "$PWD:/backup" alpine \
  tar czf /backup/qansa-uploads-$(date +%F).tar.gz -C /data .
```

Nightly, with a copy off the host:

```cron
15 2 * * * cd /opt/qansa && scripts/backup.sh /data/backups >> /var/log/qansa-backup.log 2>&1
```

Restore (verified on 2026-11-13 by restoring a dump into a scratch database: 25 tables and the live
orders came back):

```bash
docker compose stop api worker
docker compose exec -T postgres pg_restore -U qansa -d qansa_delivery --clean --if-exists < qansa-2026-11-12.dump
docker run --rm -v qansa-delivery_uploads:/data -v "$PWD:/backup" alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/qansa-uploads-2026-11-12.tar.gz -C /data"
docker compose start api worker
```

Key material (`APP_ENCRYPTION_KEY`, `DOWNLOAD_SIGNING_SECRET`) belongs in the same backup set or in a
password manager: a database restored without the key has unreadable tokens and codes.

## Upgrades

```bash
git pull --recurse-submodules
docker compose build
docker compose run --rm migrate       # migrations first
docker compose up -d api worker web
```

Rollback: `git checkout <previous tag>`, rebuild, and restore the database dump if the release
included a destructive migration (none so far; the schema only adds).

### Upgrading by pulling, not compiling

`.github/workflows/images.yml` builds both images on a GitHub runner for every push to `main` and
publishes them to GHCR. The server then needs no source tree and no compiler:

```bash
scripts/deploy.sh <git sha>
scripts/deploy.sh latest
```

The override is thin: `docker-compose.pull.yml` only resets the build contexts and names the
published images, so ports, health checks, volumes and environment keep coming from
`docker-compose.yml` and the two cannot drift. Compose merges them with
`-f docker-compose.yml -f docker-compose.pull.yml`, which is what the script runs.

`scripts/deploy.sh` pins the tag to a commit sha (not `latest`), remembers the previous tag in
`.deploy-tag`, checks `/health` for up to a minute, and redeploys the previous tag if the new one
does not come up. A deploy that leaves the portal down is worse than the version it replaced.

Measured on this host (4 vCPU): a local rebuild after touching one web file took 117 seconds with a
warm cache and 380 to 530 seconds cold; pulling the published image is a download.

One thing worth knowing: `vendor/shopee-integration` is a git submodule. CI checks it out
recursively; a manual clone needs `--recurse-submodules` or the Dockerfile fails on a missing
`package.json`.

## Key rotation

`APP_ENCRYPTION_KEY` protects `shopee_tokens`, `digital_product_codes` and the 2FA secrets in
`users`. Rotation is a console action, not a script:

```bash
# 1. dump first
docker compose exec -T postgres pg_dump -U qansa qansa_delivery | gzip > before-rotation.sql.gz

# 2. put both keys in .env: APP_ENCRYPTION_KEY_OLD stays on the current one,
#    APP_ENCRYPTION_KEY becomes the new one (openssl rand -hex 32)
docker compose up -d api worker

# 3. dry run from Keamanan, or over HTTP with an owner session:
curl -sX POST https://api.qansa.web.id/api/admin/security/rotate-key \
  -H "content-type: application/json" -b cookies.txt -H "x-csrf-token: $CSRF" \
  -d '{"confirm":"ROTASI","dryRun":true}' | jq

# 4. run it for real, then remove APP_ENCRYPTION_KEY_OLD and restart
```

The whole rotation is one transaction: a failure leaves every row encrypted with the old key and the
service keeps working. A dry run reports how many rows would change and rolls back. Keep the dump
until a claim and a store token refresh have both succeeded afterwards.

## Object storage

Local disk is the default and needs nothing. For object storage set `ASSET_STORE=s3` plus
`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

- MinIO and most self-hosted gateways need `S3_FORCE_PATH_STYLE=true` (the default).
- Cloudflare R2 uses `https://<account>.r2.cloudflarestorage.com` with `region=auto`.
- The bucket can stay private: the API proxies every download after checking the claim and the
  signature, so there is no public object URL to leak.
- Uploads land under `YYYY-MM-DD/<uuid>-<name>`; the bucket needs no lifecycle rule, because archiving
  a product only stops new claims.

## Console allow list

`ADMIN_IP_ALLOWLIST=203.0.113.10,10.0.0.0/8` restricts the whole `/api/` surface to those addresses.
The Shopee push endpoint and the claim routes stay open, so buyers and Shopee are unaffected. Leave it
empty unless the operators have stable addresses: a wrong entry locks everyone out of the console
(fix it in `.env` and restart the API; the health endpoint is always reachable).

## Scaling and operations

| Need                   | Action                                                        |
| ---------------------- | ------------------------------------------------------------- |
| More API throughput    | `docker compose up -d --scale api=3` behind nginx (stateless) |
| More worker throughput | `--scale worker=2`; the queue lock keeps them apart           |
| Slower Shopee          | Raise `ORDER_RECONCILE_MINUTES`; jobs back off on their own   |
| Disk pressure          | Move `UPLOAD_DIR` to a larger volume; the path is one setting |

Health endpoints: `GET /health` (liveness, includes gateway mode) and `GET /ready` (database probe).
Compose healthchecks use `/health` for the API and `/` for the web app.

## Preflight before going live

`scripts/preflight.mjs` is the checklist as a command. It checks the environment (keys, origins, secure
cookies, push URL, and the Shopee credentials when the gateway is live), the service (health, database,
admin login, store tokens, dead letters, unmapped listings, audit chain) and, with `--public`, the three
public hostnames plus a signed push and a forged one:

```bash
node --env-file=.env scripts/preflight.mjs                       # local, against 127.0.0.1:4000
API_URL=https://api.qansa.web.id node --env-file=.env scripts/preflight.mjs --public
```

It exits non-zero on a blocking failure, so it can gate a deploy. A `404` on a public hostname means DNS
exists but the tunnel has no ingress row for it; the push probe reports `ignored` for a shop that is not
registered and `queued` for one that is.

## Post-deploy checklist

- [ ] `curl -s https://api.qansa.web.id/health` → `{"ok":true,...}` with the expected mode
- [ ] `claim.` shows the portal, `admin.` shows the login, `admin.` login works
- [ ] Adding a store and pressing **Sambungkan (simulasi)** produces a `CONNECTED` store
- [ ] Product sync fills the catalogue (Monitoring shows a succeeded `SYNC_PRODUCTS`)
- [ ] A mapping saves and the catalogue marks the listing "Siap"
- [ ] Order sync produces a claimable order for the fixture buyer
- [ ] `node scripts/smoke.mjs` with `API_URL=https://api.qansa.web.id` passes
- [ ] Shopee push registered; Monitoring shows `webhooks.configured: true`
- [ ] Backups scheduled and a restore rehearsed once
