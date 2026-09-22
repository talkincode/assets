#!/usr/bin/env bash
#
# End-to-end check against a deployed instance.
#
#   ASSETS_KEY=ak_... ./scripts/smoke.sh
#   ASSETS_KEY=ak_... ./scripts/smoke.sh --abuse     # also trips the brute-force guard
#
# Set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (or pass --env-file) to also
# verify the Cloudflare Access-protected admin API.
#
# The --abuse pass deliberately gets this source network blocked (first strike
# is 5 minutes), so it is opt-in.
set -euo pipefail

BASE="${ASSETS_BASE_URL:-https://assets.talkincode.net}"
ABUSE=0
# Usage: smoke.sh [--abuse] [env-file]
# The env file (default ~/.config/talkincode-assets/env) carries the Access
# service token used to verify the protected admin API.
ENV_FILE=""
for arg in "$@"; do
  case "$arg" in
    --abuse) ABUSE=1 ;;
    *) ENV_FILE="$arg" ;;
  esac
done
ENV_FILE="${ENV_FILE:-$HOME/.config/talkincode-assets/env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

# Usage: check_status <label> <expected status> [curl args...] <url>
check_status() {
  check_any "$1" "$2" "${@:3}"
}

# Usage: check_any <label> "<code>|<code>..." [curl args...] <url>
# Several accepted codes let one script cover both a bare deployment (the
# worker answers 401/503) and one that is already behind Cloudflare Access (302).
check_any() {
  local label="$1" expected="$2"
  shift 2
  local url="${!#}"
  local args=("${@:1:$#-1}")
  local actual
  actual="$(curl -sS -o /dev/null -w '%{http_code}' "${args[@]+"${args[@]}"}" "$url")"
  if [[ " ${expected//|/ } " == *" $actual "* ]]; then
    pass "$label ($actual)"
  else
    fail "$label: expected $expected, got $actual"
  fi
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
check_any "dashboard page needs a session" "302|401" "$BASE/admin/"
check_any "dashboard API needs a session" "302|401" "$BASE/admin/api/me"
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  check_status "admin API accepts the Access service token" 200 "$BASE/admin/api/me" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
fi
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
