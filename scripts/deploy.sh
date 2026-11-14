#!/usr/bin/env bash
#
# Deploy a published image set and put it back if the stack does not come up.
#
#   scripts/deploy.sh <commit-sha>     # deploy that build
#   scripts/deploy.sh latest           # whatever was built last
#
# Images come from GHCR (see .github/workflows/images.yml), so this host only pulls. The
# previously deployed tag is written to .deploy-tag, and a failed health check rolls back to it
# automatically: a deploy that leaves the portal down is worse than the version it replaced.
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: scripts/deploy.sh <commit-sha|latest>" >&2
  exit 2
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.pull.yml)
API_PORT="${API_HOST_PORT:-4000}"
WEB_PORT="${WEB_HOST_PORT:-3300}"
STATE_FILE=".deploy-tag"

previous=""
if [[ -f "$STATE_FILE" ]]; then
  previous="$(tr -d '[:space:]' <"$STATE_FILE")"
fi

wait_healthy() {
  local url="http://127.0.0.1:${API_PORT}/health"
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

bring_up() {
  local tag="$1"
  IMAGE_TAG="$tag" "${COMPOSE[@]}" pull --quiet
  IMAGE_TAG="$tag" "${COMPOSE[@]}" up -d
}

echo "deploying ${TAG}"
bring_up "$TAG"

if wait_healthy; then
  printf '%s\n' "$TAG" >"$STATE_FILE"
  echo "api healthy on ${API_PORT}; portal on ${WEB_PORT}"
  echo "web: $(curl -fsS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/" || echo failed)"
  exit 0
fi

echo "api did not become healthy on tag ${TAG}" >&2
if [[ -n "$previous" && "$previous" != "$TAG" ]]; then
  echo "rolling back to ${previous}" >&2
  bring_up "$previous"
  if wait_healthy; then
    echo "rolled back, api healthy on ${previous}" >&2
  else
    echo "rollback did not come up either; check docker compose logs api" >&2
  fi
else
  echo "nothing to roll back to; check docker compose logs api" >&2
fi
exit 1
