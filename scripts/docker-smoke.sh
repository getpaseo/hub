#!/bin/sh
set -eu

image="paseo-hub-phase-zero-smoke"
container="paseo-hub-phase-zero-smoke-$$"
database="paseo-hub-phase-zero-postgres-$$"
network="paseo-hub-phase-zero-smoke-$$"
embedded="paseo-hub-embedded-smoke-$$"
intruder="paseo-hub-embedded-intruder-$$"
volume="paseo-hub-embedded-smoke-$$"

cleanup() {
  docker stop "$container" "$database" >/dev/null 2>&1 || true
  docker rm --force "$embedded" "$intruder" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}

wait_healthy() {
  port="$(docker port "$1" 3000/tcp | sed 's/.*://')"
  attempt=0
  until curl --fail --silent "http://127.0.0.1:$port/health" | grep --quiet '"ok":true'; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      docker logs "$1"
      exit 1
    fi
    sleep 1
  done
}

trap cleanup EXIT INT TERM

docker build --tag "$image" .
docker network create "$network" >/dev/null
docker run --detach --rm --name "$database" --network "$network" \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=paseo_hub \
  postgres:17-alpine >/dev/null

attempt=0
until docker exec "$database" pg_isready --username postgres --dbname paseo_hub >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$database"
    exit 1
  fi
  sleep 1
done

docker run --detach --rm --name "$container" --network "$network" \
  --env "DATABASE_URL=postgres://postgres:postgres@$database:5432/paseo_hub" \
  --publish 127.0.0.1::3000 \
  "$image" >/dev/null

wait_healthy "$container"

# Embedded mode runs Hub as PID 1 on a data volume. A SIGKILL must not leave a lock that blocks
# the restart, and a second container on the same volume must be refused.
docker run --detach --name "$embedded" --hostname hub \
  --volume "$volume:/data" --env PASEO_HUB_DATA_DIR=/data \
  --publish 127.0.0.1::3000 \
  "$image" node dist/index.js >/dev/null
wait_healthy "$embedded"
docker kill --signal KILL "$embedded" >/dev/null
docker start "$embedded" >/dev/null
wait_healthy "$embedded"

docker run --detach --name "$intruder" --hostname hub \
  --volume "$volume:/data" --env PASEO_HUB_DATA_DIR=/data \
  "$image" node dist/index.js >/dev/null
attempt=0
until [ "$(docker inspect --format '{{.State.Status}}' "$intruder")" = exited ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "a second Hub started on a data directory that another Hub holds" >&2
    exit 1
  fi
  sleep 1
done
if [ "$(docker inspect --format '{{.State.ExitCode}}' "$intruder")" -eq 0 ] ||
  ! docker logs "$intruder" 2>&1 | grep --quiet "already in use by another Paseo Hub process"; then
  docker logs "$intruder"
  exit 1
fi
