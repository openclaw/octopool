# Native view export fixtures

Generated with `/opt/homebrew/bin/gh` v2.102.0 using `python3 generate.py`.
The generator runs a temporary local TLS GraphQL server with synthetic data and
synthetic credentials; it does not contact GitHub. `*.graphql.json` is the server's
issue/PR node, `*.native.txt` is exact nonterminal `--json` stdout, and `*.jq.txt`
is exact nonterminal `--jq` stdout. No output is normalized.

The cases cover the PR merge-state field bundle, HTML characters, all supported
issue reasons, and native assignee field ordering. Null auto-merge and native
fallback for enabled auto-merge are covered by existing PR field tests.
