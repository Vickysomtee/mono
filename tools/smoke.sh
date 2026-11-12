#!/bin/sh
# Checks the behaviour we care about: a replayed Idempotency-Key must come back
# as 409 with the original id, from whichever pod answers.
set -e

URL="${1:-http://localhost:8080}"
KEY="smoke-$(date +%s)-$$"
BODY='{"type":"order.updated","data":"smoke"}'

post() {
  curl -sS -o /tmp/relay-smoke.body -w '%{http_code}' \
    -X POST "$URL/events" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $KEY" \
    -d "$BODY"
}

fail() { echo "FAIL: $1"; exit 1; }

echo "health:  $(curl -sS -o /dev/null -w '%{http_code}' "$URL/health")"
echo "live:    $(curl -sS -o /dev/null -w '%{http_code}' "$URL/live")"

code=$(post)
[ "$code" = "201" ] || fail "first POST expected 201, got $code"
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/relay-smoke.body)
echo "create:  201 id=$id"

i=1
while [ $i -le 10 ]; do
  code=$(post)
  [ "$code" = "409" ] || fail "replay $i expected 409, got $code ($(cat /tmp/relay-smoke.body))"
  replay_id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/relay-smoke.body)
  [ "$replay_id" = "$id" ] || fail "replay $i returned id $replay_id, expected $id"
  i=$((i + 1))
done
echo "replay:  409 x10, id stable"

code=$(curl -sS -o /dev/null -w '%{http_code}' "$URL/events/$id")
[ "$code" = "200" ] || fail "GET /events/$id expected 200, got $code"
echo "read:    200"

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL/events" \
  -H 'Content-Type: application/json' -d "$BODY")
[ "$code" = "400" ] || fail "missing key expected 400, got $code"
echo "no key:  400"

echo "PASS"
