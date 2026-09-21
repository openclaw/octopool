# Current Actions fixtures

Trimmed from anonymous public GitHub pages fetched on 2026-09-21 UTC:

- `run.html.txt`: `openclaw/openclaw/actions/runs/35562572332`.
- `list.html.txt`: the first three cards from `openclaw/openclaw/actions`.
- `workflow.html.txt`: the first three cards and the seventh (a pending push) from `openclaw/openclaw/actions/workflows/ci.yml`.
- `skipped-job.html.txt`: run 35562572332, job 106218103310.
- `completed-job.html.txt`: run 35563377671, job 106220362714 (preflight).
- `active-job.html.txt`: run 35566435541, job 106229081199 (preflight); its `Started` header is a start timestamp, not a completion timestamp.
- `job-batch-0.json` and `job-batch-1.json`: run 35562572332, attempt 1, `batch=0/1&size=1`.

HTML is stored as raw `.html.txt` so formatters do not repair the malformed markup under test.
The retained regions preserve nesting, metadata attributes, responsive copies, duplicate
close-button labels, and the run header's malformed dialog error placeholder. Unrelated
page chrome, CSS, SVG paths, telemetry attributes, and navigation JSON fields were removed.
List counts/pagination remain capped at 2,500; the trimmed files deliberately contain fewer
than 25 cards so request-completeness tests must supply the appropriate limit.

One anonymous REST read of job 106218103310 returned `steps: []` and equal non-null
`started_at`/`completed_at` values of `2026-09-21T04:53:38Z`. Those times do not occur in
the public job page. The bounded page shape represents them as unavailable (null).
Native gh's `pkg/cmd/run/shared/presentation.go` renders equal or absent job timestamps
as `in 0s`; the human renderer regression test covers that equivalence.

The live job page also contains parallel/background-step UI support, including
`check-step[data-parallel-group-id]`, `data-parallel-group-header`, and
`data-parallel-group-child-visible`. Step display order is not proof of sequential
execution. Timing guards validate each step's interval and the enclosing job bounds,
without requiring successive steps' timestamps to increase.
