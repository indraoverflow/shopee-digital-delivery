#!/usr/bin/env bash
#
# Reclaim disk without touching anything that is still in use.
#
#   scripts/prune.sh            # dry run: list what would go, remove nothing
#   scripts/prune.sh --apply    # remove it
#
# Deliberately conservative: dangling images, build cache and stopped containers older than a
# week, and never a tagged image. Volumes are never removed, because an unused volume on this host can still be the only
# copy of something, and `docker image prune -a` would delete the previous release tag that a
# rollback needs.
set -euo pipefail

apply=false
case "${1:-}" in
  --apply) apply=true ;;
  "") ;;
  *) echo "usage: scripts/prune.sh [--apply]" >&2; exit 2 ;;
esac

echo "before"
docker system df

echo
echo "dangling images: $(docker images -f dangling=true -q | wc -l)"
docker images -f dangling=true --format '  {{.ID}} {{.Size}}' | head -10

if [[ "$apply" != true ]]; then
  echo
  echo "dry run, nothing removed. Re-run with --apply."
  exit 0
fi

echo
# No age filter here: a dangling image carries no tag, so it cannot be a rollback target, and
# on a full disk the ones from the last build are exactly the ones worth removing.
echo "--- removing dangling images"
docker image prune -f

echo "--- removing build cache older than 7 days"
docker builder prune -f --filter "until=168h" || echo "  builder prune unavailable, skipped"

echo "--- removing stopped containers older than 7 days"
docker container prune -f --filter "until=168h"

echo
echo "after"
docker system df
echo
echo "volumes are left alone on purpose. To see them:"
echo "  docker volume ls --filter dangling=true"
