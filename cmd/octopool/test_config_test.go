package main

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func isolateTestConfig(t *testing.T) {
	t.Helper()
	for _, entry := range testConfigEnv(t.TempDir()) {
		name, value, _ := strings.Cut(entry, "=")
		t.Setenv(name, value)
	}
}

func testConfigEnv(root string) []string {
	var env []string
	for _, name := range []string{"HOME", "XDG_CONFIG_HOME", "AppData", "APPDATA", "USERPROFILE", "GH_CONFIG_DIR", "ZDOTDIR", "XDG_DATA_HOME"} {
		// Windows environment keys are case insensitive; both spellings must agree.
		env = append(env, name+"="+filepath.Join(root, strings.ToLower(name)))
	}
	return env
}

// Exercise the existing tests in a child: their own isolation must protect the
// inherited stores, even when the platform prefers XDG_CONFIG_HOME or AppData.
func TestAuthTestsPreserveInheritedConfig(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"TestCommandHelp",
		"TestWhoamiPrintsSavedLogin",
		"TestWhoamiJSON",
		"TestNewGHRelayClientMissingLoginUsesFallbackSentinel",
		"TestWriteLocalUserLogin",
		"TestWriteLocalUserLoginRejectsOverridesAndBroaderShapes",
		"TestLoginAcceptsPositionalServerAndStoresDiscoveredAuth",
		"TestLoginCompoundClientWhoamiAndStats",
		"TestLoginRedirects",
		"TestCallerRequestFlagsAuthSnapshot",
		"TestStringRewriteSavedURLBinding",
	} {
		t.Run(name, func(t *testing.T) {
			inherited := seedInheritedConfig(t)
			before := configSnapshot(t, inherited)
			cmd := exec.CommandContext(t.Context(), executable, "-test.run=^"+name+"$", "-test.v", "-test.count=1")
			cmd.Env = os.Environ()
			if name == "TestLoginCompoundClientWhoamiAndStats" {
				cmd.Env = append(cmd.Env,
					"OCTOPOOL_TOKEN=synthetic-inherited-caller",
					"OCTOPOOL_URL=http://127.0.0.1:1",
					"OCTOPOOL_POOL=synthetic-inherited-pool",
				)
			}
			out, err := cmd.CombinedOutput()
			// Check preservation even if the child fails before completing a write.
			if after := configSnapshot(t, inherited); !reflect.DeepEqual(after, before) {
				t.Error("child changed inherited config outside its temporary directory")
			}
			if err != nil || !strings.Contains(string(out), "--- PASS: "+name+" (") {
				t.Fatalf("child test did not pass: %v\n%s", err, out)
			}
			if !t.Failed() {
				t.Log("child passed; inherited config sentinels unchanged")
			}
		})
	}
}

func TestCLIConfigIsolation(t *testing.T) {
	bin := buildCLIBinary(t)
	for _, args := range [][]string{{"whoami", "--json"}, {"login", "http://unsafe.example.test"}} {
		t.Run(args[0], func(t *testing.T) {
			inherited := seedInheritedConfig(t)
			before := configSnapshot(t, inherited)
			result := runCLI(t, bin, "", nil, args...)
			if after := configSnapshot(t, inherited); !reflect.DeepEqual(after, before) {
				t.Error("CLI child changed inherited config")
			}
			want := "not logged in"
			if args[0] == "login" {
				want = "HTTPS"
			}
			if result.err == nil || result.stdout != "" || !strings.Contains(result.stderr, want) {
				t.Fatalf("expected isolated CLI failure (%s), got err=%v stdout=%q stderr=%q", want, result.err, result.stdout, result.stderr)
			}
		})
	}
}

func seedInheritedConfig(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	// This fixture deliberately does not use the isolation helper under test.
	for _, name := range []string{"HOME", "XDG_CONFIG_HOME", "AppData", "APPDATA", "USERPROFILE", "GH_CONFIG_DIR"} {
		dir := filepath.Join(root, strings.ToLower(name))
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv(name, dir)
	}
	for _, name := range []string{"OCTOPOOL_TOKEN", "OCTOPOOL_URL", "OCTOPOOL_POOL", "OCTOPOOL_STRING_REWRITE_FILE", "OCTOPOOL_ALLOW_INSECURE_LOGIN", "GH_TOKEN", "GITHUB_TOKEN"} {
		t.Setenv(name, "")
	}
	// Resolve the real platform path only after every candidate root is synthetic.
	dir, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	for _, configDir := range []string{dir, os.Getenv("XDG_CONFIG_HOME"), os.Getenv("AppData"), os.Getenv("GH_CONFIG_DIR")} {
		auth := filepath.Join(configDir, "octopool", "auth.json")
		if err := os.MkdirAll(filepath.Dir(auth), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(auth, []byte(`{"url":"https://sentinel.invalid","pool":"sentinel","token":"synthetic-sentinel","login":"sentinel"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func configSnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			files[path] = "directory"
			return nil
		}
		data, err := os.ReadFile(path)
		files[path] = string(data)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return files
}
