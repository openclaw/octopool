package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

func writeLocalUserLogin(ctx context.Context, request ghAPIRequest, stdout io.Writer) (bool, error) {
	if request.path != "/user" || request.method != "GET" || request.jq != ".login" ||
		request.paginate || request.slurp || len(request.query) != 0 || len(request.headers) != 0 ||
		strings.TrimSpace(os.Getenv("OCTOPOOL_TOKEN")) != "" {
		return false, nil
	}
	auth, err := loadAuth()
	if err != nil || auth.Token == "" || strings.TrimSpace(auth.Login) == "" {
		return false, nil
	}
	baseURL := envDefault("OCTOPOOL_URL", auth.URL)
	if err := validateAuthURLForRequest(auth, baseURL, "OCTOPOOL_TOKEN"); err != nil {
		return false, nil
	}
	pool := firstNonEmpty(auth.Pool, "maintainers")
	response, err := getJSONRaw(ctx, apiURL(baseURL, "/v1/pools/"+urlPath(pool)+"/health"), auth.Token)
	if err != nil {
		return false, nil
	}
	_ = response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false, nil
	}
	_, err = fmt.Fprintln(stdout, auth.Login)
	return true, err
}
