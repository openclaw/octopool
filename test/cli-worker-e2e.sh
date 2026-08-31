#!/bin/sh
set -eu

port="${OCTOPOOL_CLI_WORKER_E2E_PORT:-18787}"
state_dir="$(mktemp -d "${TMPDIR:-/tmp}/octopool-cli-worker.XXXXXX")"
worker_log="$state_dir/wrangler.log"
migration_log="$state_dir/migrations.log"
binary="$state_dir/octopool"
base_url="http://127.0.0.1:$port"
caller_token="octopool-e2e-caller-token"
caller_hash="e5rKdZ4MIfLksXT_641m9weO2LawisHnqrwEZtn6uTM"
worker_pid=""

cleanup() {
  if [ -n "$worker_pid" ]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! pnpm exec wrangler d1 migrations apply DB \
  --local --persist-to "$state_dir" >"$migration_log" 2>&1 </dev/null; then
  cat "$migration_log" >&2
  exit 1
fi

seed_sql="INSERT INTO pools (id, name, policy_json) VALUES ('maintainers', 'maintainers', '{\"allowed_owners\":[\"openclaw\"],\"allow_public_repos\":true,\"allow_search\":true,\"allow_logs\":true}'); INSERT INTO callers (id, name, token_hash, github_login, org_login, org_identity_verified_at, status, github_user_id) VALUES ('cli-e2e', 'CLI E2E', '$caller_hash', 'cli-e2e', 'openclaw', CURRENT_TIMESTAMP, 'active', 424242); INSERT INTO caller_tokens (id, caller_id, token_hash, client_name) VALUES ('cli-e2e-token', 'cli-e2e', '$caller_hash', 'cli-e2e'); INSERT INTO caller_pools (caller_id, pool_id) VALUES ('cli-e2e', 'maintainers');"
pnpm exec wrangler d1 execute DB \
  --local --persist-to "$state_dir" --command "$seed_sql" --json >/dev/null

pnpm exec wrangler dev --local --port "$port" --persist-to "$state_dir" \
  --local-upstream localhost --upstream-protocol http \
  --show-interactive-dev-session=false >"$worker_log" 2>&1 &
worker_pid=$!

attempt=0
until curl -fsS -H "accept: application/json" "$base_url/" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 80 ] || ! kill -0 "$worker_pid" 2>/dev/null; then
    cat "$worker_log" >&2
    echo "local Worker did not become ready" >&2
    exit 1
  fi
  sleep 0.25
done

go build -o "$binary" ./cmd/octopool

run_cli() {
    OCTOPOOL_TOKEN="$caller_token" \
    OCTOPOOL_URL="$base_url" \
    OCTOPOOL_POOL=maintainers \
    "$binary" gh api repos/openclaw/octopool
}

first="$(run_cli)"
second="$(run_cli)"
printf "%s\n%s" "$first" "$second" | node -e '
const fs = require("node:fs");
const results = fs.readFileSync(0, "utf8").split("\n").map(JSON.parse);
if (results.length !== 2 || results.some((result) => result.name !== "octopool")) {
  throw new Error(`unexpected CLI output: ${JSON.stringify(results)}`);
}
'

proof_matches() {
  printf "%s" "$1" | node -e '
const fs = require("node:fs");
const rows = JSON.parse(fs.readFileSync(0, "utf8"));
const audits = rows[0]?.results;
const entries = rows[1]?.results?.[0]?.cache_entries;
const expected = [
  { cache_status: "miss", identity_id: null, status: 200 },
  { cache_status: "hit", identity_id: null, status: 200 },
];
if (JSON.stringify(audits) !== JSON.stringify(expected) || entries !== 1) {
  throw new Error(`unexpected cache proof: ${JSON.stringify(rows)}`);
}
'
}

attempt=0
while :; do
  proof="$(pnpm exec wrangler d1 execute DB \
    --local --persist-to "$state_dir" --json \
    --command "SELECT cache_status, identity_id, status FROM audit_events ORDER BY rowid; SELECT COUNT(*) AS cache_entries FROM github_cache_entries;")"
  if proof_matches "$proof" 2>/dev/null; then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 40 ]; then
    proof_matches "$proof"
    exit 1
  fi
  sleep 0.25
done

echo "octopool CLI→Worker e2e ok: token-free miss + D1/edge hit"
