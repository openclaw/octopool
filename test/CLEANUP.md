# Test cleanup ledger

Completion requires reviewing all test families and fixtures, removing proven
redundancy, fixing broken mappings and coverage gaps, and validating each narrow
PR. Releases are outside this work.

Full semantic audit completed at baseline `b41f50e`: 59 unit, 74 Worker and 105 Go
test files (238 total). Worker tests use local runtime services and mocked
upstreams; CLI subprocess tests use HTTP fixtures. Neither is a deployed-service
end-to-end test. Dynamic and historical fixture consumers were checked; retain
captured Actions HTML and legacy in-flight Worker protocol coverage.

| Area                           | Decision and evidence                                                                                                                                                                           | Status                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Generated routes and totals    | Remove duplicated generator checks and incidental counts; retain concrete route contracts.                                                                                                      | #272, #278 landed; scoped Crabbox and full CI passed. |
| Deployed-host smoke            | Unique temporary directory, unused bodies removed, signal/exit cleanup.                                                                                                                         | #275 landed; macOS/Linux and cleanup checks passed.   |
| Native SQL experiments         | Remove rewritten allocator SQL, shadow index-cost probes and receipt logging.                                                                                                                   | #279 landed; 13 native Worker tests and CI passed.    |
| Go stdin and projection matrix | Replace timed pipe with read-count guard; remove 32 duplicate REST-only cases.                                                                                                                  | #280 landed; #282 awaiting CI.                        |
| Parser negative controls       | Valid baselines isolate pageInfo, selected-job and run-link rejection.                                                                                                                          | #283; 211 tests and three mutation checks passed.     |
| Environment isolation          | Fixture settings override inherited authentication, routing and freshness.                                                                                                                      | #285; hostile-environment CLI tests passed.           |
| Go redundant controls          | Remove repeated direct redirect controls, server-fixture immutability assertions, duplicate delimiter check and synthetic transcript claim.                                                     | Focused Go tests passed; full CI pending.             |
| Unit follow-ups                | Dashboard source assertions, response-cap test, isolated docs fixture, hydration timer, duplicate PR-state/release cases, timeout and cache-write assertions, outbound-query checks.            | Implement in narrow PRs.                              |
| Go follow-ups                  | Exact fallback reasons, token/asset boundaries, reviewer precedence, overlap barrier, deadline assertion and unused fixture builder.                                                            | Implement in narrow PRs.                              |
| Worker follow-ups              | Publication waiter barrier and cleanup, current ownership assertions, strict outage results, expiry ordering, JWT and OAuth signal checks, duplicate key binding and historical SQL comparison. | Implement in narrow PRs.                              |
| CLI to Worker smoke            | Live GitHub dependency, fixed port and retained descendant state; manual CI only. Native-gh protocol check is opt-in.                                                                           | Isolate smoke and document native validation.         |
| Windows subprocess timeout     | One help-bootstrap child reached the policy handler but exceeded its 15-second deadline.                                                                                                        | Inspect exact failure; retry only failed CI job.      |
