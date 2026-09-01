package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

func protectionReadPaths() []string {
	paths := []string{
		"repos/acme/demo/rulesets",
		"repos/acme/demo/rulesets/42",
		"repos/acme/demo/rules/branches/main",
	}
	for _, suffix := range []string{
		"", "/enforce_admins", "/required_status_checks", "/required_status_checks/contexts",
		"/required_pull_request_reviews", "/required_signatures", "/restrictions",
		"/restrictions/apps", "/restrictions/teams", "/restrictions/users",
	} {
		paths = append(paths, "repos/acme/demo/branches/main/protection"+suffix)
	}
	return paths
}

func protectionReadNearMisses() []string {
	return []string{
		"repos/acme/demo/rulesets/42/history", "repos/acme/demo/rulesets/42x",
		"repos/acme/demo/rulesets/", "repos/acme/demo/rulesets-extra",
		"repos/acme/demo/rules/branches/main/extra", "repos/acme/demo/rules/branches/feature/topic",
		"repos/acme/demo/branches/main/protection/unknown", "repos/acme/demo/branches/main/protection/",
		"repos/acme/demo/branches/main/protection/restrictions/users/42",
		"repos/acme/demo/branches/main/protection/required_status_checks/contexts/extra",
		"repos/acme/demo/branches/main/protection/dismissal_restrictions",
		"orgs/acme/rulesets", "graphql",
	}
}

func TestProtectionReadsStrictPreparation(t *testing.T) {
	policy := testRewritePolicy(t, stringRewriteRule{Pattern: "internal-model", Replacement: "public"})
	for _, endpoint := range protectionReadPaths() {
		t.Run(endpoint, func(t *testing.T) {
			if !rewriteReadPath("/" + endpoint) {
				t.Fatal("exact protection read missing from generated allowlist")
			}
			prepared := &rewritePreparation{}
			t.Cleanup(prepared.cleanup)
			args := []string{"api", endpoint, "--jq", "type", "--paginate", "--slurp", "--include", "--silent"}
			// Call the strict owner directly: a successful best-effort dispatch must
			// not hide a missing manifest route or unsupported preparation result.
			if err := prepareRewriteAPI(policy, args, strings.NewReader("unused stdin"), prepared); err != nil {
				t.Fatal(err)
			}
			want := []string{"api", endpoint, "--method=GET", "--hostname=github.com", "--jq", "type", "--paginate=true", "--slurp=true", "--include=true", "--silent=true"}
			if !slices.Equal(prepared.args, want) {
				t.Fatalf("strict args=%v", prepared.args)
			}
			if data, err := io.ReadAll(prepared.stdin); err != nil || len(data) != 0 {
				t.Fatal("strict read retained stdin")
			}
			for _, method := range []string{"POST", "PATCH", "PUT", "DELETE", "HEAD"} {
				mutation := &rewritePreparation{}
				err := prepareRewriteAPI(policy, []string{"api", endpoint, "--method=" + method}, nil, mutation)
				mutation.cleanup()
				wantErr := errRewriteUnsupported
				if method == "DELETE" || method == "HEAD" {
					wantErr = errRewriteBlocked
				}
				if err != wantErr {
					t.Fatalf("%s entered strict read preparation: %v", method, err)
				}
			}
		})
	}
	for _, endpoint := range protectionReadNearMisses() {
		t.Run(endpoint, func(t *testing.T) {
			if rewriteReadPath("/" + endpoint) {
				t.Fatal("neighboring route entered strict allowlist")
			}
			prepared := &rewritePreparation{}
			t.Cleanup(prepared.cleanup)
			if err := prepareRewriteAPI(policy, []string{"api", endpoint}, nil, prepared); err != errRewriteUnsupported {
				t.Fatalf("safe unmodeled route must remain unsupported, got %v", err)
			}
		})
	}
}

func TestProtectionReadsNativeHandoff(t *testing.T) {
	paths := append(protectionReadPaths(),
		"repos/acme/demo/rules/branches/feature%2Ftopic",
		"repos/acme/demo/branches/feature%2ftopic/protection/required_status_checks/contexts",
		"repos/acme/demo/branches/caf%C3%A9/protection",
		"repos/acme/demo/rules/branches/release%2Bnext",
		"repos/acme/demo/rulesets?includes_parents=true&per_page=100&page=2",
		"repos/acme/demo/rulesets/42?includes_parents=false",
	)
	for _, endpoint := range paths {
		t.Run(endpoint, func(t *testing.T) {
			t.Setenv("GH_HOST", "ghe.example")
			t.Setenv("GH_REPO", "ghe.example/other/repo")
			var relays atomic.Int64
			_, policies := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				relays.Add(1)
				var request struct {
					Method string
					Path   string
					Query  map[string]any
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
				}
				path, query, _ := strings.Cut(endpoint, "?")
				if request.Method != "GET" || request.Path != "/"+path {
					t.Error("relay changed the literal method/path")
				}
				if query != "" && len(request.Query) == 0 {
					t.Error("relay lost query")
				}
				writeCLIFallback(t, w, "local_credentials_required")
			})
			capture := captureRewriteGH(t)
			var out, stderr bytes.Buffer
			args := []string{"api", endpoint, "--method=GET", "--header=Accept: application/vnd.github+json"}
			if endpoint == "repos/acme/demo/rules/branches/main" {
				args = append(args, "--jq", "type")
			}
			if endpoint == "repos/acme/demo/rulesets" {
				args = append(args, "--paginate", "--slurp")
			}
			if err := runGH(t.Context(), args, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			if relays.Load() != 1 || policies.Load() != 3 {
				t.Fatalf("relay=%d policies=%d: initial, relay, and final checks required", relays.Load(), policies.Load())
			}
			got := readRewriteCapture(t, capture)
			if got.Args[1] != endpoint || !slices.Contains(got.Args, "--method=GET") || got.Stdin != "" {
				t.Fatal("native dispatch changed endpoint/method or retained stdin")
			}
			if !slices.Contains(got.Args, "--hostname=github.com") || got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" {
				t.Fatal("native protection read lost GitHub.com host pinning")
			}
			if slices.Contains(args, "--jq") {
				index := slices.Index(got.Args, "--jq")
				if index < 0 || index+1 >= len(got.Args) || got.Args[index+1] != "type" {
					t.Fatalf("lost original jq occurrence: %v", got.Args)
				}
			}
			for _, flag := range []string{"--paginate=true", "--slurp=true"} {
				if endpoint == "repos/acme/demo/rulesets" {
					if !slices.Contains(got.Args, flag) {
						t.Fatalf("lost native flag %s", flag)
					}
				}
			}
			if out.String() != "child stdout\n" || !strings.Contains(stderr.String(), "local_credentials_required") {
				t.Fatal("native output/handoff changed")
			}
		})
	}
}

func TestProtectionReadsRejectUnsafeInput(t *testing.T) {
	var relays atomic.Int64
	policy, _ := rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		relays.Add(1)
		writeCLIFallback(t, w, "local_credentials_required")
	})
	// Anchored rules must also scan each decoded branch component.
	policy.Store(strings.Replace(rewriteActiveTestPolicy, "internal-model", "^internal-model$", 1))
	argsList := [][]string{}
	for _, endpoint := range []string{
		"repos/acme/demo/rules/branches/{branch}",
		"repos/{owner}/demo/rulesets", "repos/acme/demo/rulesets?ref=prefix:branch",
		"repos/acme/demo/rulesets?{repo}=safe", "repos/acme/demo/rulesets?access_token=fixture",
		"repos/acme/demo/rulesets?q=internal-model", "repos/acme/demo/rulesets?internal-model=safe",
		"repos/acme/demo/rulesets?page=1&page=2",
		"repos/acme%2Fextra/demo/rulesets", "repos/acme/demo%2Fextra/rulesets",
		"repos/acme/demo/branches/feature%2Ftopic",
		"repos/acme/demo/rules/branches/feature%2Ftopic/extra",
		"repos/acme/demo/branches/feature%2Ftopic/protection/unknown",
	} {
		argsList = append(argsList, []string{"api", endpoint})
	}
	for _, branch := range []string{
		"feature%2Finternal-model", "feature%2F%69nternal-model", "feature%252Ftopic",
		"feature%2F..%2Ftopic", "feature%2F.%2Ftopic", "feature%2F%2Ftopic",
		"%2Ftopic", "topic%2F", "topic%5Cnext", "topic%3Fnext", "topic%23next",
		"%7Bbranch%7D", ":branch", "prefix:branch", "topic%00", "topic%0A", "topic%0D",
		"topic%09", "topic%ZZ", "topic%", "*",
	} {
		argsList = append(argsList, []string{"api", "repos/acme/demo/rules/branches/" + branch})
	}
	for _, flags := range [][]string{
		{"-HAuthorization: Bearer fixture"}, {"-HCookie: fixture"}, {"-HX-Unknown: fixture"},
		{"-HAccept: internal-model"}, {"--hostname=ghe.example"},
	} {
		argsList = append(argsList, append([]string{"api", "repos/acme/demo/rulesets"}, flags...))
	}
	for _, args := range argsList {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			capture := captureRewriteGH(t)
			if err := runGH(t.Context(), args, io.Discard, io.Discard); !errors.Is(err, errRewriteBlocked) {
				t.Fatalf("expected blocked, got %v", err)
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("unsafe input reached native gh")
			}
		})
	}
	if relays.Load() != 0 {
		t.Fatal("unsafe input reached relay")
	}
}

func TestProtectionReadsSafeUnsupportedBestEffort(t *testing.T) {
	var relays atomic.Int64
	rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
		relays.Add(1)
		writeCLIFallback(t, w, "route_denied")
	})
	policy := testRewritePolicy(t, stringRewriteRule{Pattern: "internal-model", Replacement: "public"})
	argsList := [][]string{}
	for _, endpoint := range protectionReadNearMisses() {
		argsList = append(argsList, []string{"api", endpoint})
	}
	for _, flags := range [][]string{
		{"--method=POST"}, {"--method=PATCH"}, {"--method=PUT"},
		{"--input=-", "--method=GET"}, {"-f", "page=1", "--method=GET"}, {"-Fpage=1"},
		{"--hostname=github.com"}, {"--template=internal-model"},
	} {
		argsList = append(argsList, append([]string{"api", "repos/acme/demo/rulesets"}, flags...))
	}
	for _, args := range argsList {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			strict := &rewritePreparation{}
			t.Cleanup(strict.cleanup)
			if err := prepareRewriteAPI(policy, args, strings.NewReader(""), strict); err != errRewriteUnsupported {
				t.Fatalf("expected unsupported strict shape, got %v", err)
			}
			// The fake child records argv only; even mutation-shaped cases cannot
			// contact GitHub or modify a repository.
			capture := captureRewriteGH(t)
			var err error
			if slices.Contains(args, "--input=-") {
				err = execRealGHWithStdin(t.Context(), args, strings.NewReader(`{"note":"internal-model"}`), io.Discard, io.Discard)
			} else {
				err = runGH(t.Context(), args, io.Discard, io.Discard)
			}
			if err != nil {
				t.Fatal(err)
			}
			got := readRewriteCapture(t, capture)
			if got.Args[1] != args[1] || !slices.Contains(got.Args, "--hostname=github.com") || got.Env["GH_HOST"] != "github.com" {
				t.Fatalf("best-effort native shape lost: %v", got.Args)
			}
			if slices.Contains(args, "--template=internal-model") && !slices.Contains(got.Args, "--template=public") {
				t.Fatal("unmodeled flag bypassed best-effort filtering")
			}
			if slices.Contains(args, "--input=-") && !rewriteCaptureHasContent(got, `{"note":"public"}`) {
				t.Fatal("unmodeled input bypassed best-effort snapshot filtering")
			}
		})
	}
	if relays.Load() != 0 {
		t.Fatal("unsupported shapes reached relay")
	}
}

func TestProtectionReadsFreshPolicyBeforeFallback(t *testing.T) {
	for _, scenario := range []string{"changed", "missing", "relay denial", "no fallback"} {
		t.Run(scenario, func(t *testing.T) {
			var policy *atomic.Value
			var relays atomic.Int64
			var policies *atomic.Int64
			policy, policies = rewriteTestServer(t, rewriteActiveTestPolicy, func(w http.ResponseWriter, r *http.Request) {
				relays.Add(1)
				switch scenario {
				case "changed":
					policy.Store(strings.Replace(rewriteActiveTestPolicy, "internal-model", "main", 1))
				case "missing":
					policy.Store(`{}`)
				case "relay denial":
					w.WriteHeader(403)
					_, _ = io.WriteString(w, `{"error":{"code":"string_rewrite_denied","message":"blocked"}}`)
					return
				}
				writeCLIFallback(t, w, "local_credentials_required")
			})
			if scenario == "no fallback" {
				t.Setenv("OCTOPOOL_NO_FALLBACK", "1")
			}
			capture := captureRewriteGH(t)
			err := runGH(t.Context(), []string{"api", "repos/acme/demo/rules/branches/main"}, io.Discard, io.Discard)
			if err == nil || relays.Load() != 1 {
				t.Fatalf("err=%v relay=%d", err, relays.Load())
			}
			if (scenario == "changed" && err != errRewriteBlocked) || (scenario == "missing" && !errors.Is(err, errRewritePolicy)) {
				t.Fatalf("wrong final policy failure: %v", err)
			}
			wantPolicies := int64(2)
			if scenario == "changed" || scenario == "missing" {
				wantPolicies = 3
			}
			if policies.Load() != wantPolicies {
				t.Fatalf("policy checks=%d", policies.Load())
			}
			if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Fatal("failed policy or disabled fallback reached native gh")
			}
		})
	}
}
