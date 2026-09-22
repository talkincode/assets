#!/usr/bin/env bash
#
# Wire assets.talkincode.net/admin up to Cloudflare Access.
#
# Needs an API token with:
#   Account → Access: Apps and Policies → Edit
#   Account → Access: Service Tokens → Edit   (only for --service-token)
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... ./scripts/setup-access.sh
#   CLOUDFLARE_API_TOKEN=... ./scripts/setup-access.sh --service-token cli
#
# Without a token the same objects can be created by hand in the Zero Trust
# dashboard; docs/DEPLOY.md lists the exact fields.
set -euo pipefail

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-83b40c9065a6f4631f4ab6cda824a21a}"
ZONE_NAME="${ZONE_NAME:-talkincode.net}"
HOSTNAME="${HOSTNAME:-assets.${ZONE_NAME}}"
ADMIN_PATH="${ADMIN_PATH:-admin}"
APP_NAME="${APP_NAME:-Talkincode Assets}"
ALLOWED_EMAIL="${ALLOWED_EMAIL:-jamiesun.net@gmail.com}"
SERVICE_TOKEN_NAME="${SERVICE_TOKEN_NAME:-}"
API="https://api.cloudflare.com/client/v4"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-token) SERVICE_TOKEN_NAME="${2:-cli}"; shift 2 ;;
    --email) ALLOWED_EMAIL="$2"; shift 2 ;;
    --app-name) APP_NAME="$2"; shift 2 ;;
    --service-token=*) SERVICE_TOKEN_NAME="${1#*=}"; shift ;;
    --email=*) ALLOWED_EMAIL="${1#*=}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cat >&2 <<'MSG'
error: CLOUDFLARE_API_TOKEN is not set.

Create a token at https://dash.cloudflare.com/profile/api-tokens with
  Account → Access: Apps and Policies → Edit
and (for --service-token) Access: Service Tokens → Edit.
MSG
  exit 1
fi

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  fi
}

fail() {
  echo "error: $1" >&2
  exit 1
}

echo "==> zero trust organisation"
ORG="$(api GET "/accounts/$ACCOUNT_ID/access/organizations")"
echo "$ORG" | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error:", json.dumps(payload.get("errors")), file=sys.stderr)
    sys.exit(1)
result = payload["result"]
print("team domain:", result.get("auth_domain"))
' || fail "cannot read the Zero Trust organisation (is Zero Trust enabled, and does the token have Access scopes?)"

TEAM_DOMAIN="$(echo "$ORG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["auth_domain"])')"

echo "==> access application for ${HOSTNAME}/${ADMIN_PATH}"
APPS="$(api GET "/accounts/$ACCOUNT_ID/access/apps?per_page=100")"
APP_ID="$(echo "$APPS" | python3 -c '
import json,sys
name = sys.argv[1]
for app in json.load(sys.stdin).get("result") or []:
    if app.get("name") == name:
        print(app["id"])
        break
' "$APP_NAME")"

if [[ -z "$APP_ID" ]]; then
  CREATED="$(api POST "/accounts/$ACCOUNT_ID/access/apps" "$(python3 - "$HOSTNAME" "$ADMIN_PATH" "$APP_NAME" <<'PY'
import json,sys
hostname, path, name = sys.argv[1:4]
print(json.dumps({
    "name": name,
    "domain": hostname,
    "path": path,
    "type": "self_hosted",
    "session_duration": "24h",
    "app_launcher_visible": False,
    "auto_redirect_to_identity": False,
    "allowed_idps": [],
    "http_only_cookie_attribute": True,
    "same_site_cookie_attribute": "lax",
}))
PY
)")"
  APP_ID="$(echo "$CREATED" | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error:", json.dumps(payload.get("errors")), file=sys.stderr)
    sys.exit(1)
print(payload["result"]["id"])
')" || fail "could not create the Access application"
  echo "    created ($APP_ID)"
else
  echo "    reusing existing application ($APP_ID)"
fi

AUD="$(api GET "/accounts/$ACCOUNT_ID/access/apps/$APP_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["aud"])')"

echo "==> allow policy for ${ALLOWED_EMAIL}"
POLICIES="$(api GET "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies")"
POLICY_ID="$(echo "$POLICIES" | python3 -c '
import json,sys
for policy in json.load(sys.stdin).get("result") or []:
    if policy.get("name") == "allow-owner":
        print(policy["id"])
        break
')"
if [[ -z "$POLICY_ID" ]]; then
  api POST "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" "$(python3 - "$ALLOWED_EMAIL" <<'PY'
import json,sys
email = sys.argv[1]
print(json.dumps({
    "name": "allow-owner",
    "decision": "allow",
    "include": [{"email": {"email": email}}],
}))
PY
)" | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error:", json.dumps(payload.get("errors")), file=sys.stderr)
    sys.exit(1)
print("    created policy for", payload["result"]["name"])
' || fail "could not create the Access policy"
else
  echo "    policy already present ($POLICY_ID)"
fi

echo "==> wrangler.toml"
node "$ROOT/scripts/set-wrangler-vars.mjs" "ACCESS_TEAM_DOMAIN=$TEAM_DOMAIN" "ACCESS_AUD=$AUD"

if [[ -n "$SERVICE_TOKEN_NAME" ]]; then
  echo "==> access service token for the CLI"
  api POST "/accounts/$ACCOUNT_ID/access/service_tokens" "$(python3 - "$SERVICE_TOKEN_NAME" <<'PY'
import json,sys
name = sys.argv[1]
print(json.dumps({"name": name, "duration": "8760h"}))
PY
)" | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error:", json.dumps(payload.get("errors")), file=sys.stderr)
    sys.exit(1)
result = payload["result"]
print()
print("client id     :", result["client_id"])
print("client secret :", result["client_secret"])
print()
print("The secret is shown once. Export it where agents run:")
print("  export CF_ACCESS_CLIENT_ID=%s" % result["client_id"])
print("  export CF_ACCESS_CLIENT_SECRET=<secret>")
' || fail "could not create the service token"
fi

cat <<MSG

==> done.

Next:
  npm run deploy
  curl -sS https://${HOSTNAME}/health

The dashboard is now at https://${HOSTNAME}/${ADMIN_PATH}/ and only
${ALLOWED_EMAIL} can sign in.
MSG
