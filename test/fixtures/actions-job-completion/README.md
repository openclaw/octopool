# Terminal job completion fixtures

Trimmed from credential-free public GitHub HTML fetched on 2026-09-27 UTC:

- `completed-check-run.html.txt`: <https://github.com/openclaw/openclaw/runs/106220362714>, fetched at 02:29:47 UTC. HTTP 200 directly, no redirect; the retained capture was 551,357 bytes. The selected job section contains `id="check_run_106220362714"`, the exact job header `/openclaw/openclaw/runs/106220362714/header`, `succeeded`, completion time `2026-09-21T05:16:35Z`, and `check-steps[data-job-status="completed"]`.
- `active-check-run.html.txt`: <https://github.com/openclaw/openclaw/runs/108534563744>, fetched at 02:33:23 UTC. HTTP 200 directly, no redirect; 311,059 bytes. The selected job section contains `id="check_run_108534563744"`, the exact job header `/openclaw/openclaw/runs/108534563744/header`, `Started`, start time `2026-09-27T02:31:26Z`, and `check-steps[data-job-status="in_progress"]`.

The active job's canonical page, <https://github.com/openclaw/openclaw/actions/runs/36288751939/job/108534563744>, independently returned HTTP 200 with 213,400 bytes at 02:33:22 UTC and exposed the same header and status markers. Its public `job_groups_batch?attempt=1&batch=0&size=1` response identified job 108534563744 with `status: "in_progress"` and `conclusion: null`. No API or credential was used for these reads. Unlike canonical Actions pages, `/runs/{job_id}` returned the older check-run layout without `actions-run-jobs-list` navigation JSON.

Each fixture retains the original selected `Check run summary` section, including the job identity node, header/status elements, and their ancestor nesting. Unrelated page chrome, template icons, step details, and ephemeral signed `data-channel` attributes were removed. Raw `.html.txt` preserves source structure without formatter repairs. Tests also reuse the existing canonical completed-job fixture in `../actions-current/`; queued and ambiguous cases are explicit mutations of the captured fixtures, not additional claimed live observations.

## Full-page annotation regression

The `*-full-check-run.html.txt` fixtures retain the relevant structure from full public
`/runs/{job_id}` pages fetched with `User-Agent: octopool` and `Accept: text/html`, without
credentials. All returned HTTP 200 directly, with two `Check run summary` sections, exactly
one `js-selected-check-run`, one matching `check_run_{job_id}` marker and no
`actions-run-jobs-list` navigation. Sizes below describe the original captures, not the
sanitized fixtures.

| Fixture                             | Public job URL                                           | Captured (2026-09-27 UTC)     | Original bytes | Header / steps status                             | Proof before → after |
| ----------------------------------- | -------------------------------------------------------- | ----------------------------- | -------------: | ------------------------------------------------- | -------------------- |
| `failed-full-check-run.html.txt`    | <https://github.com/openclaw/openclaw/runs/108555666497> | supplied capture, saved 05:21 |        403,126 | `failed`, `2026-09-27T05:08:01Z` / `completed`    | false → true         |
| `succeeded-full-check-run.html.txt` | <https://github.com/openclaw/openclaw/runs/108011889949> | supplied capture, saved 05:21 |        593,911 | `succeeded` / `completed`                         | false → true         |
| `cancelled-full-check-run.html.txt` | <https://github.com/openclaw/openclaw/runs/108557756681> | 05:25                         |        433,535 | `cancelled` / `completed`                         | false → true         |
| `active-full-check-run.html.txt`    | <https://github.com/openclaw/openclaw/runs/108557771957> | 05:29:03                      |        390,242 | `Started`, `2026-09-27T05:23:53Z` / `in_progress` | false → false        |
| `skipped-full-check-run.html.txt`   | <https://github.com/openclaw/openclaw/runs/108557811653> | 05:25                         |        297,982 | skipped blank slate / no header or steps          | false → false        |

The failed, succeeded, and cancelled documents parsed without errors and contained 2,095,
3,408, and 2,281 traversed elements. Their first rejected ownership node was the implicit
`tbody` inserted by parse5 in an annotation table: `sourceCodeLocation` was null. The
previous fixtures had removed annotations, hiding this failure. This was not a page-size,
element-count, header URL, timestamp adjacency, or steps-status failure.

These fixtures retain both summary sections, the selected section's ancestor nesting for
job identity, header, and steps, and (where present) one annotation table row with its
original wrapper nesting and omitted `tbody`. Unrelated page chrome, controls, other rows,
step details, and signed channel attributes were removed; annotation prose and the document
title are synthetic. The document scaffold is reduced to `html/head/body/main`; no raw full
page is committed. The active and skipped captures have no annotation table. Skipped pages
remain unproven because they lack the required completion header and steps status.

The unit regression also generates a page above 600 KB with 20,000 unrelated elements;
the parser has no separate element-count cap. Transport response-size and timeout caps
remain covered in `completed-job-page.test.ts`. The terminal-log Worker e2e uses the failed
fixture with its repository/job IDs changed to the synthetic test route and verifies both
`web_page` proof on the first read and an R2 hit on the second read.
