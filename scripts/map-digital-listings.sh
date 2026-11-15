#!/usr/bin/env bash
# Catalogue mapping helper for the digital listings.
#
# The four live shops sync 660 software listings and none of them had a mapping,
# so every paid order stopped at "unmapped". Creating the products by hand first
# does not scale past a few dozen, and leaving them unmapped hides which listings
# are still waiting for an asset.
#
#   ./scripts/map-digital-listings.sh list           # what is unmapped, per shop
#   ./scripts/map-digital-listings.sh draft          # create DRAFT products + mappings
#   ./scripts/map-digital-listings.sh count          # how many are left
#
# Drafts are safe: an order mapped to a DRAFT product is refused with
# PRODUCT_NOT_ACTIVE instead of delivering something empty.
set -euo pipefail

cd "$(dirname "$0")/.."

CATEGORIES="${DIGITAL_CATEGORY_IDS:-101937}"
CATEGORY_SQL="'{$CATEGORIES}'::text[]"

psql_q() {
  docker compose exec -T postgres psql -U qansa -d qansa_delivery -v ON_ERROR_STOP=1 "$@"
}

case "${1:-list}" in
list)
  psql_q -c "
    select s.shop_name,
           count(*) as belum_dipetakan
      from shopee_products p
      join shopee_stores s on s.id = p.store_id
      left join product_mappings m
             on m.shopee_product_id = p.id and m.shopee_variation_id is null
     where p.deleted_at is null
       and m.id is null
       and p.status = 'NORMAL'
       and s.environment = 'PRODUCTION'
       and (p.raw->>'category_id') = any($CATEGORY_SQL)
     group by 1
     order by 2 desc;"
  ;;
draft)
  # Two statements, not one: rows inserted by a data-modifying CTE are invisible to
  # the rest of that same statement, so the mapping insert has to run after the
  # products exist. Both are idempotent.
  psql_q -c "
    insert into digital_products (name, slug, delivery_kind, status, instructions)
    select left(p.name, 180),
           'shopee-' || p.item_id,
           'LINK',
           'DRAFT',
           'Menunggu aset: isi tautan atau berkas, lalu aktifkan produk ini.'
      from shopee_products p
      join shopee_stores s on s.id = p.store_id
      left join product_mappings m
             on m.shopee_product_id = p.id and m.shopee_variation_id is null
     where p.deleted_at is null
       and m.id is null
       and p.status = 'NORMAL'
       and s.environment = 'PRODUCTION'
       and (p.raw->>'category_id') = any($CATEGORY_SQL)
    on conflict (slug) do nothing;"

  psql_q -c "
    insert into product_mappings (store_id, shopee_product_id, digital_product_id, note)
    select p.store_id, p.id, d.id, 'draft otomatis dari katalog Shopee'
      from shopee_products p
      join shopee_stores s on s.id = p.store_id
      join digital_products d on d.slug = 'shopee-' || p.item_id
      left join product_mappings m
             on m.shopee_product_id = p.id and m.shopee_variation_id is null
     where p.deleted_at is null
       and m.id is null
       and p.status = 'NORMAL'
       and s.environment = 'PRODUCTION'
       and (p.raw->>'category_id') = any($CATEGORY_SQL)
    on conflict do nothing;"

  psql_q -c "
    select count(*) filter (where d.status = 'DRAFT' and d.external_url is null) as draft_tanpa_aset,
           count(*) filter (where d.status = 'ACTIVE') as aktif
      from product_mappings m
      join digital_products d on d.id = m.digital_product_id
     where d.slug like 'shopee-%';"
  ;;
count)
  psql_q -tAc "
    select count(*)
      from shopee_products p
      join shopee_stores s on s.id = p.store_id
      left join product_mappings m
             on m.shopee_product_id = p.id and m.shopee_variation_id is null
     where p.deleted_at is null
       and m.id is null
       and p.status = 'NORMAL'
       and s.environment = 'PRODUCTION'
       and (p.raw->>'category_id') = any($CATEGORY_SQL);"
  ;;
*)
  echo "usage: $0 [list|draft|count]" >&2
  exit 2
  ;;
esac
