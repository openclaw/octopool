package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const prMergeableTestFields = "headRefOid,mergeable,isDraft,state,url"
const prMergeableTestHead = "0123456789abcdef0123456789abcdef01234567"
const prMergeableTestURL = "https://github.com/openclaw/octopool/pull/7"

var prMergeableTestCases = []struct {
	name    string
	value   any
	present bool
	want    string
}{
	{"true", true, true, "MERGEABLE"},
	{"false", false, true, "CONFLICTING"},
	{"null", nil, true, "UNKNOWN"},
	{"absent", nil, false, "UNKNOWN"},
}

func prMergeableFixture(value any, present bool) map[string]any {
	pr := map[string]any{
		"state": "open", "draft": true, "merged": false, "mergeable_state": "clean",
		"head": map[string]any{"sha": prMergeableTestHead}, "html_url": prMergeableTestURL,
	}
	if present {
		pr["mergeable"] = value
	}
	return pr
}

func checkPRMergeableRequest(t *testing.T, request map[string]any) {
	t.Helper()
	if request["method"] != "GET" || request["path"] != "/repos/openclaw/octopool/pulls/7" {
		t.Errorf("unexpected PR request: %#v", request)
	}
	headers, _ := request["headers"].(map[string]any)
	if _, present := headers["x-octopool-public-shape"]; present {
		t.Errorf("REST read has public-shape header: %#v", headers)
	}
	if headers["cache-control"] != "max-age=0" {
		t.Errorf("headers = %#v, want cache-control max-age=0", headers)
	}
}

func checkPRMergeableProjection(t *testing.T, raw, fields, mergeable string) {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatal(err)
	}
	all := map[string]any{
		"headRefOid": prMergeableTestHead, "mergeable": mergeable,
		"isDraft": true, "state": "OPEN", "url": prMergeableTestURL,
	}
	want := map[string]any{}
	for _, field := range strings.Split(fields, ",") {
		want[field] = all[field]
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("projection = %#v, want %#v", got, want)
	}
	if _, requested := want["mergeable"]; requested {
		if _, ok := got["mergeable"].(string); !ok {
			t.Errorf("mergeable = %#v (%T), want JSON string", got["mergeable"], got["mergeable"])
		}
	}
}

func TestRunGHPRViewMergeableProjection(t *testing.T) {
	t.Setenv("OCTOPOOL_FRESH", "")
	for _, test := range prMergeableTestCases {
		for _, fields := range []string{prMergeableTestFields, "mergeable", "headRefOid,isDraft,state,url"} {
			t.Run(test.name+"/"+fields, func(t *testing.T) {
				calls := 0
				relayTestServer(t, func(request map[string]any) any {
					calls++
					checkPRMergeableRequest(t, request)
					return prMergeableFixture(test.value, test.present)
				})
				var out bytes.Buffer
				result := handleGHPR(t.Context(), []string{
					"view", "7", "--repo", "openclaw/octopool", "--json", fields,
				}, &out)
				if result.err != nil || result.action != ghComplete {
					t.Fatalf("action=%v err=%v", result.action, result.err)
				}
				checkPRMergeableProjection(t, out.String(), fields, test.want)
				if calls != 1 {
					t.Errorf("PR requests = %d, want 1", calls)
				}
			})
		}
	}
}

func TestRunGHAPIPRMergeablePreservesREST(t *testing.T) {
	for _, test := range prMergeableTestCases {
		t.Run(test.name, func(t *testing.T) {
			pr := prMergeableFixture(test.value, test.present)
			relayTestServer(t, func(request map[string]any) any {
				if request["path"] != "/repos/openclaw/octopool/pulls/7" {
					t.Errorf("unexpected path: %v", request["path"])
				}
				return pr
			})
			var out bytes.Buffer
			if err := runGH(t.Context(), []string{"api", "repos/openclaw/octopool/pulls/7"}, &out, &bytes.Buffer{}); err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, pr) {
				t.Errorf("raw REST = %#v, want %#v", got, pr)
			}
		})
	}
}

var prMergeableDelegationArgs = [][]string{
	{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", "mergeCommit"},
	{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", "mergeStateStatus"},
	{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", "mergeable,mergeCommit"},
	{"pr", "view", "7", "--repo", "openclaw/octopool", "--json", "mergeable,mergeStateStatus"},
	{"pr", "list", "--repo", "openclaw/octopool", "--json", "mergeable"},
}

func TestRunGHPRMergeableUnsupportedFieldsDelegate(t *testing.T) {
	for _, args := range prMergeableDelegationArgs {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			emptyRewriteTestServer(t)
			var out bytes.Buffer
			result := handleGHPR(t.Context(), args[1:], &out)
			if result.err != nil || result.action != ghDelegate || out.Len() != 0 {
				t.Fatalf("action=%v err=%v output=%q", result.action, result.err, out.String())
			}
		})
	}
}

func TestCLIEndToEndPRMergeable(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and executes the CLI binary")
	}
	bin := buildCLIBinary(t)
	for _, test := range prMergeableTestCases {
		t.Run(test.name, func(t *testing.T) {
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				request := decodeCLIRequest(t, w, r)
				if request == nil {
					return
				}
				checkPRMergeableRequest(t, request)
				writeCLIEnvelope(t, w, prMergeableFixture(test.value, test.present))
			})
			for _, fields := range []string{prMergeableTestFields, "mergeable"} {
				t.Run(fields, func(t *testing.T) {
					result := runCLI(t, bin, server.URL, map[string]string{
						"OCTOPOOL_NO_FALLBACK": "1", "OCTOPOOL_FRESH": "", "OCTOPOOL_GH_PATH": fakeGH(t),
					}, "gh", "pr", "view", "7", "--repo", "openclaw/octopool", "--json", fields)
					if result.err != nil {
						t.Fatalf("err=%v stdout=%q stderr=%q", result.err, result.stdout, result.stderr)
					}
					checkPRMergeableProjection(t, result.stdout, fields, test.want)
				})
			}
			t.Run("jq", func(t *testing.T) {
				if !jqAvailable() {
					t.Skip("jq is not installed")
				}
				jq := `.mergeable == "` + test.want + `" and (.mergeable | type) == "string" and keys == ["mergeable"]`
				result := runCLI(t, bin, server.URL, map[string]string{
					"OCTOPOOL_NO_FALLBACK": "1", "OCTOPOOL_FRESH": "", "OCTOPOOL_GH_PATH": fakeGH(t),
				}, "gh", "pr", "view", "7", "--repo", "openclaw/octopool", "--json", "mergeable", "--jq", jq)
				if result.err != nil || result.stdout != "true\n" {
					t.Fatalf("err=%v stdout=%q stderr=%q, want true", result.err, result.stdout, result.stderr)
				}
			})
		})
	}
	for _, args := range prMergeableDelegationArgs {
		t.Run("delegate/"+strings.Join(args, " "), func(t *testing.T) {
			server := cliRelayServer(t, func(w http.ResponseWriter, r *http.Request) {
				t.Error("unexpected PR relay request")
				http.Error(w, "unexpected PR relay request", http.StatusBadRequest)
			})
			result := runCLI(t, bin, server.URL, map[string]string{
				"OCTOPOOL_GH_PATH": fakeGH(t), "OCTOPOOL_NO_FALLBACK": "",
			}, append([]string{"gh"}, args...)...)
			want := "real-gh:" + strings.Join(args, " ") + "\n"
			if result.err != nil || result.stdout != want {
				t.Fatalf("err=%v stdout=%q stderr=%q, want %q", result.err, result.stdout, result.stderr, want)
			}
		})
	}
}
