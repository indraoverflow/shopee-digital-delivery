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

| Host | Serves | Notes |
|---|---|---|
| `claim.qansa.web.id` | Buyer portal | `/` only; `/admin` redirects to the console host |
| `admin.qansa.web.id` | Console | `/` rewrites to `/admin` |
| `api.qansa.web.id` | Fastify | `/webhook/shopee`, OAuth callback, signed downloads, health |

Both web hosts point at the same container. `proxy.ts` decides by `Host`.

### With the bundled nginx

```bash
docker compose --profile proxy up -d
```

nginx listens on `:8080` and routes by `server_name`. Put your tunnel or TLS terminator in front and
forward `Host` unchanged; the web app relies on it.

### With a Cloudflare tunnel

```yaml
ingress:
  - hostname: claim.qansa.web.id
    service: http://localhost:8080
  - hostname: admin.qansa.web.id
    service: http://localhost:8080
  - hostname: api.qansa.web.id
    service: http://localhost:8080
  - service: http_status:404
```

Set `SHOPEE_PUSH_URL=https://api.qansa.web.id/webhook/shopee` and register the same value in the
Shopee console. A trailing slash or a different scheme breaks the signature.

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

Two things must be backed up together, because a claim points at a file:

```bash
# database
docker exec qansa-delivery-postgres-1 pg_dump -U qansa -Fc qansa_delivery > qansa-$(date +%F).dump

# assets volume
docker run --rm -v qansa-delivery_uploads:/data -v "$PWD:/backup" alpine \
  tar czf /backup/qansa-uploads-$(date +%F).tar.gz -C /data .
```

Restore:

```bash
docker compose stop api worker
docker exec -i qansa-delivery-postgres-1 pg_restore -U qansa -d qansa_delivery --clean --if-exists < qansa-2026-11-12.dump
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

## Key rotation

`APP_ENCRYPTION_KEY` protects `shopee_tokens` and `digital_product_codes`. Rotating means decrypting
and re-encrypting every row while both keys are known. Procedure:

1. Take a dump first.
2. Deploy a build that accepts a `APP_ENCRYPTION_KEY_OLD` variable.
3. Run the re-encryption script once with both keys set.
4. Remove the old key, restart, and re-authorize any store that fails to read.

Not implemented as a CLI yet; the columns are the same cipher, so a 20-line script over
`packages/core`'s `decryptSecret`/`encryptSecret` is enough. Keep the old dump until a claim has been
served successfully.

## Scaling and operations

| Need | Action |
|---|---|
| More API throughput | `docker compose up -d --scale api=3` behind nginx (stateless) |
| More worker throughput | `--scale worker=2`; the queue lock keeps them apart |
| Slower Shopee | Raise `ORDER_RECONCILE_MINUTES`; jobs back off on their own |
| Disk pressure | Move `UPLOAD_DIR` to a larger volume; the path is one setting |

Health endpoints: `GET /health` (liveness, includes gateway mode) and `GET /ready` (database probe).
Compose healthchecks use `/health` for the API and `/` for the web app.

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
