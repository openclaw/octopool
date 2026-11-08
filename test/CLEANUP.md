# Test cleanup ledger

Full semantic audit of baseline `b41f50e`: 238 files (59 unit, 74 Worker, 105 Go).
Validation uses scoped Go tests, Crabbox, required CI, and mutation checks for
rejection, expiry, limiter and signature guards. No releases are part of this work.

- **Routes and generated docs:** removed duplicate generator assertions and
  incidental totals; retained concrete contracts. 799 scoped route tests.
  [#272](https://github.com/openclaw/octopool/pull/272), [#278](https://github.com/openclaw/octopool/pull/278).
- **Go redundancy:** removed 32 duplicate projection cases, nine repeated direct
  redirect controls, fixture-only immutability checks and synthetic transcript
  claims. Replaced a timed stdin pipe with a read-count guard.
  [#280](https://github.com/openclaw/octopool/pull/280), [#282](https://github.com/openclaw/octopool/pull/282), [#286](https://github.com/openclaw/octopool/pull/286).
- **Go test controls:** isolated inherited environment, required exact fallback
  reasons, repaired query/asset/review fixtures, synchronized disabled-limiter
  overlap and removed unused fixture setup. Seven mutations caught; constrained
  CPU repetitions passed.
  [#285](https://github.com/openclaw/octopool/pull/285), [#287](https://github.com/openclaw/octopool/pull/287), [#290](https://github.com/openclaw/octopool/pull/290).
  Follow-up: dispatch boundary cases added in
  [#299](https://github.com/openclaw/octopool/pull/299) now require the CSV error
  and no relay requests; unrelated-error and premature-request mutations are caught.
  Modifier cases from [#302](https://github.com/openclaw/octopool/pull/302) now
  pair working relay controls with each rejection. Two duplicate PR-diff cases
  were removed; workflow-option and duplicate-repository mutations are caught.
  Discovery pool selection now isolates inherited configuration and covers all
  four precedence levels. Four mutations were caught and unused fixture fields removed.
  PR-comment reactions now check exact values and empty-array output instead of
  repeating a count-only assertion across author cases; two mutations were caught.
- **Unit tests:** isolated parser rejection conditions, removed duplicate PR-state
  and release cases plus unused HTML, replaced cosmetic assertions with contracts,
  checked outbound queries/signals/cache writes, used fake time and isolated docs
  output. Scoped runs: 211, 177 and 354 cases; three parser mutations caught.
  [#283](https://github.com/openclaw/octopool/pull/283), [#288](https://github.com/openclaw/octopool/pull/288), [#291](https://github.com/openclaw/octopool/pull/291).
  Stats batches now use distinct non-empty query results and verify every report
  section; unused single-query fixture methods and the batch-size assertion were removed.
- **Worker SQL and concurrency:** removed rewritten allocator and shadow-index
  experiments. Shared an actual publication-waiter barrier and enforced coalesced
  results with owned cleanup. Scoped runs: 13 and 89 cases.
  [#279](https://github.com/openclaw/octopool/pull/279), [#289](https://github.com/openclaw/octopool/pull/289).
- **Worker expiry and outcomes:** crossed expiry at observed lookup boundaries,
  observed native renewal, removed historical SQL comparison, asserted current
  publication-owner cleanup and strict fallback outcomes, and removed timing-only
  policy assertions. Scoped runs: 128 and 123 cases; two expiry mutations caught.
  [#293](https://github.com/openclaw/octopool/pull/293), [#295](https://github.com/openclaw/octopool/pull/295).
- **Authentication:** verified App JWT signatures and timestamps, removed the
  duplicate key binding, and checked the actual OAuth fetch signal. 49 scoped
  cases passed; invalid-signature mutation caught.
  [#296](https://github.com/openclaw/octopool/pull/296).
- **Smoke tests:** deployed-host smoke uses unique temporary state and exit/signal
  cleanup. CLI-to-Worker smoke now owns its descendants, state and port. Native
  GitHub CLI protocol validation is documented and passed locally. Live Linux
  CLI-to-Worker and success/failure/TERM cleanup checks passed.
  [#275](https://github.com/openclaw/octopool/pull/275); CLI smoke changes accompany this ledger.

Retain captured Actions HTML with dynamic consumers, historical cache fixtures,
and legacy fill RPC compatibility for in-flight pre-epoch Workers. Docs fixture
assets are required by link validation. Repeated CLI builds remain isolated;
there is no measured performance finding requiring a shared binary lifecycle.
One Windows help-bootstrap timeout passed its targeted job retry; the deadline
remains unchanged.

Worker suites exercise local runtime services with mocked upstreams; CLI
subprocess tests use HTTP fixtures. Deployed-host and CLI-to-Worker smoke checks
reach live services and remain explicit. Credential-dependent live canaries
remain opt-in.
