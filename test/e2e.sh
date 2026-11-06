#!/bin/sh
set -eu

state_dir="$(mktemp -d "${TMPDIR:-/tmp}/octopool-smoke.XXXXXX")"
trap 'rm -rf "$state_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

host="${OCTOPOOL_E2E_HOST:-octopool.dev}"
resolver="${OCTOPOOL_E2E_RESOLVER:-1.1.1.1}"
ip="$(dig +short "$host" A @"$resolver" | head -n 1)"

if [ -z "$ip" ]; then
  echo "no A record for $host via $resolver" >&2
  exit 1
fi

root_html="$(curl --resolve "$host:443:$ip" -fsS "https://$host/")"
printf "%s" "$root_html" | grep -q '<title>octopool</title>'
if [ "$host" = "octopool.dev" ]; then
  printf "%s" "$root_html" | grep -q 'brew install openclaw/tap/octopool'
  if printf "%s" "$root_html" | grep -q 'Sign in with GitHub'; then
    echo "octopool.dev should not expose website login CTA" >&2
    exit 1
  fi
else
  printf "%s" "$root_html" | grep -q 'Sign in with GitHub'
fi

curl --resolve "$host:80:$ip" -sS -o /dev/null -D "$state_dir/http.headers" \
  "http://$host/dashboard"
grep -q '^HTTP/1.1 308' "$state_dir/http.headers"
grep -qi '^location: https://'"$host"'/dashboard' "$state_dir/http.headers"

dashboard_code="$(
  curl --resolve "$host:443:$ip" -sS -o /dev/null -D "$state_dir/dashboard.headers" -w "%{http_code}" \
    "https://$host/dashboard"
)"
test "$dashboard_code" = "302"
if [ "$host" = "octopool.dev" ]; then
  grep -qi '^location: https://octopool.openclaw.ai/dashboard' "$state_dir/dashboard.headers"
  dashboard_api_code="$(
    curl --resolve "$host:443:$ip" -sS -o /dev/null -w "%{http_code}" \
      "https://$host/v1/dashboard"
  )"
  test "$dashboard_api_code" = "404"
else
  grep -qi '^location: https://'"$host"'/login/github?next=%2Fdashboard' "$state_dir/dashboard.headers"
fi

curl --resolve "$host:443:$ip" -sS -o /dev/null -D "$state_dir/https.headers" \
  "https://$host/"
grep -qi '^strict-transport-security: max-age=31536000; includeSubDomains; preload' \
  "$state_dir/https.headers"

root_json="$(curl --resolve "$host:443:$ip" -fsS -H "accept: application/json" "https://$host/")"
printf "%s" "$root_json" | grep -q '"ok":true'
printf "%s" "$root_json" | grep -q '"service":"octopool"'

discovery_json="$(curl --resolve "$host:443:$ip" -fsS "https://$host/.well-known/octopool")"
printf "%s" "$discovery_json" | grep -q '"service":"octopool"'
printf "%s" "$discovery_json" | grep -q '"cli_github_token":true'
if [ "$host" = "octopool.dev" ]; then
  printf "%s" "$discovery_json" | grep -q '"api_base":"https://octopool.dev"'
  printf "%s" "$discovery_json" | grep -q '"app_base":"https://octopool.openclaw.ai"'
else
  printf "%s" "$discovery_json" | grep -q '"api_base":"https://'"$host"'"'
fi

health_code="$(
  curl --resolve "$host:443:$ip" -sS -o "$state_dir/health.json" -w "%{http_code}" \
    "https://$host/v1/pools/maintainers/health"
)"
test "$health_code" = "401"
grep -q '"code":"missing_auth"' "$state_dir/health.json"

relay_code="$(
  curl --resolve "$host:443:$ip" -sS -o "$state_dir/relay.json" -w "%{http_code}" \
    -H "content-type: application/json" \
    -d '{"pool":"maintainers","method":"GET","path":"/repos/openclaw/openclaw/pulls/1"}' \
    "https://$host/v1/github/request"
)"
test "$relay_code" = "401"
grep -q '"code":"missing_auth"' "$state_dir/relay.json"

echo "octopool e2e ok: $host via $ip"
