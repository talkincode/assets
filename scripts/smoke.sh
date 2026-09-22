#!/usr/bin/env bash
#
# End-to-end check against a deployed instance.
#
#   ASSETS_KEY=ak_... ./scripts/smoke.sh
#   ASSETS_KEY=ak_... ./scripts/smoke.sh --abuse     # also trips the brute-force guard
#
# The --abuse pass deliberately gets this source network blocked (first strike
# is 5 minutes), so it is opt-in.
set -euo pipefail

BASE="${ASSETS_BASE_URL:-https://assets.talkincode.net}"
ABUSE=0
[[ "${1:-}" == "--abuse" ]] && ABUSE=1

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

# Usage: check_status <label> <expected status> [curl args...] <url>
check_status() {
  local label="$1" expected="$2"
  shift 2
  local url="${!#}"
  local args=("${@:1:$#-1}")
  local actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' "${args[@]+"${args[@]}"}" "$url")"
  [[ "$actual" == "$expected" ]] && pass "$label ($actual)" || fail "$label: expected $expected, got $actual"
}

echo "target: $BASE"

echo "· health"
check_status "GET /health" 200 "$BASE/health"

echo "· upload"
[[ -n "${ASSETS_KEY:-}" ]] || fail "ASSETS_KEY is required for the upload checks"
tmp="$(mktemp -d)"
printf 'smoke test payload\n' > "$tmp/smoke.txt"
created="$(curl -sS -X POST "$BASE/api/upload?expires_in=1h&filename=smoke.txt" \
  -H "Authorization: Bearer $ASSETS_KEY" \
  -H "Content-Type: text/plain" \
  --data-binary "@$tmp/smoke.txt")"
if ! url="$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"; then
  fail "upload rejected: $created"
fi
hash="$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("hash",""))')"
[[ -n "$url" ]] || fail "upload rejected: $created"
[[ "$url" == "$BASE/"* ]] || fail "upload returned an unexpected url: $url"
pass "upload -> $url"

echo "· delivery"
body="$(curl -sS "$url")"
[[ "$body" == "smoke test payload" ]] && pass "body round-trips" || fail "body mismatch"
check_status "arbitrary filename resolves" 200 "${BASE}/${hash}/renamed-by-the-link.txt"
check_status "HEAD" 200 -I "$url"
check_status "range request" 206 -H 'Range: bytes=0-4' "$url"
check_status "expired/absent hash" 404 "${BASE}/ThisHashDoesNotExist00/x.txt"
check_status "reserved path" 404 "$BASE/favicon.ico"
check_status "no route" 404 "$BASE/a/b/c"
check_status "dashboard needs a session" 401 "$BASE/admin/api/me"
check_status "bad upload key" 401 -X POST -H "Authorization: Bearer ak_nope" --data-binary "@$tmp/smoke.txt" "$BASE/api/upload"

if [[ "$ABUSE" == "1" ]]; then
  echo "· brute-force guard (this blocks this source network on purpose)"
  code=0
  for _ in $(seq 1 40); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/ThisHashDoesNotExist00/x.txt")"
    [[ "$code" == "403" ]] && break
  done
  [[ "$code" == "403" ]] && pass "guard blocked the source (403)" || fail "guard never blocked the source"
fi

rm -rf "$tmp"
echo "smoke passed"
