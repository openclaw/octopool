package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
)

const defaultURL = "https://octopool.dev"

func envDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is not set", name)
	}
	return value, nil
}

func callerToken(envName string) (string, error) {
	if value := strings.TrimSpace(os.Getenv(envName)); value != "" {
		return value, nil
	}
	auth, err := loadAuth()
	if err != nil {
		return "", err
	}
	if auth.Token == "" {
		return "", errors.New("not logged in; run: octopool login")
	}
	return auth.Token, nil
}

func defaultAuthURL(auth authFile) string {
	return envDefault("OCTOPOOL_URL", firstNonEmpty(auth.URL, defaultURL))
}

func defaultAuthPool(auth authFile) string {
	return envDefault("OCTOPOOL_POOL", firstNonEmpty(auth.Pool, "maintainers"))
}

type callerRequestFlags struct {
	baseURL  *string
	pool     *string
	tokenEnv *string
}

func newCallerRequestFlags(fs *flag.FlagSet) callerRequestFlags {
	return callerRequestFlags{
		baseURL:  fs.String("url", defaultAuthURL(authFile{}), "Octopool base URL"),
		pool:     fs.String("pool", defaultAuthPool(authFile{}), "pool id"),
		tokenEnv: fs.String("token-env", "OCTOPOOL_TOKEN", "caller token env var"),
	}
}

func (flags callerRequestFlags) applyAuth(fs *flag.FlagSet) (authFile, error) {
	auth, err := loadAuth()
	if err != nil {
		return authFile{}, err
	}
	set := map[string]bool{}
	fs.Visit(func(item *flag.Flag) {
		set[item.Name] = true
	})
	if !set["url"] {
		*flags.baseURL = defaultAuthURL(auth)
	}
	if !set["pool"] {
		*flags.pool = defaultAuthPool(auth)
	}
	return auth, nil
}

func (flags callerRequestFlags) authorize(auth authFile) (string, error) {
	if err := validateAuthURLForRequest(auth, *flags.baseURL, *flags.tokenEnv); err != nil {
		return "", err
	}
	return callerToken(*flags.tokenEnv)
}

func validateAuthURLForRequest(auth authFile, effectiveURL string, tokenEnvName string) error {
	if strings.TrimSpace(os.Getenv(tokenEnvName)) != "" {
		return nil
	}
	effective := strings.TrimRight(strings.TrimSpace(firstNonEmpty(effectiveURL, defaultURL)), "/")
	stored := strings.TrimRight(strings.TrimSpace(firstNonEmpty(auth.URL, defaultURL)), "/")
	if effective != stored {
		return fmt.Errorf("URL override requires %s or a fresh octopool login for that URL", tokenEnvName)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func urlPath(value string) string {
	return strings.ReplaceAll(value, "/", "%2F")
}

func apiURL(base string, path string) string {
	return strings.TrimRight(base, "/") + path
}
