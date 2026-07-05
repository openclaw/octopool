package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type authFile struct {
	URL       string    `json:"url"`
	Pool      string    `json:"pool"`
	Token     string    `json:"token"`
	Login     string    `json:"login,omitempty"`
	Client    string    `json:"client,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func loadAuth() (authFile, error) {
	path, err := authPath()
	if err != nil {
		return authFile{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return authFile{}, nil
	}
	if err != nil {
		return authFile{}, err
	}
	var auth authFile
	if err := json.Unmarshal(data, &auth); err != nil {
		return authFile{}, err
	}
	return auth, nil
}

func saveAuth(auth authFile) error {
	path, err := authPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(auth, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func authPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "octopool", "auth.json"), nil
}
