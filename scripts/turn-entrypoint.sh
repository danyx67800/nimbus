#!/bin/sh
set -eu

: "${TURN_SECRET:?TURN_SECRET is required for the calls profile}"
: "${TURN_REALM:=nimbus}"

set -- \
  -n \
  --log-file=stdout \
  --pidfile=/tmp/turnserver.pid \
  --lt-cred-mech \
  --use-auth-secret \
  --static-auth-secret="$TURN_SECRET" \
  --realm="$TURN_REALM" \
  --fingerprint \
  --no-cli \
  --no-tls \
  --no-dtls \
  --min-port=49160 \
  --max-port=49200

# Docker/NAT: advertise the address peers can actually reach.
if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  set -- "$@" --external-ip="$TURN_EXTERNAL_IP"
fi

exec turnserver "$@"
