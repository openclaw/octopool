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
	// Concurrent gh invocations read this file; replace it atomically so a
	// reader never sees a truncated token (which silently falls back to gh).
	temp, err := os.CreateTemp(filepath.Dir(path), ".auth-*.json")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func authPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "octopool", "auth.json"), nil
}
