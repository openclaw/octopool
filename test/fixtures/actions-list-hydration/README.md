# Actions list hydration diagnosis

Anonymous captures from `curl -sS -A octopool -H 'accept: text/html'` on
2026-09-21 at approximately 07:52–07:53 UTC. Both full list parsers returned 25 cards.
The table records list-card status at capture time; run pages were fetched afterward,
so queued/in-progress states may have advanced. The baseline parser was commit 8df59e1.

- `list.html.txt` and `workflow.html.txt` retain all 25 cards from
  `https://github.com/openclaw/openclaw/actions` and `/actions/workflows/ci.yml`.
- `manual-queued.html.txt` (35575007986) and `manual-active.html.txt` (35575038033)
  preserve the `Manually triggered` timestamp, owned full SHA, graph and navigation.
  The old timestamp selector required `Triggered via ...`; these now parse completely.
- `push-pending.html.txt` (35575012764) already parsed; no new status mapping was needed.
- `pr-queued.html.txt` (35574986404) and `pr-target.html.txt` (35575041909) have summary
  and graph regions but no summary commit link. They must still use REST. The latter
  also pairs `Triggered via pull request` with `on: pull_request_target`, which the old
  parser rejects as conflicting evidence. Its missing SHA alone prevents safe hydration.

All 50 run pages had a summary and graph; none failed because a queued/pending summary
was missing or a `waiting` label was unknown. The repository page requires 25 hydrations;
the workflow page requires 22. The new eight-card cutoff therefore rejects both before
fetching any run page, even when the caller requests only one card. Allowed hydration on
less busy pages has its own shared 2500 ms deadline; list fetching retains the normal
configured transport timeout.

Trimming removes unrelated page chrome, images, SVG paths, telemetry/socket attributes,
and graph job visualization. Run fixtures retain header status icons, summary, navigation
ownership/attempt fields, and the original workflow-link/event-label wrapper. Lists retain
card boundaries, responsive timestamps and count semantics. HTML remains `.html.txt` so
formatters cannot repair parser evidence. All captured content is anonymous/public.

`OK` means the old full run parser succeeded. `timestamp` is the manual-trigger gap fixed
here. `SHA` means no owned commit SHA; `SHA + event` also has the PR/PR-target contradiction.
The graph event column is observed evidence, not a claim that every other required field
is present. No SHA is inferred from titles, PR links or mutable branch tips.

| Page     | Run ID      | List status | Graph event         | Baseline hydration |
| -------- | ----------- | ----------- | ------------------- | ------------------ |
| list     | 35575044519 | queued      | workflow_run        | OK                 |
| list     | 35575042453 | completed   | issue_comment       | OK                 |
| list     | 35575041909 | completed   | pull_request_target | SHA + event        |
| list     | 35575041874 | queued      | pull_request_target | SHA + event        |
| list     | 35575041861 | queued      | pull_request_target | SHA + event        |
| list     | 35575041860 | queued      | pull_request_target | SHA + event        |
| list     | 35575041850 | queued      | pull_request_target | SHA + event        |
| list     | 35575041843 | completed   | pull_request_target | SHA + event        |
| list     | 35575041838 | queued      | pull_request_target | SHA + event        |
| list     | 35575041833 | queued      | pull_request_target | SHA + event        |
| list     | 35575041830 | queued      | pull_request_target | SHA + event        |
| list     | 35575041808 | queued      | pull_request_target | SHA + event        |
| list     | 35575041056 | completed   | workflow_run        | OK                 |
| list     | 35575041007 | completed   | issue_comment       | OK                 |
| list     | 35575038033 | in_progress | workflow_dispatch   | timestamp          |
| list     | 35575037698 | completed   | issue_comment       | OK                 |
| list     | 35575037694 | completed   | issue_comment       | OK                 |
| list     | 35575037611 | completed   | issue_comment       | OK                 |
| list     | 35575036588 | completed   | issue_comment       | OK                 |
| list     | 35575034194 | completed   | issue_comment       | OK                 |
| list     | 35575033311 | completed   | issue_comment       | OK                 |
| list     | 35575033273 | completed   | issue_comment       | OK                 |
| list     | 35575033242 | completed   | issue_comment       | OK                 |
| list     | 35575033178 | completed   | issue_comment       | OK                 |
| list     | 35575033151 | in_progress | issue_comment       | OK                 |
| workflow | 35575012764 | pending     | push                | OK                 |
| workflow | 35575007986 | queued      | workflow_dispatch   | timestamp          |
| workflow | 35574986404 | in_progress | pull_request        | SHA                |
| workflow | 35574959546 | in_progress | pull_request        | SHA                |
| workflow | 35574876188 | completed   | pull_request        | SHA                |
| workflow | 35574795146 | completed   | pull_request        | SHA                |
| workflow | 35574786748 | queued      | pull_request        | SHA                |
| workflow | 35574757671 | completed   | pull_request        | SHA                |
| workflow | 35574719242 | queued      | pull_request        | SHA                |
| workflow | 35574705211 | queued      | pull_request        | SHA                |
| workflow | 35574651303 | completed   | push                | OK                 |
| workflow | 35574627227 | queued      | pull_request        | SHA                |
| workflow | 35574553502 | completed   | push                | OK                 |
| workflow | 35574525080 | in_progress | pull_request        | SHA                |
| workflow | 35574469521 | in_progress | pull_request        | SHA                |
| workflow | 35574462018 | completed   | pull_request        | SHA                |
| workflow | 35574411489 | in_progress | pull_request        | SHA                |
| workflow | 35574382969 | in_progress | pull_request        | SHA                |
| workflow | 35574376990 | in_progress | pull_request        | SHA                |
| workflow | 35574375694 | completed   | pull_request        | SHA                |
| workflow | 35574373240 | in_progress | pull_request        | SHA                |
| workflow | 35574370360 | completed   | pull_request        | SHA                |
| workflow | 35574366134 | in_progress | pull_request        | SHA                |
| workflow | 35574353931 | in_progress | pull_request        | SHA                |
| workflow | 35574338988 | completed   | pull_request        | SHA                |
