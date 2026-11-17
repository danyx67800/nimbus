#!/bin/sh
set -eu

: "${TURN_SECRET:?TURN_SECRET is required for the calls profile}"
: "${TURN_REALM:=nimbus}"

exec turnserver \
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
