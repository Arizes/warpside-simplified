#!/bin/sh
set -e

# A mounted volume keeps its own ownership, which overrides whatever the image set: on Railway
# (and with a plain `docker run -v`) DATA_DIR arrives owned by root, so the snapshot and the map
# geometry cache fail with EACCES and every tick logs an error. Fix the ownership while still
# root, then drop to the unprivileged user to run the app itself.
if [ "$(id -u)" = "0" ]; then
  dir="${DATA_DIR:-/data}"
  mkdir -p "$dir"
  chown -R node:node "$dir"
  exec su-exec node "$@"
fi

exec "$@"
