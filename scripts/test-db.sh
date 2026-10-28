#!/bin/sh
# Throwaway Postgres for the real-database tests. Plain Docker: no extra dependency.
#
#   sh scripts/test-db.sh up     start a fresh, empty database and print the URL to export
#   sh scripts/test-db.sh down   remove it
#   sh scripts/test-db.sh url    print the URL again
#
# Safe by construction: the container is removed when stopped, keeps its data in memory, and
# listens on 127.0.0.1 only (never on the network). The database is named cargodev_test and the
# password is a throwaway that protects nothing. The tests refuse to run against anything else
# (see tests/db/guard.ts), and never read DATABASE_URL.
#
# Without sh/npm (for example in PowerShell) run the same `docker run` shown below by hand.

set -eu

NAME="cargodev-api-test-db"
PORT="${TEST_DB_PORT:-55432}"
IMAGE="${TEST_DB_IMAGE:-postgres:16}"
DB="cargodev_test"
USER_NAME="postgres"
PASSWORD="example-throwaway-password"
URL="postgresql://${USER_NAME}:${PASSWORD}@127.0.0.1:${PORT}/${DB}"

need_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is not installed or not on PATH." >&2
    echo "Install Docker, or use any Postgres reachable only on localhost with a database named ${DB}." >&2
    exit 1
  }
}

print_url() {
  echo ""
  echo "Throwaway database is ready. In the shell you run the tests from:"
  echo ""
  echo "  export TEST_DATABASE_URL='${URL}'      # PowerShell: \$env:TEST_DATABASE_URL='${URL}'"
  echo "  npm run test:db"
  echo ""
}

case "${1:-}" in
  up)
    need_docker
    # Always start from nothing: remove a previous container with the same name.
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --rm --name "$NAME" \
      -e POSTGRES_PASSWORD="$PASSWORD" \
      -e POSTGRES_DB="$DB" \
      -p "127.0.0.1:${PORT}:5432" \
      --tmpfs /var/lib/postgresql/data \
      "$IMAGE" -c fsync=off -c max_connections=100 >/dev/null

    printf "Waiting for Postgres"
    tries=0
    # Over TCP on purpose: during first start the image runs a temporary server that only
    # listens on a Unix socket, so a TCP check passes only for the final server.
    until docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U "$USER_NAME" -d "$DB"; do
      tries=$((tries + 1))
      if [ "$tries" -ge 60 ]; then
        echo " timed out." >&2
        docker logs "$NAME" >&2 || true
        exit 1
      fi
      printf "."
      sleep 1
    done
    echo " ready."
    print_url
    ;;
  down)
    need_docker
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "Removed ${NAME}." || echo "${NAME} was not running."
    ;;
  url)
    echo "$URL"
    ;;
  *)
    echo "usage: sh scripts/test-db.sh up|down|url" >&2
    exit 2
    ;;
esac
