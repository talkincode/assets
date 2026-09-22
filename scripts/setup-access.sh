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
# The Access API rejects an application whose domain is not explicitly claimed
# by a zone in this account (error 12130), so zone_name is required.
ASSETS_HOSTNAME="${ASSETS_HOSTNAME:-assets.${ZONE_NAME}}"   # not $HOSTNAME: that is the machine name
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
TEAM_DOMAIN="$(echo "$ORG" | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error: " + json.dumps(payload.get("errors")), file=sys.stderr)
    sys.exit(1)
print(payload["result"]["auth_domain"])
')" || fail "cannot read the Zero Trust organisation (is Zero Trust enabled, and does the token have Access scopes?)"
echo "team domain: $TEAM_DOMAIN"

echo "==> access application for ${ASSETS_HOSTNAME}/${ADMIN_PATH}"
APPS="$(api GET "/accounts/$ACCOUNT_ID/access/apps?per_page=100")"
APP_ID="$(echo "$APPS" | python3 -c '
import json,sys
name = sys.argv[1]
for app in json.load(sys.stdin).get("result") or []:
    if app.get("name") == name:
        print(app["id"])
        break
' "$APP_NAME")"

AUD=""
if [[ -z "$APP_ID" ]]; then
  CREATED="$(api POST "/accounts/$ACCOUNT_ID/access/apps" "$(python3 -c '
import json,sys
hostname, path, name = sys.argv[1], sys.argv[2], sys.argv[3]
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
    "zone_name": sys.argv[4],
}) )
' "$ASSETS_HOSTNAME" "$ADMIN_PATH" "$APP_NAME" "$ZONE_NAME")")"
  APP_ID="$(echo "$CREATED" | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error: " + json.dumps(payload.get("errors")), file=sys.stderr)
    sys.exit(1)
print(payload["result"]["id"])
')" || fail "could not create the Access application"
  echo "    created ($APP_ID)"
else
  echo "    reusing existing application ($APP_ID)"
fi

AUD="$(api GET "/accounts/$ACCOUNT_ID/access/apps/$APP_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["aud"])')"

echo "==> deny-everyone-else policy"
DENY_ID="$(api GET "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" | python3 -c '
import json,sys
for policy in json.load(sys.stdin).get("result") or []:
    if policy.get("name") == "deny-everyone-else":
        print(policy["id"])
        break
')"
if [[ -z "$DENY_ID" ]]; then
  api POST "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" \
    '{"name":"deny-everyone-else","decision":"deny","include":[{"everyone":{}}]}' \
    | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error: " + json.dumps(payload.get("errors")), file=sys.stderr)
    sys.exit(1)
print("    created", payload["result"]["name"])
' || fail "could not create the deny policy"
else
  echo "    policy already present ($DENY_ID)"
fi

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
  api POST "/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" "$(python3 -c '
import json,sys
print(json.dumps({
    "name": "allow-owner",
    "decision": "allow",
    "include": [{"email": {"email": sys.argv[1]}}],
}))
' "$ALLOWED_EMAIL")" | python3 -c '
import json,sys
payload = json.load(sys.stdin)
if not payload.get("success"):
    print("error: " + json.dumps(payload.get("errors")), file=sys.stderr)
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
  # Policies are an allow-list, so the email rule alone would never let a
  # service token through: create the token and its matching policy together.
  SERVICE_OUTPUT="$(python3 -c '
import json, sys, urllib.error, urllib.request

account_id, app_id, name, api, token = sys.argv[1:6]

def call(method, path, body=None):
    request = urllib.request.Request(
        api + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return json.load(error)

listed = call("GET", "/accounts/%s/access/service_tokens" % account_id)
existing = [t for t in (listed.get("result") or []) if t.get("name") == name]
if existing:
    # Secrets are shown once and cannot be recovered: never silently issue a
    # second token with the same name, or the caller would keep using a stale one.
    print(existing[0]["client_id"], "", existing[0]["id"], "EXISTS", sep="\t")
    raise SystemExit(0)
created = call("POST", "/accounts/%s/access/service_tokens" % account_id,
               {"name": name, "duration": "8760h"})
if not created.get("success"):
    sys.exit("creating the service token failed: %s" % created.get("errors"))
result = created["result"]

policies = call("GET", "/accounts/%s/access/apps/%s/policies" % (account_id, app_id))
existing = [p for p in (policies.get("result") or []) if p.get("name") == "allow-cli-token"]
if not existing:
    made = call("POST", "/accounts/%s/access/apps/%s/policies" % (account_id, app_id), {
        "name": "allow-cli-token",
        # "non_identity", not "allow": service tokens carry no user identity, so
        # an "allow" policy never matches them and every call falls back to 302.
        "decision": "non_identity",
        "include": [{"service_token": {"token_id": result["id"]}}],
    })
    if not made.get("success"):
        sys.exit("creating the service token policy failed: %s" % made.get("errors"))

print(result["client_id"], result["client_secret"], result["id"], "NEW", sep="\t")
' "$ACCOUNT_ID" "$APP_ID" "$SERVICE_TOKEN_NAME" "$API" "$CLOUDFLARE_API_TOKEN")" \
    || fail "could not create the service token"

  CLIENT_ID="$(printf '%s' "$SERVICE_OUTPUT" | cut -f1)"
  CLIENT_SECRET="$(printf '%s' "$SERVICE_OUTPUT" | cut -f2)"
  TOKEN_ID="$(printf '%s' "$SERVICE_OUTPUT" | cut -f3)"
  STATE="$(printf '%s' "$SERVICE_OUTPUT" | cut -f4)"

  echo "    service token id : $TOKEN_ID"
  echo "    client id        : $CLIENT_ID"
  if [[ "$STATE" == "EXISTS" ]]; then
    cat <<MSG
    client secret    : already issued — secrets are shown once and cannot be
                       recovered; use --service-token <new-name> to mint another.

Existing credentials keep working (allowed by this app's "allow-cli-token"
policy). Point the CLI at them with:

  export CF_ACCESS_CLIENT_ID=$CLIENT_ID
  export CF_ACCESS_CLIENT_SECRET=<secret>
MSG
  else
    cat <<MSG
    client secret    : $CLIENT_SECRET

The secret is shown once. Export it where agents run:

  export CF_ACCESS_CLIENT_ID=$CLIENT_ID
  export CF_ACCESS_CLIENT_SECRET=<secret>

(allowed by this application's "allow-cli-token" policy)
MSG
  fi
fi

cat <<MSG

==> done.

Next:
  npx wrangler deploy
  curl -sS https://${ASSETS_HOSTNAME}/health

The dashboard is now at https://${ASSETS_HOSTNAME}/${ADMIN_PATH}/ and only
${ALLOWED_EMAIL} can sign in.
MSG
