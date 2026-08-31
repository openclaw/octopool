package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// Filesystem isolation alone does not clear inherited caller or native overrides.
func declaredInputEnvironment(t *testing.T) {
	t.Helper()
	isolateTestConfig(t)
	for _, key := range []string{"OCTOPOOL_TOKEN", "OCTOPOOL_URL", "OCTOPOOL_POOL", "OCTOPOOL_STRING_REWRITE_FILE", "OCTOPOOL_GH_PATH", "OCTOPOOL_NO_FALLBACK", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_REPO", "OCTOPOOL_TEST_DECLARED_CAPTURE", "OCTOPOOL_TEST_DECLARED_MUTATE", "OCTOPOOL_TEST_DECLARED_EXIT"} {
		t.Setenv(key, "")
	}
}

func buildDeclaredInputChild(t *testing.T) string {
	t.Helper()
	tool, env := testCompiler(t)
	path := filepath.Join(t.TempDir(), executableName("capture-input"))
	cmd := exec.CommandContext(t.Context(), tool, "build", "-o", path, "./testdata/declared-input-child")
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("capture child build: %v\n%s", err, out)
	}
	return path
}

type declaredInputReader struct {
	io.Reader
	reads, bytes int
}

func (r *declaredInputReader) Read(p []byte) (int, error) {
	r.reads++
	n, err := r.Reader.Read(p)
	r.bytes += n
	return n, err
}

func TestDeclaredInput(t *testing.T) {
	// Resolve reusable compiler caches before replacing application config roots.
	binary := buildCLIBinary(t)
	child := buildDeclaredInputChild(t)
	declaredInputEnvironment(t)
	policyStore, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	workflow := []string{"workflow", "run", "deploy.yml", "--repo=acme/repo"}
	api := []string{"api", "graphql", "--input=-"}
	run := func(t *testing.T, args []string, input io.Reader, blocked bool, top bool) rewriteCapture {
		t.Helper()
		capturePath := filepath.Join(t.TempDir(), "capture.json")
		t.Setenv("OCTOPOOL_GH_PATH", child)
		t.Setenv("OCTOPOOL_TEST_DECLARED_CAPTURE", capturePath)
		var stdout, stderr bytes.Buffer
		var err error
		if top {
			err = runGH(t.Context(), args, &stdout, &stderr)
		} else {
			// The child gets only platform/config essentials and synthetic fixture controls.
			env := testConfigEnv(t.TempDir())
			for _, key := range []string{"SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "OCTOPOOL_TEST_DECLARED_CAPTURE", "OCTOPOOL_TEST_DECLARED_MUTATE", "OCTOPOOL_TEST_DECLARED_EXIT"} {
				env = append(env, key+"="+os.Getenv(key))
			}
			err = execRealGHWithStdinAndEnv(t.Context(), args, input, &stdout, &stderr, env)
		}
		if blocked {
			if err != errRewriteBlocked || err.Error() != "string rewrite protection blocked unsafe input" || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Errorf("expected generic denial and no child output; err=%v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
			}
			if _, statErr := os.Stat(capturePath); !os.IsNotExist(statErr) {
				t.Error("denied input reached child")
			}
			return rewriteCapture{}
		}
		if err != nil {
			t.Fatalf("prepared child: %v; stderr=%s", err, &stderr)
		}
		if stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
			t.Fatalf("child streams changed: %q %q", &stdout, &stderr)
		}
		got := readRewriteCapture(t, capturePath)
		if got.Env["GH_HOST"] != "github.com" || got.Env["GH_REPO"] != "" {
			t.Fatal("child host not pinned")
		}
		for path := range got.Files {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Error("snapshot survived child exit")
			}
			if runtime.GOOS != "windows" && (got.Modes[path] != 0600 || got.DirectoryModes[path] != 0700) {
				t.Error("snapshot permissions changed")
			}
		}
		return got
	}

	for _, flag := range []string{"--json", "--json=1", "--json=t", "--json=T", "--json=true", "--json=TRUE", "--json=True"} {
		t.Run("true/"+flag, func(t *testing.T) {
			got := run(t, append(slices.Clone(workflow), flag), strings.NewReader(`{"message":"\u0069nternal-model"}`), false, false)
			var value map[string]string
			if err := json.Unmarshal([]byte(got.Stdin), &value); err != nil || value["message"] != "public" {
				t.Errorf("child did not receive rewritten string-map JSON: %q (%v)", got.Stdin, err)
			}
		})
	}
	for _, flags := range [][]string{
		nil, {"--json=0"}, {"--json=f"}, {"--json=F"}, {"--json=false"}, {"--json=FALSE"}, {"--json=False"}, {"--json", "--json=false"}, {"--", "--json"}, {"--ref", "--json"}, {"-r", "--json"}, {"--raw-field", "--json"}, {"--field", "--json"},
	} {
		t.Run("unread/"+strings.Join(flags, "_"), func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader("not JSON")}
			prepared, err := prepareProtectedGH(t.Context(), append(slices.Clone(workflow), flags...), reader)
			if prepared != nil {
				defer prepared.cleanup()
			}
			if err != nil || reader.reads != 0 {
				t.Errorf("inactive JSON declaration read stdin: reads=%d err=%v", reader.reads, err)
			}
		})
	}
	for _, flags := range [][]string{{"--json=0", "--json=T"}, {"--json", "false"}, {"--ref", "--", "--json=T"}, {"--json", "--", "--json=false"}} {
		t.Run("active/"+strings.Join(flags, "_"), func(t *testing.T) {
			got := run(t, append(slices.Clone(workflow), flags...), strings.NewReader(`{"message":"internal-model"}`), false, false)
			if got.Stdin != `{"message":"public"}` {
				t.Errorf("JSON not prepared: %q", got.Stdin)
			}
		})
	}
	for _, args := range [][]string{
		{"-Racme/repo", "workflow", "run", "deploy.yml", "--json=T"},
		{"workflow", "--repo", "acme/repo", "run", "deploy.yml", "--json=T"},
		{"--repo=acme/repo", "workflow", "run", "deploy.yml", "--json"},
	} {
		t.Run("command ownership/"+strings.Join(args, "_"), func(t *testing.T) {
			got := run(t, args, strings.NewReader(`{"message":"internal-model"}`), false, false)
			if got.Stdin != `{"message":"public"}` {
				t.Errorf("interleaved repository hid declaration: %q", got.Stdin)
			}
		})
	}
	for _, flag := range []string{"--json=", "--json=yes", "--json=TrUe", "--json= true", "--json=on"} {
		t.Run("invalid bool/"+flag, func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader(`{}`)}
			run(t, append(slices.Clone(workflow), flag, "--json=true"), reader, true, false)
			if reader.reads != 0 {
				t.Error("invalid occurrence read stdin")
			}
		})
	}
	bad := []struct{ name, body string }{
		{"duplicate", `{"message":"\u0069nternal-model","extra":"a","extra":"b"}`},
		{"decoded duplicate", `{"message":"\u0069nternal-model","ex\u0074ra":"a","extra":"b"}`},
		{"protected key duplicate", `{"\u0069nternal-model":"a","extra":"a","extra":"b"}`},
		{"nested duplicate", `{"nested":{"a":"x","a":"y"}}`},
		{"high surrogate", `{"message":"\u0069nternal-model","extra":"\ud800"}`},
		{"low surrogate", `{"message":"\u0069nternal-model","extra":"\udc00"}`},
		{"syntax", `{"message":`}, {"second value", `{} {}`}, {"whitespace", " \n\t"},
		{"UTF8", "{\"message\":\"\xff\"}"}, {"depth", strings.Repeat("[", 66) + "0" + strings.Repeat("]", 66)},
		{"key collision", `{"internal-model":"x","public":"y"}`},
	}
	for _, surface := range []string{"workflow", "API stdin", "API file"} {
		for _, test := range bad {
			t.Run(surface+" rejects/"+test.name, func(t *testing.T) {
				args := slices.Clone(api)
				if surface == "workflow" {
					args = append(slices.Clone(workflow), "--json")
				}
				if surface == "API file" {
					path := filepath.Join(t.TempDir(), "input.json")
					if err := os.WriteFile(path, []byte(test.body), 0600); err != nil {
						t.Fatal(err)
					}
					args[2] = "--input=" + path
				}
				run(t, args, strings.NewReader(test.body), true, surface == "API file")
			})
		}
	}
	for _, headers := range [][]string{
		{"--header", "Content-Type: application/json"}, {"-HContent-Type: application/problem+json"}, {"-H=Content-Type: Text/JSON; charset=utf-8"}, {"--header=cOnTeNt-TyPe: APPLICATION/JSON"},
		{"--header=Accept: text/plain"}, {"--header=Content-Type:", "--header=Content-Type: text/plain"},
		{"--header=Content-Type: application/json", "--header=Content-Type: APPLICATION/JSON"},
	} {
		t.Run("JSON headers/"+strings.Join(headers, "_"), func(t *testing.T) {
			run(t, append(slices.Clone(api), headers...), strings.NewReader(`{"a":"x","a":"y"}`), true, false)
		})
	}
	for _, headers := range [][]string{
		{"--header=Content-Type: nonsense"}, {"--header=Content-Type: application/json; broken"},
		{"--header=Content-Type: text/plain", "--header=Content-Type: application/json"},
		{"--header=Content-Type: text/plain", "--header=Content-Type:"},
		{"--header=Authorization: synthetic-denied"}, {"--hostname=enterprise.invalid"},
	} {
		t.Run("denial before read/"+strings.Join(headers, "_"), func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader(`{}`)}
			run(t, append(append(slices.Clone(api), "--verbose"), headers...), reader, true, false)
			if reader.reads != 0 {
				t.Error("invalid declaration or credential/host read source")
			}
		})
	}
	textBody := " {\"a\":\"internal-model\", \"a\":\"\\ud800\"} \n"
	for _, top := range []bool{false, true} {
		for _, first := range []bool{false, true} {
			name := "final"
			if top {
				name = "runGH"
			}
			if first {
				name += " header first"
			} else {
				name += " verbose first"
			}
			t.Run("explicit text/"+name, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "input.txt")
				if err := os.WriteFile(path, []byte(textBody), 0600); err != nil {
					t.Fatal(err)
				}
				flags := []string{"--verbose", "--header=Content-Type: text/plain"}
				if first {
					slices.Reverse(flags)
				}
				args := append([]string{"api", "graphql", "--input=" + path}, flags...)
				got := run(t, args, nil, false, top)
				if !rewriteCaptureHasContent(got, strings.ReplaceAll(textBody, "internal-model", "public")) {
					t.Errorf("text bytes reformatted: %v", got.Files)
				}
			})
		}
	}
	for _, body := range []string{"", `{"message":"\u0069nternal-model","emoji":"\ud83e\udd9e"}`, `null`, `["internal-model",123456789012345678901234567890]`, `true`, `"internal-model"`} {
		t.Run("valid JSON/"+body, func(t *testing.T) {
			got := run(t, api, strings.NewReader(body), false, false)
			want := strings.ReplaceAll(body, "internal-model", "public")
			if strings.Contains(body, `\u0069`) {
				want = `{"emoji":"🦞","message":"public"}`
			}
			if !rewriteCaptureHasContent(got, want) {
				t.Errorf("JSON compatibility changed: %v", got.Files)
			}
		})
	}
	t.Run("post delimiter visible only", func(t *testing.T) {
		got := run(t, []string{"api", "graphql", "--verbose", "--", "--input=missing-internal-model", "--header=Authorization: internal-model", "--hostname=enterprise.invalid", "-Fvalue=@missing-internal-model"}, nil, false, false)
		delimiter := slices.Index(got.Args, "--")
		host := slices.Index(got.Args, "--hostname=github.com")
		if host < 0 || host > delimiter || len(got.Files) != 0 || !slices.Contains(got.Args, "--input=missing-public") {
			t.Errorf("delimiter ownership lost: %v", got.Args)
		}
	})
	t.Run("header-looking value is text", func(t *testing.T) {
		got := run(t, []string{"api", "graphql", "--template", "--header=Authorization: internal-model", "--verbose"}, nil, false, false)
		if !slices.Contains(got.Args, "--header=Authorization: public") {
			t.Error("value not rewritten")
		}
	})
	t.Run("snapshot keeps original source", func(t *testing.T) {
		dir := t.TempDir()
		source := filepath.Join(dir, "internal-model.json")
		if err := os.WriteFile(source, []byte(`{"message":"internal-model"}`), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "public.json"), []byte(`{"message":"wrong source"}`), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("OCTOPOOL_TEST_DECLARED_MUTATE", source)
		got := run(t, []string{"api", "graphql", "--input", source}, nil, false, false)
		if !rewriteCaptureHasContent(got, `{"message":"public"}`) {
			t.Error("original capture lost")
		}
		if data, err := os.ReadFile(source); err != nil || string(data) != "later source bytes" {
			t.Fatal("child did not mutate source after preparation")
		}
	})
	t.Run("typed source stays literal text", func(t *testing.T) {
		got := run(t, []string{"workflow", "run", "deploy.yml", "--repo=acme/repo", "-Fmessage=@-"}, strings.NewReader(textBody), false, false)
		if !rewriteCaptureHasContent(got, strings.ReplaceAll(textBody, "internal-model", "public")) || got.Stdin != "" {
			t.Error("typed field lost text bytes or stdin ownership")
		}
	})
	t.Run("raw field stays argument", func(t *testing.T) {
		got := run(t, []string{"api", "graphql", "-fmessage=@missing-internal-model"}, nil, false, false)
		if len(got.Files) != 0 || !slices.Contains(got.Args, "-fmessage=@missing-public") {
			t.Error("raw field became source")
		}
	})
	t.Run("policy introduces JSON declaration", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"internal-model","replacement":"public"},{"pattern":"native-json","replacement":"json=1"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		got := run(t, append(slices.Clone(workflow), "--native-json"), strings.NewReader(`{"message":"internal-model"}`), false, false)
		if got.Stdin != `{"message":"public"}` {
			t.Error("new declaration not inspected")
		}
	})
	t.Run("text to JSON upgrade validates captured bytes", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"text/plain","replacement":"application/json"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		run(t, append(slices.Clone(api), "--verbose", "--header=Content-Type: text/plain"), strings.NewReader(`{"a":"x","a":"y"}`), true, false)
	})
	t.Run("JSON to text cannot downgrade", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"application/json","replacement":"text/plain"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		run(t, append(slices.Clone(api), "--verbose", "--header=Content-Type: application/json"), strings.NewReader(`{"a":"x","a":"y"}`), true, false)
	})
	t.Run("limit plus one", func(t *testing.T) {
		reader := &declaredInputReader{Reader: strings.NewReader(strings.Repeat(" ", rewriteMaxContent+200))}
		run(t, append(slices.Clone(workflow), "--json=1"), reader, true, false)
		if reader.bytes != rewriteMaxContent+1 {
			t.Errorf("bounded read consumed %d bytes", reader.bytes)
		}
	})
	for _, headers := range [][]string{
		{"--header", "Content-Type: application/json"},
		{"-HContent-Type: application/problem+json"},
		{"-H=Content-Type: Text/JSON; charset=utf-8"},
		{"--header=Content-Type:", "--header=Content-Type: not a MIME type"},
		{"--header=Content-Type: application/json; charset=utf-8; version=1", "--header=Content-Type: APPLICATION/JSON; version=1; charset=\"utf-8\""},
	} {
		t.Run("valid header JSON/"+strings.Join(headers, "_"), func(t *testing.T) {
			got := run(t, append(slices.Clone(api), headers...), strings.NewReader(`{"message":"internal-model"}`), false, false)
			if !rewriteCaptureHasContent(got, `{"message":"public"}`) {
				t.Error("declared JSON header not dispatched")
			}
		})
	}
	for _, flags := range [][]string{{"-r--json"}, {"-r=--json"}, {"--ref=--json"}, {"-f--json"}, {"-F=--json"}, {"--help=false", "--json=false"}} {
		t.Run("attached ownership/"+strings.Join(flags, "_"), func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader("not JSON")}
			prepared, err := prepareProtectedGH(t.Context(), append(slices.Clone(workflow), flags...), reader)
			if prepared != nil {
				defer prepared.cleanup()
			}
			if err != nil || reader.reads != 0 {
				t.Errorf("value became declaration: %v reads=%d", err, reader.reads)
			}
		})
	}
	for _, flag := range []string{"--raw-field", "--field", "--jq", "--template", "--cache", "--preview", "--method"} {
		t.Run("API value ownership/"+flag, func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader("not JSON")}
			prepared, err := prepareProtectedGH(t.Context(), []string{"api", "graphql", "--verbose", flag, "--input=-"}, reader)
			if prepared != nil {
				defer prepared.cleanup()
			}
			if err != nil || reader.reads != 0 {
				t.Errorf("value became source: %v reads=%d", err, reader.reads)
			}
		})
	}
	t.Run("consumed API delimiter is a value", func(t *testing.T) {
		got := run(t, append(slices.Clone(api), "--template", "--", "-HContent-Type: text/plain"), strings.NewReader(textBody), false, false)
		if !rewriteCaptureHasContent(got, strings.ReplaceAll(textBody, "internal-model", "public")) {
			t.Error("value delimiter hid text declaration")
		}
	})
	t.Run("stdin remains idle without input declaration", func(t *testing.T) {
		reader := &declaredInputReader{Reader: strings.NewReader("not JSON")}
		prepared, err := prepareProtectedGH(t.Context(), []string{"api", "graphql", "--header=Content-Type: application/json"}, reader)
		if prepared != nil {
			defer prepared.cleanup()
		}
		if err != nil || reader.reads != 0 {
			t.Errorf("header alone read stdin: %v reads=%d", err, reader.reads)
		}
	})
	t.Run("unrelated operand does not select workflow", func(t *testing.T) {
		reader := &declaredInputReader{Reader: strings.NewReader("not JSON")}
		prepared, err := prepareProtectedGH(t.Context(), []string{"config", "get", "workflow", "run", "--json"}, reader)
		if prepared != nil {
			defer prepared.cleanup()
		}
		if err != nil || reader.reads != 0 {
			t.Errorf("operand selected workflow: %v reads=%d", err, reader.reads)
		}
	})
	t.Run("generated repo precedes delimiter", func(t *testing.T) {
		repo := t.TempDir()
		for _, args := range [][]string{{"init", "--quiet", repo}, {"-C", repo, "remote", "add", "origin", "https://github.com/acme/repo"}} {
			cmd := exec.CommandContext(t.Context(), "git", args...)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("synthetic repo: %v %s", err, out)
			}
		}
		t.Chdir(repo)
		got := run(t, []string{"workflow", "run", "--json", "--", "deploy.yml"}, strings.NewReader(`{"message":"internal-model"}`), false, false)
		pin, delimiter := slices.Index(got.Args, "--repo=github.com/acme/repo"), slices.Index(got.Args, "--")
		if pin < 0 || pin > delimiter {
			t.Errorf("repo pin became positional: %v", got.Args)
		}
	})
	t.Run("explicit text stdin preserves valid JSON formatting", func(t *testing.T) {
		body := " { \"message\" : \"internal-model\" } \n"
		got := run(t, append(slices.Clone(api), "--header=Content-Type: text/plain"), strings.NewReader(body), false, false)
		if !rewriteCaptureHasContent(got, strings.ReplaceAll(body, "internal-model", "public")) {
			t.Error("explicit text was JSON formatted")
		}
	})
	t.Run("binary declaration is not an escape hatch", func(t *testing.T) {
		run(t, append(slices.Clone(api), "--header=Content-Type: application/octet-stream"), strings.NewReader("\xff"), true, false)
	})
	t.Run("undeclared input retains opportunistic text", func(t *testing.T) {
		got := run(t, []string{"extension", "synthetic", "--input=-"}, strings.NewReader(textBody), false, false)
		if !rewriteCaptureHasContent(got, strings.ReplaceAll(textBody, "internal-model", "public")) {
			t.Error("undeclared text changed")
		}
	})
	t.Run("workflow exact zero bytes", func(t *testing.T) {
		got := run(t, append(slices.Clone(workflow), "--json=T"), strings.NewReader(""), false, false)
		if got.Stdin != "" {
			t.Error("zero-byte workflow input changed")
		}
	})
	t.Run("modeled empty body remains invalid", func(t *testing.T) {
		run(t, []string{"api", "repos/acme/repo/issues/1/comments", "--method=POST", "--input=-"}, strings.NewReader(""), true, false)
	})
	for _, surface := range []string{"regular stdin file", "pipe"} {
		t.Run(surface, func(t *testing.T) {
			body := `{"message":"\u0069nternal-model"}`
			var reader *os.File
			if surface == "pipe" {
				var writer *os.File
				var err error
				reader, writer, err = os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := io.WriteString(writer, body); err != nil {
					t.Fatal(err)
				}
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				path := filepath.Join(t.TempDir(), "stdin.json")
				if err := os.WriteFile(path, []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
				var err error
				reader, err = os.Open(path)
				if err != nil {
					t.Fatal(err)
				}
			}
			defer reader.Close()
			got := run(t, append(slices.Clone(workflow), "--json=T"), reader, false, false)
			if got.Stdin != `{"message":"public"}` {
				t.Error("file/pipe input not inspected")
			}
		})
	}
	t.Run("upgrade captures once and rewrites once", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"text/plain","replacement":"application/json"},{"pattern":"internal-model","replacement":"public"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		body := `{"message":"` + strings.Repeat("a", 600000) + `\u0069nternal-model"}`
		reader := &declaredInputReader{Reader: strings.NewReader(body)}
		got := run(t, append(slices.Clone(api), "--header=Content-Type: text/plain"), reader, false, false)
		if reader.bytes != len(body) || !rewriteCaptureHasContent(got, `{"message":"`+strings.Repeat("a", 600000)+`public"}`) {
			t.Error("capture was reread, charged twice, or not JSON inspected")
		}
	})
	t.Run("rewritten input source is captured", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"new-input","replacement":"input"},{"pattern":"internal-model","replacement":"public"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		got := run(t, []string{"api", "graphql", "--verbose", "--new-input=-"}, strings.NewReader(`{"message":"internal-model"}`), false, false)
		if !rewriteCaptureHasContent(got, `{"message":"public"}`) || got.Stdin != "" {
			t.Error("new input source escaped preparation")
		}
	})
	for _, headers := range [][]string{
		{"--header=Content-Type: text/plain", "--header=Authorization: synthetic-denied", "--verbose"},
		{"--verbose", "--header=Authorization: synthetic-denied", "--header=Content-Type: text/plain"},
		{"--header=Proxy-Authorization: synthetic-denied", "--header=Content-Type: text/plain"},
		{"--header=Content-Type: text/plain", "--header=X-GitHub-Token: synthetic-denied"},
	} {
		t.Run("credential header order/"+strings.Join(headers, "_"), func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader(textBody)}
			run(t, append(slices.Clone(api), headers...), reader, true, false)
			if reader.reads != 0 {
				t.Error("credential denial read source")
			}
		})
	}
	for _, test := range []struct{ name, body string }{
		{"material", `{"message":"{\"pattern\":\"internal-model\",\"replacement\":\"public\"}"}`},
		{"marshal expansion", `"` + strings.Repeat("<", 180000) + `"`},
	} {
		t.Run("final budget and material/"+test.name, func(t *testing.T) { run(t, api, strings.NewReader(test.body), true, false) })
	}
	t.Run("aggregate sources and cleanup", func(t *testing.T) {
		temp := t.TempDir()
		for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
			t.Setenv(key, temp)
		}
		path := filepath.Join(t.TempDir(), "large.txt")
		if err := os.WriteFile(path, []byte(strings.Repeat("a", 600000)), 0600); err != nil {
			t.Fatal(err)
		}
		run(t, []string{"workflow", "run", "deploy.yml", "--repo=acme/repo", "-Fone=@" + path, "-Ftwo=@" + path}, nil, true, false)
		if files, err := os.ReadDir(temp); err != nil || len(files) != 0 {
			t.Fatalf("denial left staging: %v (%v)", files, err)
		}
	})
	t.Run("duplicate stdin consumers reject", func(t *testing.T) {
		run(t, []string{"api", "graphql", "--verbose", "--input=-", "-Fbody=@-"}, strings.NewReader(`{}`), true, false)
	})
	t.Run("expansion limit and residual rejection", func(t *testing.T) {
		policy, _ := json.Marshal(map[string]any{"schema_version": 1, "revision": 1, "updated_at": "2026-08-28T00:00:00Z", "rules": []map[string]string{{"pattern": "internal-model", "replacement": strings.Repeat("p", 1024)}}})
		policyStore.Store(string(policy))
		defer policyStore.Store(rewriteActiveTestPolicy)
		run(t, api, strings.NewReader(`"`+strings.Repeat("internal-model", 1100)+`"`), true, false)
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"internal-model","replacement":"public"},{"pattern":"REMOVE","replacement":""}]}`)
		run(t, api, strings.NewReader(`{"message":"interREMOVEnal-model"}`), true, false)
	})
	for _, failure := range []string{"start", "exit"} {
		t.Run("cleanup on child "+failure, func(t *testing.T) {
			temp := t.TempDir()
			for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
				t.Setenv(key, temp)
			}
			t.Setenv("OCTOPOOL_GH_PATH", child)
			capture := filepath.Join(t.TempDir(), "capture.json")
			t.Setenv("OCTOPOOL_TEST_DECLARED_CAPTURE", capture)
			t.Setenv("OCTOPOOL_TEST_DECLARED_EXIT", "7")
			if failure == "start" {
				broken := filepath.Join(t.TempDir(), executableName("broken-child"))
				if err := os.WriteFile(broken, []byte("synthetic invalid executable\n"), 0700); err != nil {
					t.Fatal(err)
				}
				t.Setenv("OCTOPOOL_GH_PATH", broken)
			}
			var stdout, stderr bytes.Buffer
			err := execRealGHWithStdin(t.Context(), api, strings.NewReader(`{"message":"internal-model"}`), &stdout, &stderr)
			if err == nil {
				t.Fatal("expected child failure")
			}
			if failure == "exit" {
				if err != (exitCodeError{Code: 7}) || stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
					t.Fatalf("child exit lost: %v %q %q", err, &stdout, &stderr)
				}
				got := readRewriteCapture(t, capture)
				if !rewriteCaptureHasContent(got, `{"message":"public"}`) {
					t.Error("failed child did not receive snapshot")
				}
			} else if _, err := os.Stat(capture); !os.IsNotExist(err) {
				t.Error("invalid executable ran capture child")
			}
			if files, err := os.ReadDir(temp); err != nil || len(files) != 0 {
				t.Fatalf("child failure left staging: %v (%v)", files, err)
			}
		})
	}
	t.Run("CLI generic diagnostic", func(t *testing.T) {
		capture := filepath.Join(t.TempDir(), "capture.json")
		cmd := exec.CommandContext(t.Context(), binary, "gh", "workflow", "run", "deploy.yml", "--repo=acme/repo", "--json=T")
		cmd.Env = testConfigEnv(t.TempDir())
		for _, key := range []string{"SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "OCTOPOOL_URL", "OCTOPOOL_POOL", "OCTOPOOL_TOKEN"} {
			cmd.Env = append(cmd.Env, key+"="+os.Getenv(key))
		}
		cmd.Env = append(cmd.Env, "OCTOPOOL_GH_PATH="+child, "OCTOPOOL_TEST_DECLARED_CAPTURE="+capture)
		cmd.Stdin = strings.NewReader(`{"message":"\u0069nternal-model","extra":"a","extra":"b"}`)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 || stdout.Len() != 0 || stderr.String() != "error: string rewrite protection blocked unsafe input\n" {
			t.Fatalf("CLI denial: %v %q %q", err, &stdout, &stderr)
		}
		if _, err := os.Stat(capture); !os.IsNotExist(err) {
			t.Error("CLI denial reached child")
		}
	})

}

// These target semantics are independently established by installed native gh:
// API -i bundles continue into F/H; -s is not an API shorthand; h returns help.
func TestDeclaredInputBundles(t *testing.T) {
	child := buildDeclaredInputChild(t)
	declaredInputEnvironment(t)
	policyStore, _ := rewriteTestServer(t, rewriteActiveTestPolicy, nil)
	type capture struct {
		rewriteCapture
		Include, Silent, Help bool
		Headers               []string
		Fields, RawFields     []string
	}
	run := func(t *testing.T, args []string, stdin io.Reader, blocked, top bool) capture {
		t.Helper()
		path := filepath.Join(t.TempDir(), "capture.json")
		t.Setenv("OCTOPOOL_GH_PATH", child)
		t.Setenv("OCTOPOOL_TEST_DECLARED_CAPTURE", path)
		var stdout, stderr bytes.Buffer
		var err error
		if top {
			err = runGH(t.Context(), args, &stdout, &stderr)
		} else {
			env := testConfigEnv(t.TempDir())
			for _, key := range []string{"SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP", "OCTOPOOL_TEST_DECLARED_CAPTURE"} {
				env = append(env, key+"="+os.Getenv(key))
			}
			err = execRealGHWithStdinAndEnv(t.Context(), args, stdin, &stdout, &stderr, env)
		}
		if blocked {
			if err != errRewriteBlocked || stdout.Len() != 0 || stderr.Len() != 0 {
				t.Errorf("expected generic denial with no child output: %v %q %q", err, &stdout, &stderr)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Error("denied bundle reached child")
			}
			return capture{}
		}
		if err != nil {
			t.Fatalf("prepared child: %v %q", err, &stderr)
		}
		var got capture
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		if stdout.String() != "child stdout\n" || stderr.String() != "child stderr\n" {
			t.Error("child streams changed")
		}
		return got
	}
	for _, spelling := range []string{"-iF", "-iF=", "-iiF", "-iF separate", "-i -F", "-i=false -F", "-ii=false -F"} {
		for _, sourceKind := range []string{"file", "stdin"} {
			t.Run("typed source/"+spelling+"/"+sourceKind, func(t *testing.T) {
				source := "-"
				original := "internal-model\n"
				if sourceKind == "file" {
					source = filepath.Join(t.TempDir(), "original.txt")
					if err := os.WriteFile(source, []byte(original), 0600); err != nil {
						t.Fatal(err)
					}
				}
				value := "body=@" + source
				flags := []string{spelling + value}
				switch spelling {
				case "-iF separate":
					flags = []string{"-iF", value}
				case "-i -F":
					flags = []string{"-i", "-F", value}
				case "-i=false -F":
					flags = []string{"-i=false", "-F", value}
				case "-ii=false -F":
					flags = []string{"-ii=false", "-F", value}
				}
				got := run(t, append([]string{"api", "graphql", "--verbose"}, flags...), strings.NewReader(original), false, false)
				if !rewriteCaptureHasContent(got.rewriteCapture, "public\n") {
					t.Errorf("target received unfiltered or missing source: %v", got.Files)
				}
				if got.Include != !strings.Contains(spelling, "false") {
					t.Errorf("include option lost: %v", got.Args)
				}
				for path := range got.Files {
					if path == source || path == "-" {
						t.Error("target retained original source")
					}
					if _, err := os.Stat(path); !os.IsNotExist(err) {
						t.Error("snapshot not cleaned")
					}
				}
				if sourceKind == "file" {
					if data, err := os.ReadFile(source); err != nil || string(data) != original {
						t.Error("original file changed")
					}
				} else if got.Stdin != "" {
					t.Error("stdin source was not captured")
				}
			})
		}
	}
	for _, header := range []string{"Authorization:synthetic-denied", "Proxy-Authorization:synthetic-denied", "X-GitHub-Token:synthetic-denied"} {
		for _, separate := range []bool{false, true} {
			t.Run("credential/"+header+"/"+strconv.FormatBool(separate), func(t *testing.T) {
				args := []string{"api", "graphql", "--verbose", "--input=-", "-iH" + header}
				if separate {
					args = append(args[:len(args)-1], "-iH", header)
				}
				reader := &declaredInputReader{Reader: strings.NewReader(`{}`)}
				run(t, args, reader, true, false)
				if reader.reads != 0 {
					t.Error("bundled credential denial read source")
				}
			})
		}
	}
	for _, flags := range [][]string{
		{"-iHContent-Type:text/plain"}, {"-iH=Content-Type:text/plain"}, {"-iH", "Content-Type:text/plain"}, {"-i", "-HContent-Type:text/plain"},
		{"-iHContent-Type:application/json"}, {"-iHContent-Type:application/problem+json"}, {"-iHContent-Type:text/plain", "-HContent-Type:application/json"},
	} {
		t.Run("content type/"+strings.Join(flags, "_"), func(t *testing.T) {
			body := " {\"a\":\"internal-model\", \"a\":\"second\"} \n"
			blocked := strings.Contains(strings.Join(flags, " "), "json")
			got := run(t, append([]string{"api", "graphql", "--verbose", "--input=-"}, flags...), strings.NewReader(body), blocked, false)
			if !blocked && (!got.Include || !rewriteCaptureHasContent(got.rewriteCapture, strings.ReplaceAll(body, "internal-model", "public"))) {
				t.Error("bundled text changed content or include semantics")
			}
		})
	}
	t.Run("bundled source through runGH", func(t *testing.T) {
		source := filepath.Join(t.TempDir(), "original.txt")
		if err := os.WriteFile(source, []byte("internal-model"), 0600); err != nil {
			t.Fatal(err)
		}
		got := run(t, []string{"api", "graphql", "-iFbody=@" + source}, nil, false, true)
		if !got.Include || !rewriteCaptureHasContent(got.rewriteCapture, "public") {
			t.Error("runGH lost bundle protection")
		}
	})
	for _, flags := range [][]string{{"-i=0"}, {"-i=TRUE"}, {"-ii=false"}, {"-i", "--silent"}, {"-iFbody==--json"}, {"-Fbody=-iHAuthorization:synthetic"}, {"-it", "--", "--input=-"}, {"--", "-iFbody=@missing"}} {
		t.Run("ownership/"+strings.Join(flags, "_"), func(t *testing.T) {
			args := append([]string{"api", "graphql", "--verbose"}, flags...)
			input := strings.NewReader(`{"message":"safe"}`)
			got := run(t, args, input, false, false)
			if strings.HasPrefix(flags[0], "-i") && flags[0] != "-i=0" && flags[0] != "-ii=false" && !got.Include {
				t.Error("leading include disappeared")
			}
			if flags[0] == "-i=0" || flags[0] == "-ii=false" {
				if got.Include {
					t.Error("Boolean assignment lost")
				}
			}
			if slices.Contains(flags, "--silent") && !got.Silent {
				t.Error("silent long option lost")
			}
			if flags[0] == "-it" && !rewriteCaptureHasContent(got.rewriteCapture, `{"message":"safe"}`) {
				t.Error("consumed template delimiter hid the input source")
			}
			if flags[0] == "--" && len(got.Files) != 0 {
				t.Error("postdelimiter source opened")
			}
		})
	}
	for _, flag := range []string{"-i=falseFbody=@-", "-i=", "-i=invalid", "--include=", "--include=invalid"} {
		t.Run("invalid include assignment/"+flag, func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader(`{}`)}
			run(t, []string{"api", "graphql", "--verbose", flag, "--input=-"}, reader, true, false)
			if reader.reads != 0 {
				t.Error("invalid Boolean occurrence read source")
			}
		})
	}
	for _, rule := range []struct{ pattern, replacement string }{{"include", "public"}, {"true", "false"}} {
		for _, flags := range [][]string{{"-i"}, {"-ii"}, {"-i=1"}, {"-iFbody=@-"}, {"-iiFbody=@-"}, {"-iHX-Fixture:safe"}} {
			t.Run("caller spelling/"+rule.pattern+"/"+strings.Join(flags, "_"), func(t *testing.T) {
				policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"` + rule.pattern + `","replacement":"` + rule.replacement + `"}]}`)
				defer policyStore.Store(rewriteActiveTestPolicy)
				var input io.Reader
				if strings.Contains(strings.Join(flags, ""), "Fbody=@-") {
					input = strings.NewReader("safe")
				}
				got := run(t, append([]string{"api", "graphql", "--verbose"}, flags...), input, false, false)
				if !got.Include {
					t.Error("synthetic flag text changed the caller's include option")
				}
				if input != nil && !rewriteCaptureHasContent(got.rewriteCapture, "safe") {
					t.Error("preserving shorthand lost source protection")
				}
			})
		}
	}
	t.Run("literal Boolean matches still rewrite", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"true","replacement":"false"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		got := run(t, []string{"api", "graphql", "--verbose", "-i=true"}, nil, false, false)
		if got.Include {
			t.Error("caller-provided Boolean value was not rewritten")
		}
		got = run(t, []string{"api", "graphql", "--verbose", "-iFbody=@-"}, strings.NewReader("true"), false, false)
		if !got.Include || !rewriteCaptureHasContent(got.rewriteCapture, "false") {
			t.Error("implicit Boolean and explicit source text were conflated")
		}
	})
	t.Run("literal bundle text matches still rewrite", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"iHX-Fixture:old","replacement":"iHX-Fixture:new"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		got := run(t, []string{"api", "graphql", "--verbose", "-iHX-Fixture:old"}, nil, false, false)
		if !got.Include || !slices.Contains(got.Headers, "X-Fixture:new") {
			t.Error("splitting the caller's bundle erased an original policy match")
		}
	})
	t.Run("literal header matches still rewrite", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"include","replacement":"public"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		got := run(t, []string{"api", "graphql", "--verbose", "-iHX-Fixture:include"}, nil, false, false)
		if !got.Include || !slices.Contains(got.Headers, "X-Fixture:public") {
			t.Error("implicit flag name and caller-provided header text were conflated")
		}
	})
	for _, flag := range []string{"-i-method=GET", "-ii-method=GET", "-i-header=X-Fixture:value", "-i-include=false", "-i-input=-", "-i-"} {
		t.Run("malformed bundle/"+flag, func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader(`{}`)}
			run(t, []string{"api", "graphql", "--verbose", "--input=-", flag}, reader, true, false)
			if reader.reads != 0 {
				t.Error("invalid shorthand became executable or read a source")
			}
		})
	}
	t.Run("policy-created malformed bundle", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"bundle-invalid","replacement":"-i-method=GET"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		run(t, []string{"api", "graphql", "--verbose", "--input=-", "bundle-invalid"}, strings.NewReader(`{}`), true, false)
	})
	t.Run("policy-created bundle", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"bundle-input","replacement":"-iFbody=@-"},{"pattern":"internal-model","replacement":"public"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		got := run(t, []string{"api", "graphql", "--verbose", "bundle-input"}, strings.NewReader("internal-model"), false, false)
		if !got.Include || !rewriteCaptureHasContent(got.rewriteCapture, "public") || got.Stdin != "" {
			t.Error("new bundle escaped preparation")
		}
	})
	for _, test := range []struct {
		name  string
		flags []string
		help  bool
	}{
		{"long", []string{"--help"}, true}, {"long true", []string{"--help=TRUE"}, true}, {"short", []string{"-h"}, true}, {"short suffix", []string{"-hh=false"}, true},
		{"short cannot be unset", []string{"-h", "--help=false"}, true}, {"short ignores later invalid JSON", []string{"-h", "--json=invalid"}, true},
		{"final false", []string{"--help", "--help=false"}, false}, {"final true", []string{"--help=false", "--help"}, true},
		{"value-owned", []string{"--ref", "--help"}, false}, {"short value-owned", []string{"-r-h"}, false}, {"postdelimiter", []string{"--", "--help"}, false}, {"consumed delimiter", []string{"--ref", "--", "--help"}, true},
	} {
		t.Run("workflow help/"+test.name, func(t *testing.T) {
			args := []string{"workflow", "run", "--repo=acme/repo", "--json"}
			if test.name != "postdelimiter" {
				args = append(args, "deploy.yml")
			}
			args = append(args, test.flags...)
			reader := &declaredInputReader{Reader: strings.NewReader(`{"message":"internal-model"}`)}
			prepared, err := prepareProtectedGH(t.Context(), args, reader)
			if err != nil {
				t.Fatalf("preparation: %v", err)
			}
			prepared.cleanup()
			if (reader.reads == 0) != test.help {
				t.Errorf("help stdin ownership: reads=%d help=%v", reader.reads, test.help)
			}
			input := filepath.Join(t.TempDir(), "stdin.json")
			if err := os.WriteFile(input, []byte(`{"message":"internal-model"}`), 0600); err != nil {
				t.Fatal(err)
			}
			file, err := os.Open(input)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			saved := os.Stdin
			os.Stdin = file
			defer func() { os.Stdin = saved }()
			got := run(t, args, nil, false, true)
			offset, err := file.Seek(0, io.SeekCurrent)
			if err != nil {
				t.Fatal(err)
			}
			if got.Help != test.help || (offset == 0) != test.help {
				t.Errorf("runGH help/control changed stdin: help=%v offset=%d args=%v", got.Help, offset, got.Args)
			}
			if !test.help && got.Stdin != `{"message":"public"}` {
				t.Error("false or value-owned help skipped JSON protection")
			}
		})
	}
	for _, test := range []struct{ arg, field, raw, header string }{
		{"-iFbody==--json", "body==--json", "", ""},
		{"-iFbody=-i-method=GET", "body=-i-method=GET", "", ""},
		{"-iFbody=-iHAuthorization:synthetic", "body=-iHAuthorization:synthetic", "", ""},
		{"-iF=body=--help", "body=--help", "", ""},
		{"-Fbody=-iHAuthorization:synthetic", "body=-iHAuthorization:synthetic", "", ""},
		{"-ifbody=@missing=--json", "", "body=@missing=--json", ""},
		{"-iHX-Fixture:-Fbody=@missing=--help", "", "", "X-Fixture:-Fbody=@missing=--help"},
	} {
		t.Run("full value/"+test.arg, func(t *testing.T) {
			got := run(t, []string{"api", "graphql", "--verbose", test.arg}, nil, false, false)
			if len(got.Files) != 0 {
				t.Error("literal value became a source")
			}
			if test.field != "" && !slices.Contains(got.Fields, test.field) {
				t.Errorf("field remainder changed: %v", got.Fields)
			}
			if test.raw != "" && !slices.Contains(got.RawFields, test.raw) {
				t.Errorf("raw remainder changed: %v", got.RawFields)
			}
			if test.header != "" && !slices.Contains(got.Headers, test.header) {
				t.Errorf("header remainder changed: %v", got.Headers)
			}
		})
	}
	t.Run("bundled path frozen before rewriting and delimiter", func(t *testing.T) {
		dir := t.TempDir()
		source := filepath.Join(dir, "-internal-model=source.txt")
		if err := os.WriteFile(source, []byte("internal-model"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "-public=source.txt"), []byte("wrong source"), 0600); err != nil {
			t.Fatal(err)
		}
		got := run(t, []string{"api", "graphql", "--verbose", "-iFbody=@" + source, "--", "-iFother=@missing"}, nil, false, false)
		if !got.Include || !rewriteCaptureHasContent(got.rewriteCapture, "public") || len(got.Files) != 1 {
			t.Error("bundle lost original source or delimiter ownership")
		}
		if data, err := os.ReadFile(source); err != nil || string(data) != "internal-model" {
			t.Error("original source changed")
		}
		for path := range got.Files {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Error("sanitized snapshot survived exit")
			}
		}
	})
	t.Run("bundled header upgrade retains stronger inspection", func(t *testing.T) {
		policyStore.Store(`{"schema_version":1,"revision":1,"updated_at":"2026-08-28T00:00:00Z","rules":[{"pattern":"text/plain","replacement":"application/json"},{"pattern":"internal-model","replacement":"public"}]}`)
		defer policyStore.Store(rewriteActiveTestPolicy)
		args := []string{"api", "graphql", "--verbose", "--input=-", "-iHContent-Type:text/plain"}
		got := run(t, args, strings.NewReader(`{"message":"\u0069nternal-model"}`), false, false)
		if !got.Include || !rewriteCaptureHasContent(got.rewriteCapture, `{"message":"public"}`) || !slices.Contains(got.Headers, "Content-Type:application/json") {
			t.Error("normalization lost upgraded header or original source inspection")
		}
		run(t, args, strings.NewReader(`{"a":"one","a":"two"}`), true, false)
	})
	t.Run("argument bytes remain bounded before sources", func(t *testing.T) {
		reader := &declaredInputReader{Reader: strings.NewReader(`{}`)}
		args := []string{"api", "graphql", "--input=-", "-" + strings.Repeat("i", rewriteMaxContent)}
		run(t, args, reader, true, false)
		if reader.reads != 0 {
			t.Error("oversize argv read stdin")
		}
	})
	for _, flags := range [][]string{{"--help="}, {"--help", "--json=invalid"}} {
		t.Run("invalid long help parse/"+strings.Join(flags, "_"), func(t *testing.T) {
			reader := &declaredInputReader{Reader: strings.NewReader(`{}`)}
			run(t, append([]string{"workflow", "run", "deploy.yml", "--repo=acme/repo", "--json"}, flags...), reader, true, false)
			if reader.reads != 0 {
				t.Error("invalid long help invocation read stdin")
			}
		})
	}
	t.Run("capture target rejects empty include assignment", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "capture.json")
		cmd := exec.CommandContext(t.Context(), child, "api", "graphql", "-i=")
		cmd.Env = append(testConfigEnv(t.TempDir()), "OCTOPOOL_TEST_DECLARED_CAPTURE="+path)
		for _, key := range []string{"SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"} {
			cmd.Env = append(cmd.Env, key+"="+os.Getenv(key))
		}
		if err := cmd.Run(); err == nil {
			t.Error("explicit empty assignment became bare true")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Error("invalid target invocation captured inputs")
		}
	})

}
