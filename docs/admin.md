# Admin & Provisioning

Pools and identities are admin-managed. Verified org members can `octopool login` into
the default login pool automatically; admin caller registration remains available for
manual backfills and token issuance. Admin actions use the admin token (see
[Auth](auth.md#admin-auth)).

Source: `src/provisioning.ts`, `src/router.ts`, `cmd/octopool/main.go`.

## Provision a caller

Registers a GitHub org member as a relay caller and grants them a pool. The Worker
resolves the immutable GitHub user id and verifies that same account's org membership, then returns a
one-time caller token. Enrollment stores the identity-bound verification time in
`org_identity_verified_at`, so the issued token uses the normal membership TTL immediately.

API: `POST /v1/admin/callers`

```json
{ "pool": "maintainers", "github_login": "steipete", "name": "Peter" }
```

CLI:

```sh
OCTOPOOL_ADMIN_TOKEN=… octopool admin caller \
  --pool maintainers --github-login steipete --name Peter
```

In practice callers usually run `octopool login`, which creates or refreshes this grant
for the default login pool automatically. Use this admin command for manual backfills,
nonstandard pools, or one-time token issuance.

Admin provisioning uses the same atomic active-ID/org enrollment as CLI and browser
login. It adds only the requested pool grant and rotates the named `admin` client under
the shared 16-client cap; it does not promote dashboard roles. Existing active singleton
roles and grants remain attached to their caller ID. A disabled row stays disabled; a
fresh enrollment starts with role `none` and does not inherit its authority.

Before upgrading, follow the [atomic enrollment migration gate](operations.md#atomic-enrollment-upgrade).
Ambiguous active duplicates require an explicit operator ownership decision. There is no
automatic survivor selection, grant union, role promotion, or token/session transfer.

## Register an identity

Creates or updates a pooled GitHub identity and its repo scopes. The secret material is
stored separately as a Cloudflare Worker secret; only the binding name (`secret_ref`) and
metadata live in D1.

API: `POST /v1/admin/pools/:pool/identities`

PAT identity:

```json
{
  "id": "pat_steipete",
  "kind": "pat",
  "login": "steipete",
  "secret_ref": "OCTOPOOL_PAT_STEIPETE",
  "scopes": [{ "owner": "openclaw" }],
  "weight": 100
}
```

GitHub App identity:

```json
{
  "id": "ghapp_openclaw_openclaw",
  "kind": "github_app",
  "login": "octopool-cache",
  "secret_ref": "OCTOPOOL_GITHUB_APP_PRIVATE_KEY",
  "installation_id": 135990630,
  "scopes": [{ "owner": "openclaw", "repo": "openclaw" }]
}
```

CLI:

```sh
# PAT, owner-wide scope
OCTOPOOL_ADMIN_TOKEN=… octopool admin identity \
  --id pat_steipete --login steipete --secret-ref OCTOPOOL_PAT_STEIPETE \
  --scope openclaw

# PAT, broad public-repo cache identity
OCTOPOOL_ADMIN_TOKEN=… octopool admin identity \
  --id pat_public --login steipete --secret-ref OCTOPOOL_PAT_STEIPETE \
  --scope '*'

# GitHub App, single repo scope
OCTOPOOL_ADMIN_TOKEN=… octopool admin identity \
  --kind github_app --installation-id 135990630 \
  --id ghapp_openclaw_openclaw --login octopool-cache \
  --secret-ref OCTOPOOL_GITHUB_APP_PRIVATE_KEY \
  --scope openclaw/openclaw
```

Notes:

- `--scope owner/repo` grants a single repo; `--scope owner` grants the owner; `--scope '*'`
  marks a PAT identity as broad enough for any public repository after the public-repo
  guard passes. A bare `--scope owner` only allows private access when `--private-scopes`
  is set, and a `owner/repo` scope always allows that repo (subject to the public-repo
  guard).
- `kind` must be `pat` or `github_app`. `github_app` requires a positive
  `installation_id`.
- Re-registering an existing id updates login, secret ref, installation id, weight, and
  scopes (scopes are replaced). Changing the pool or kind of an existing id is rejected
  (`409 identity_conflict`).
- Identity selection between equal candidates is biased by `weight` (default 100).

A wildcard PAT is eligible after public proof even when the requested owner is explicitly
allowed by the pool. Registration and `GET /v1/pools/:pool/health` describe stored rows:
`identities_healthy` counts active identities, not verified credential readiness or current
coordinator availability. Neither operation eagerly validates every Worker binding.

The relay checks the selected credential at use time. Classified local configuration
failures can select another eligible identity after recording a shared 120-second
cooldown; exhaustion returns the first generic credential error without secret binding
names. Each observation can extend the cooldown, and a revision with healthy secrets may
be suppressed by observations from a revision with missing secrets. A repaired binding
does not clear that shared state immediately. A valid cached App token can avoid reading
the private key, but App ID and installation prerequisites still apply, and refresh needs
the key. See [identity routing](identities.md) for the aggregate and anonymous-fallback limits.

Deploy callers and coordinators with compatible credential-feedback methods. A new caller
reaching an old coordinator without `recordCredentialFailure` treats the missing method
as infrastructure failure: no alternate dispatch, fabricated success acknowledgment, or
compensating storage clear. This method-availability interval lasts for the version overlap;
the 120-second credential cooldown does not bound it.

## Pools

Pools are created implicitly the first time they are referenced (caller provisioning,
identity registration, or login). A new pool gets the default policy:
owners = `DEFAULT_ALLOWED_OWNERS` (`openclaw`), `allow_public_repos: true`,
`allow_search: false`, `allow_logs: true`.
There is no pool-creation endpoint; edit `pools.policy_json` in D1 to change a policy.

Stored policies must be JSON objects. `{}` and partial objects retain defaults for missing
fields. Present `allow_public_repos`, `allow_search`, and `allow_logs` values must be
booleans; `allowed_owners` must be an array of strings (an empty array is valid). Stored
owner strings are lowercased. Invalid JSON, roots, or known field types block relay
serving with `503 pool_policy_unavailable`, without exposing the stored value. Repair the
row to recover; referencing an existing pool does not replace its policy with defaults.
An isolate may use a previously valid cached policy for up to 30 seconds after an edit;
cold/expired lookups reject corruption, and failed parses are not cached.

## Deployment-wide string protection

String rewrite rules are a **single deployment-wide policy**, independent of pool policy.
Migration `0016_string_rewrites.sql` creates an explicit empty revision 1. An empty policy
preserves ordinary dispatch; a missing, unreadable, or corrupt policy blocks protected
operations. Every authenticated caller with a pool grant can download the same rules, so
do not put credentials in patterns or replacements. Rules are not published in discovery
or the dashboard.

### Import file

`octopool admin string-rewrites set --file <path>` imports this exact UTF-8 JSON shape;
`--file -` reads stdin:

```json
{
  "schema_version": 1,
  "rules": [
    { "pattern": "\\binternal-model\\b", "replacement": "gpt-5.6-sol" },
    { "pattern": "\\binternal-family-[A-Za-z0-9_-]+\\b", "replacement": "" }
  ]
}
```

The file has exactly `schema_version` and `rules`; each rule has exactly `pattern` and
`replacement`. Missing replacement is invalid; an empty replacement deletes matches.
Duplicate JSON keys, duplicate patterns, unknown fields, invalid Unicode, and unsupported
schema versions are rejected. Patterns are regular expressions, not globs. Keep files
private and outside source control. The CLI's success output reports revision and rule
count without printing rules or matching content.

### HTTP contract

`GET /v1/admin/string-rewrites` uses the admin bearer token.
`GET /v1/pools/:pool/string-rewrites` uses a caller bearer token with that pool grant.
Both return the same exact response shape:

```json
{
  "schema_version": 1,
  "revision": 1,
  "updated_at": "2026-08-28T12:00:00.000Z",
  "rules": []
}
```

To replace the policy, read its current revision, then send
`PUT /v1/admin/string-rewrites` with admin authentication,
`Content-Type: application/json`, and exactly these fields:

```json
{
  "schema_version": 1,
  "expected_revision": 1,
  "rules": [{ "pattern": "internal-model", "replacement": "gpt-5.6-sol" }]
}
```

The D1 update atomically compares `expected_revision` with the current revision. A
successful response contains no rules:

```json
{
  "schema_version": 1,
  "revision": 2,
  "updated_at": "2026-08-28T12:01:00.000Z",
  "rule_count": 1
}
```

A stale or competing writer receives `409 string_rewrite_revision_conflict`; fetch and
review the new policy before retrying. Use `rules: []` with the current revision to
explicitly clear rules. Revisions are positive safe integers and increase on every
successful PUT, including an unchanged ruleset. GET always reads the D1 primary; there is
no policy cache, stale response, or offline fallback. All responses, including auth,
validation, conflict, and storage errors, use `Cache-Control: no-store`.

Malformed imports return `400 invalid_string_rewrite_policy`. Missing/corrupt policy or
D1 failure returns `503 string_rewrite_policy_unavailable`, never `fallback_local`.
Policy and denial errors contain only generic categories, not patterns, replacements,
or matched content. The GET endpoints intentionally disclose rules to authenticated
administrators and callers.

### Portable regex semantics and limits

The Worker uses pinned `re2js` 2.8.6, and the CLI uses Go `regexp`. Both apply a checked
RE2 subset: case-sensitive, leftmost-first matching; literal Unicode characters;
captures and `(?:noncapturing)` groups; alternation; greedy/lazy quantifiers; bracket
classes, ranges, and negation; dot; `^`/`$` anchors; ASCII `\b`, `\B`, `\w`, `\W`,
`\d`, `\D`, `\s`, `\S`; escaped regex punctuation (including slash and hyphen);
and `\n`, `\r`, `\t`, `\f`, `\a`, `\v`. Dot does not match newline, `$` means
absolute end of input, and word boundaries use ASCII word characters even beside
non-ASCII text. Repetition counts must satisfy the engines' RE2 limits.

V1 rejects flags fields, inline/scoped flags, lookaround, backreferences, named captures,
Unicode property classes, octal escapes, `\C`, and engine-specific extensions. It also
conservatively excludes POSIX named bracket classes, hexadecimal/Unicode escapes
(`\x`, `\u`), `\Q…\E`, and `\A`/`\z`; write literal Unicode and use `^`/`$`.
JSON's own Unicode escaping is accepted and decoded before regex validation. No user
pattern is executed by the native JavaScript regex engine.

Rules run globally, once each, in file order. Replacements are literal strings: `$1`
and `$&` are not capture expansions. Later rules see earlier output. A final scan of
**every effective pattern** blocks any remaining or newly created match, including a
match created across deletion boundaries; there is no repeat-until-clean loop. Patterns
matching empty input are rejected at import. Any contextual zero-width match discovered
on actual input aborts the operation. The relay checks reads and rejects matches; it
does not rewrite paths, search terms, or headers.

Limits are 128 rules, 256 UTF-8 bytes per pattern, 1,024 bytes per replacement,
65,536 bytes per policy document/API body (including the GET envelope), and 1,048,576
bytes per materialized input, intermediate output, or final output. Match iteration
and aggregate read inspection are bounded as well. Invalid UTF-8 and lone surrogates
are rejected. The shared parity vectors live in `test/fixtures/string-rewrites.json`.

An updated CLI may add a private local file beside `auth.json`, named
`string-rewrites.json`, or use `OCTOPOOL_STRING_REWRITE_FILE`. Local files are not uploaded.
Server rules precede local rules; identical entries deduplicate, conflicting replacements
for the same pattern fail, and merged limits may not silently discard rules. Local rules
cannot weaken the downloaded policy. See [CLI](cli.md) for supported publication commands
and [Operations](operations.md#activating-string-protection) for rollout and failure behavior.

Supported CLI submissions reject recognizable active rule JSON even when a regex does
not match its own escaped source. Detection recognizes complete objects with exactly string
`pattern` and `replacement` fields and an effective active pattern, regardless of the
replacement. Copies, JSON whitespace/Unicode escapes, rule arrays, and ordinary fenced
Markdown snippets are covered in inline, file, stdin, and every decoded REST payload string;
fence parsing uses independent state so preceding prose cannot mask a complete rule. Ordinary
prose still rewrites normally. This bounded check is not arbitrary Markdown/Unicode
deobfuscation, malformed-JSON recovery, encoded-file inspection, or semantic DLP; keep
policy files private and use the dedicated authenticated admin import path.

Modeled CLI submissions retain strict structural snapshots. Unmodeled native `gh` commands
use bounded best-effort rewriting of visible arguments, declared piped JSON/text, and `--input`
snapshots so an evolving CLI surface does not halt normal operations. Nonempty native workflow
JSON and API input declared as JSON (including the native default Content-Type) must parse
strictly; failures never downgrade to text. Explicit non-JSON API input remains bounded UTF-8
text, and exactly zero-byte best-effort input retains native compatibility. Interactive or
deferred native content and downstream reinterpretation of mislabeled text remain outside
that guarantee. Arbitrary input readers remain byte-bounded, not promptly cancellable.
See [CLI](cli.md#outbound-string-rewrite-protection) for declaration and header-order limits.
Server-mediated relay requests remain strict.

Each relay request owns a frozen transport context with its checked policy snapshot;
there is no global mutable policy or stale policy fallback. Canonical outgoing URLs and
noncredential headers are checked after URL parsing and header normalization, including
repository visibility, PR-state, Actions metadata/page/patch probes, pagination, Git/raw/web
transports, and followed redirects. Relay-triggered membership refreshes and App token
exchanges use the same transport; credential ownership does not change. The coordinator
only coordinates leases/cache fills and never fetches GitHub or receives the policy.
Policy denials cannot become stale-cache successes or local fallbacks. Literal path
TAB/LF/CR is rejected even with empty rules; safe empty-policy requests otherwise retain
legacy behavior. Automatic API redirects are disabled; existing allowlisted web and log
redirects are checked individually before following them. Login/admin authentication
outside the relay remains a separate trust boundary.
