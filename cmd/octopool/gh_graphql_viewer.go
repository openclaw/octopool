package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"go.yaml.in/yaml/v3"
)

type graphQLLocalViewer struct {
	key   string
	keys  []string
	login string
}

var graphQLViewerLogin = regexp.MustCompile(`^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$`)

func nativeGraphQLViewerLogin() (string, bool) {
	// A saved Octopool login proves viewer only when native gh selects that same account.
	for _, name := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if _, present := os.LookupEnv(name); present {
			return "", false
		}
	}
	if os.Getenv("OCTOPOOL_TOKEN") != "" {
		return "", false
	}
	auth, err := loadAuth()
	if err != nil || auth.Token == "" || validateAuthURLForRequest(auth, envDefault("OCTOPOOL_URL", auth.URL), "OCTOPOOL_TOKEN") != nil {
		return "", false
	}
	dir := os.Getenv("GH_CONFIG_DIR")
	if dir == "" {
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			dir = filepath.Join(xdg, "gh")
		} else if appData := os.Getenv("AppData"); runtime.GOOS == "windows" && appData != "" {
			dir = filepath.Join(appData, "GitHub CLI")
		} else {
			home, err := os.UserHomeDir()
			if err != nil || home == "" {
				return "", false
			}
			dir = filepath.Join(home, ".config", "gh")
		}
	}
	file, err := os.Open(filepath.Join(dir, "hosts.yml"))
	if err != nil {
		return "", false
	}
	defer file.Close()
	const maxConfigBytes = 1 << 20
	raw, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil || len(raw) > maxConfigBytes {
		return "", false
	}
	login, ok := graphQLViewerConfigLogin(raw)
	return login, ok && login == auth.Login
}

func graphQLViewerConfigLogin(raw []byte) (string, bool) {
	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	var document, extra yaml.Node
	if decoder.Decode(&document) != nil || decoder.Decode(&extra) != io.EOF || len(document.Content) != 1 || !unambiguousGHConfig(document.Content[0], 0) {
		return "", false
	}
	field := func(node *yaml.Node, key string) *yaml.Node {
		if node != nil && node.Kind == yaml.MappingNode {
			for i := 0; i < len(node.Content); i += 2 {
				if node.Content[i].Value == key {
					return node.Content[i+1]
				}
			}
		}
		return nil
	}
	host := field(document.Content[0], "github.com")
	user := field(host, "user")
	if user == nil || user.Kind != yaml.ScalarNode || user.Tag != "!!str" || len(user.Value) > 39 || !graphQLViewerLogin.MatchString(user.Value) {
		return "", false
	}
	if users := field(host, "users"); users != nil {
		account := field(users, user.Value)
		if account == nil || (account.Kind != yaml.MappingNode && account.Tag != "!!null") {
			return "", false
		}
	}
	return user.Value, true
}

func unambiguousGHConfig(node *yaml.Node, depth int) bool {
	if depth > 12 || node.Anchor != "" {
		return false
	}
	switch node.Kind {
	case yaml.ScalarNode:
		return node.Tag == "!!str" || node.Tag == "!!null"
	case yaml.MappingNode:
		seen := map[string]bool{}
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || seen[key.Value] || !unambiguousGHConfig(node.Content[i+1], depth+1) {
				return false
			}
			seen[key.Value] = true
		}
		return node.Tag == "!!map"
	default:
		return false
	}
}

func spliceGraphQLViewer(raw []byte, viewer *graphQLLocalViewer) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("invalid GraphQL response")
	}
	seen := map[string]bool{}
	start, end := int64(0), int64(0)
	var data json.RawMessage
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return nil, errors.New("ambiguous GraphQL response")
		}
		seen[key] = true
		before := decoder.InputOffset()
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		if key == "data" {
			start, end, data = before, decoder.InputOffset(), value
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if decoder.Decode(new(json.RawMessage)) != io.EOF {
		return nil, errors.New("invalid GraphQL response suffix")
	}
	if data == nil || rawJSONIsNull(data) {
		return raw, nil
	}
	var values map[string]json.RawMessage
	if json.Unmarshal(data, &values) != nil || values == nil {
		return nil, errors.New("invalid GraphQL data")
	}
	if _, exists := values[viewer.key]; exists {
		return nil, errors.New("unexpected GraphQL viewer")
	}
	login, _ := json.Marshal(viewer.login)
	values[viewer.key] = json.RawMessage(`{"login":` + string(login) + `}`)
	var out bytes.Buffer
	out.Write(raw[:start])
	out.WriteString(":{")
	first := true
	for _, key := range viewer.keys {
		value, present := values[key]
		if !present {
			continue
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		encoded, _ := json.Marshal(key)
		out.Write(encoded)
		out.WriteByte(':')
		out.Write(value)
		delete(values, key)
	}
	if len(values) != 0 {
		return nil, errors.New("unexpected GraphQL data fields")
	}
	out.WriteByte('}')
	out.Write(raw[end:])
	return out.Bytes(), nil
}
