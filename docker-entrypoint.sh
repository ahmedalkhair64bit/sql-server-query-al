#!/bin/sh
# Starts the app as the unprivileged "node" user with a writable data directory.
#
# Hosts such as Railway mount volumes owned by root, which a non-root image cannot write to. The container
# therefore starts as root only long enough to give the data directory to "node", then drops to that user
# for the app itself. Started as a non-root user already (docker run --user ...), it just runs the app.
set -e

# On Railway, follow the attached volume wherever it is mounted, unless DATA_DIR was set explicitly.
if [ -n "$RAILWAY_VOLUME_MOUNT_PATH" ] && [ "${DATA_DIR:-/data}" = "/data" ]; then
  DATA_DIR="$RAILWAY_VOLUME_MOUNT_PATH"
fi
DATA_DIR="${DATA_DIR:-/data}"
export DATA_DIR

if [ -n "$RAILWAY_ENVIRONMENT" ] && [ -z "$RAILWAY_VOLUME_MOUNT_PATH" ]; then
  echo "WARNING: no Railway volume is attached. Accounts, settings and analyses will be lost on the next" >&2
  echo "deploy. Attach a volume to this service (mount path /data) and redeploy." >&2
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only when needed: a recursive chown of a large plan store on every boot would slow restarts.
  if [ "$(stat -c %U "$DATA_DIR")" != "node" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
