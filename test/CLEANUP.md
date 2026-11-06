# Test cleanup ledger

Completion requires reviewing all test families and fixtures, removing proven
redundancy, checking broken mappings and coverage gaps, and validating each narrow
PR. Releases are outside this work.

| Area                           | Evidence and decision                                                                                                                                                                                                                            | Validation / status                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Generated route documentation  | Remove two tests duplicating the route generator filters and template normalization. `routes:check` already regenerates and checks the exact committed output. Keep native-route exclusion and handwritten transport/shape documentation checks. | Validation pending.                                              |
| Captured Actions HTML fixtures | Filename searches alone produce false positives: hydration and completion tests construct filenames. All seven initial candidates have consumers; retain them.                                                                                   | Reference inspection complete.                                   |
| Suite inventory                | Baseline `b41f50e`: 238 TypeScript and Go test files. Worker tests exercise local runtime services with mocked upstreams; CLI subprocess tests use HTTP fixtures.                                                                                | Full behavioral audit remains open.                              |
| CLI to Worker smoke            | Real binary and local Worker, live GitHub dependency, fixed port, retained temporary state; CI runs it only on manual dispatch.                                                                                                                  | Review isolation, cleanup and routine coverage in a separate PR. |
