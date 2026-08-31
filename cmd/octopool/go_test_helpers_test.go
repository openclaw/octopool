package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testGoTool(t *testing.T) string {
	t.Helper()
	tool := executableName("go")
	// -trimpath can leave GOROOT empty; use PATH only in that case.
	if root := runtime.GOROOT(); root != "" {
		tool = filepath.Join(root, "bin", tool)
	}
	path, err := exec.LookPath(tool)
	if err != nil {
		t.Fatalf("locate Go compiler (%q): %v", tool, err)
	}
	return path
}

func testCompiler(t *testing.T) (string, []string) {
	t.Helper()
	tool := testGoTool(t)
	root := t.TempDir()
	telemetry := filepath.Join(root, "telemetry")
	if err := os.Mkdir(telemetry, 0o700); err != nil {
		t.Fatal(err)
	}
	// Go's own telemetry override prevents user-config reads and background
	// telemetry children racing TempDir cleanup, including during go env.
	if err := os.WriteFile(filepath.Join(telemetry, "mode"), []byte("off\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var env []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		if !strings.HasPrefix(key, "GO") && !strings.HasPrefix(key, "CGO_") {
			env = append(env, entry)
		}
	}
	env = append(env, "GOENV=off", "GO111MODULE=on", "GOWORK=off", "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off", "CGO_ENABLED=0", "TEST_TELEMETRY_DIR="+telemetry)
	query := exec.CommandContext(t.Context(), tool, "env", "-json", "GOCACHE", "GOMODCACHE")
	query.Env = append([]string{}, env...)
	// Resolve defaults before replacing HOME. GOPATH only participates in this
	// query; only the two reusable cache paths cross the compiler boundary.
	for _, key := range []string{"GOCACHE", "GOMODCACHE", "GOPATH"} {
		if value, ok := os.LookupEnv(key); ok {
			query.Env = append(query.Env, key+"="+value)
		}
	}
	out, err := query.Output()
	if err != nil {
		t.Fatalf("resolve Go compiler caches: %v", err)
	}
	var caches map[string]string
	if err := json.Unmarshal(out, &caches); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"GOCACHE", "GOMODCACHE"} {
		if !filepath.IsAbs(caches[key]) {
			t.Fatalf("Go returned a non-absolute %s: %q", key, caches[key])
		}
		env = append(env, key+"="+caches[key])
	}
	return tool, append(env, testConfigEnv(root)...)
}

func TestCompilerCacheAndConfigBoundary(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		name := "default caches"
		if explicit {
			name = "explicit caches"
		}
		t.Run(name, func(t *testing.T) {
			inherited := seedInheritedConfig(t)
			sentinels := configSnapshot(t, inherited)
			for _, key := range []string{"GOCACHE", "GOMODCACHE", "GOPATH"} {
				t.Setenv(key, "")
				if err := os.Unsetenv(key); err != nil {
					t.Fatal(err)
				}
			}
			for _, key := range []string{"XDG_CACHE_HOME", "LocalAppData", "LOCALAPPDATA"} {
				t.Setenv(key, filepath.Join(inherited, "cache"))
			}
			if explicit {
				t.Setenv("GOCACHE", filepath.Join(t.TempDir(), "build-cache"))
				t.Setenv("GOMODCACHE", filepath.Join(t.TempDir(), "module-cache"))
			}
			telemetry := t.TempDir()
			if err := os.WriteFile(filepath.Join(telemetry, "mode"), []byte("off\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			// Ask Go independently under the original synthetic home, before
			// poisoning flags or applying the compiler helper's isolation.
			baseline := exec.CommandContext(t.Context(), testGoTool(t), "env", "-json", "GOCACHE", "GOMODCACHE")
			baseline.Env = append(os.Environ(), "GOENV=off", "GOWORK=off", "GOFLAGS=", "GOEXPERIMENT=", "GOTOOLCHAIN=local", "TEST_TELEMETRY_DIR="+telemetry)
			out, err := baseline.Output()
			if err != nil {
				t.Fatal(err)
			}
			var want map[string]string
			if err := json.Unmarshal(out, &want); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"GOFLAGS", "GOEXPERIMENT", "GOWORK", "GOTOOLCHAIN"} {
				t.Setenv(key, "invalid-inherited-setting")
			}
			source := filepath.Join(t.TempDir(), "probe.go")
			if err := os.WriteFile(source, []byte(`package main
import ("fmt"; "os"; "runtime")
func main() {
    dir, err := os.UserConfigDir()
    if err != nil { panic(err) }
    fmt.Printf("%s\n%s\n%s\n%s\n", os.Getenv("GOCACHE"), os.Getenv("GOMODCACHE"), dir, runtime.Version())
}
`), 0o600); err != nil {
				t.Fatal(err)
			}
			var previousConfig, previousExport string
			for build := range 2 {
				tool, env := testCompiler(t)
				binary := filepath.Join(t.TempDir(), executableName("probe"))
				cmd := exec.CommandContext(t.Context(), tool, "build", "-o", binary, source)
				cmd.Env = env
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("offline probe build: %v\n%s", err, out)
				}
				probe := exec.CommandContext(t.Context(), binary)
				probe.Env = env
				out, err := probe.Output()
				if err != nil {
					t.Fatal(err)
				}
				got := strings.Split(strings.TrimSpace(string(out)), "\n")
				if len(got) != 4 || got[0] != want["GOCACHE"] || got[1] != want["GOMODCACHE"] || got[3] != runtime.Version() {
					t.Fatalf("compiled probe environment/toolchain: %q; want caches %v and %s", out, want, runtime.Version())
				}
				if relative, err := filepath.Rel(inherited, got[2]); err != nil || filepath.IsLocal(relative) || got[2] == previousConfig {
					t.Fatalf("compiler config was not independently isolated: %q", got[2])
				}
				previousConfig = got[2]
				// Inspect a real compiler export artifact, not just returned env values.
				export := exec.CommandContext(t.Context(), tool, "list", "-export", "-f", "{{.Export}}", "fmt")
				export.Env = env
				out, err = export.Output()
				if err != nil {
					t.Fatal(err)
				}
				artifact := strings.TrimSpace(string(out))
				if relative, err := filepath.Rel(want["GOCACHE"], artifact); err != nil || !filepath.IsLocal(relative) {
					t.Fatalf("export artifact escaped the selected cache: %q", artifact)
				}
				if _, err := os.Stat(artifact); err != nil {
					t.Fatal(err)
				}
				if build > 0 && artifact != previousExport {
					t.Fatalf("compiler did not reuse the export artifact: %q != %q", artifact, previousExport)
				}
				previousExport = artifact
				t.Logf("build %d: caches=%v, config=%s, export=%s, toolchain=%s", build, want, got[2], artifact, got[3])
			}
			for path, before := range sentinels {
				if filepath.Base(path) != "auth.json" {
					continue
				}
				if data, err := os.ReadFile(path); err != nil || string(data) != before {
					t.Errorf("compiler changed inherited auth sentinel: %s (%v)", path, err)
				}
			}
		})
	}
}
