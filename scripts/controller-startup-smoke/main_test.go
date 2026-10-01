package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOutputIsBoundedAndOverflowCancels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &boundedOutput{cancel: cancel}
	if n, err := output.Write(bytes.Repeat([]byte("x"), outputLimit)); n != outputLimit || err != nil {
		t.Fatal("exact-limit write failed")
	}
	if output.overflow || ctx.Err() != nil {
		t.Fatal("exact-limit output should not cancel")
	}
	if n, err := output.Write([]byte("overflow")); n != 8 || err != nil {
		t.Fatal("overflow write was not drained")
	}
	if output.data.Len() != outputLimit || !output.overflow || ctx.Err() != context.Canceled {
		t.Fatal("overflow must cancel and retain only the configured limit")
	}
	output.Write(bytes.Repeat([]byte("y"), outputLimit*2))
	if output.data.Len() != outputLimit {
		t.Fatal("continued output grew retained data")
	}
}

func TestOrdinaryErrorAloneIsNotAControllerPass(t *testing.T) {
	// This local diagnostic binary is not the controller. Its exit 1 alone must
	// not pass without the required startup diagnostics and fixture requests.
	const binary = "/usr/bin/false"
	if _, err := os.Stat(binary); err != nil {
		t.Fatal("required local negative-control binary is unavailable")
	}
	result := runCase(binary, "existing_user_lookup")
	if result.Passed || result.ExitCode != 1 || result.Requests != (counts{}) {
		t.Fatal("negative-control process incorrectly passed")
	}
	for _, expected := range []string{
		"expected_database_parse_diagnostic",
		"expected_service_identity_bootstrap",
		"request_counts_mismatch",
	} {
		assertFailure(t, result, expected)
	}
}

func fakeControllerCase(t *testing.T, name, mode string, deadline time.Duration) caseResult {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal("locate the owned test executable")
	}
	return runCaseWithDeadline(binary, name, deadline,
		"-test.run=^TestControllerHelperProcess$", "--", "controller-fixture", mode)
}

func assertFailure(t *testing.T, result caseResult, expected string) {
	t.Helper()
	if result.Passed {
		t.Fatal("negative control incorrectly passed")
	}
	for _, failure := range result.Failures {
		if failure == expected {
			return
		}
	}
	t.Fatalf("missing failure %q in %v", expected, result.Failures)
}

func TestAllStartupCasesRequireCorrectRequestsAndIsolatedEnvironment(t *testing.T) {
	// The helper refuses inherited variables as well as checking every expected
	// inert value. Its successful requests therefore also prove env replacement.
	t.Setenv("INSTAFY_SMOKE_AMBIENT_SENTINEL", "must-not-reach-owned-child")
	for _, item := range []struct {
		name string
		want counts
	}{
		{"existing_user_lookup", counts{JWKS: 1, Lookup: 1}},
		{"missing_user_creation", counts{JWKS: 1, Lookup: 1, Create: 1}},
		{"explicit_uuid_bypass", counts{JWKS: 1}},
	} {
		t.Run(item.name, func(t *testing.T) {
			result := fakeControllerCase(t, item.name, "pass", 5*time.Second)
			if !result.Passed || result.ExitCode != 1 || result.Requests != item.want || len(result.Failures) != 0 {
				t.Fatalf("valid fake controller was rejected: %+v", result)
			}
		})
	}
}

func TestStartupFailureControls(t *testing.T) {
	for _, item := range []struct {
		mode    string
		name    string
		failure string
	}{
		{"credential-echo", "existing_user_lookup", "inert_credential_echoed"},
		{"wrong-counts", "existing_user_lookup", "request_counts_mismatch"},
		{"bad-header", "existing_user_lookup", "admin_credentials_mismatch"},
		{"bad-create-payload", "missing_user_creation", "create_payload_mismatch"},
		{"bad-lookup-query", "existing_user_lookup", "lookup_email_mismatch"},
		{"unexpected-path", "existing_user_lookup", "unexpected_request_path"},
		{"exit-zero", "existing_user_lookup", "expected_normal_error_exit_1"},
		{"panic", "existing_user_lookup", "controller_panicked"},
		{"missing-diagnostic", "existing_user_lookup", "expected_database_parse_diagnostic"},
		{"missing-identity", "existing_user_lookup", "expected_service_identity_bootstrap"},
		{"unexpected-bootstrap", "explicit_uuid_bypass", "explicit_identity_did_not_bypass_bootstrap"},
		{"output-overflow", "existing_user_lookup", "controller_output_limit_exceeded"},
	} {
		t.Run(item.mode, func(t *testing.T) {
			result := fakeControllerCase(t, item.name, item.mode, 5*time.Second)
			assertFailure(t, result, item.failure)
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal("encode bounded result")
			}
			for _, value := range []string{serviceKey, servicePassword, jwtSecret} {
				if bytes.Contains(encoded, []byte(value)) {
					t.Fatal("result retained child credential output")
				}
			}
		})
	}
}

func TestStartupTimeoutKillsAndReapsOwnedChild(t *testing.T) {
	started := time.Now()
	result := fakeControllerCase(t, "existing_user_lookup", "timeout", 100*time.Millisecond)
	assertFailure(t, result, "controller_timeout")
	if result.ExitCode != -1 || time.Since(started) > 3*time.Second {
		t.Fatal("deadline did not promptly kill and reap owned child")
	}
}

func TestMissingExecutableFailsClosed(t *testing.T) {
	result := runCase(filepath.Join(t.TempDir(), "not-created"), "existing_user_lookup")
	assertFailure(t, result, "controller_spawn_failed")
}

// The test executable is its own fake controller, avoiding shell scripts,
// downloaded programs or a second build. Only a test-owned subprocess receives
// these arguments; production smoke execution cannot select this code.
func TestControllerHelperProcess(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "controller-fixture" {
		return
	}
	os.Exit(imitateController(os.Args[len(os.Args)-1]))
}

func imitateController(mode string) int {
	allowed := map[string]bool{
		"HOME": true, "TMPDIR": true, "WORKSPACE_ROOT": true, "DATABASE_URL": true,
		"SUPABASE_PROJECT_URL": true, "SUPABASE_JWT_SECRET": true,
		"SUPABASE_SERVICE_ROLE_KEY": true, "SERVICE_RUNTIME_USER_EMAIL": true,
		"SERVICE_RUNTIME_USER_PASSWORD": true, "SERVICE_RUNTIME_USER_ID": true,
		"MANAGED_AI_ENABLED": true, "MANAGED_AI_STARTUP_CHECK": true, "RUST_LOG": true,
	}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if !allowed[name] {
			return 90
		}
	}
	directory, err := os.Getwd()
	if err != nil {
		return 90
	}
	// macOS canonicalizes /tmp in Getwd; resolve only this private fixture path.
	home, err := filepath.EvalSymlinks(os.Getenv("HOME"))
	if err != nil || directory != home || os.Getenv("HOME") != os.Getenv("TMPDIR") ||
		os.Getenv("WORKSPACE_ROOT") != filepath.Join(os.Getenv("HOME"), "workspaces") ||
		os.Getenv("DATABASE_URL") != "not-a-database-connection" ||
		os.Getenv("SUPABASE_SERVICE_ROLE_KEY") != serviceKey ||
		os.Getenv("SUPABASE_JWT_SECRET") != jwtSecret ||
		strings.ToLower(strings.TrimSpace(os.Getenv("SERVICE_RUNTIME_USER_EMAIL"))) != serviceEmail ||
		os.Getenv("MANAGED_AI_ENABLED") != "false" || os.Getenv("MANAGED_AI_STARTUP_CHECK") != "false" {
		return 90
	}
	baseURL := os.Getenv("SUPABASE_PROJECT_URL")
	if !strings.HasPrefix(baseURL, "http://127.0.0.1:") {
		return 90
	}
	if mode == "timeout" {
		time.Sleep(10 * time.Second)
		return 91
	}
	if mode == "output-overflow" {
		for {
			if _, err := os.Stdout.Write(bytes.Repeat([]byte("x"), 4096)); err != nil {
				return 91
			}
		}
	}
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	request := func(method, path string, body io.Reader, admin bool) bool {
		req, err := http.NewRequest(method, baseURL+path, body)
		if err != nil {
			return false
		}
		if admin {
			req.Header.Set("apikey", serviceKey)
			req.Header.Set("authorization", "Bearer "+serviceKey)
			if mode == "bad-header" {
				req.Header.Del("apikey")
			}
		}
		response, err := client.Do(req)
		if err != nil {
			return false
		}
		defer response.Body.Close()
		_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 8192))
		return err == nil
	}
	if !request(http.MethodGet, jwksPath, nil, false) {
		return 92
	}
	if mode == "wrong-counts" && !request(http.MethodGet, jwksPath, nil, false) {
		return 92
	}
	if mode == "unexpected-path" && !request(http.MethodGet, "/not-a-fixture", nil, false) {
		return 92
	}
	if os.Getenv("SERVICE_RUNTIME_USER_ID") == "" {
		query := "?email=" + serviceEmail
		if mode == "bad-lookup-query" {
			query += "&unexpected=true"
		}
		if !request(http.MethodGet, adminPath+query, nil, true) {
			return 92
		}
		if password := os.Getenv("SERVICE_RUNTIME_USER_PASSWORD"); password != "" {
			payload := map[string]any{
				"email": serviceEmail, "password": strings.TrimSpace(password), "email_confirm": true,
			}
			if mode == "bad-create-payload" {
				payload["unexpected"] = true
			}
			body, _ := json.Marshal(payload)
			if !request(http.MethodPost, adminPath, bytes.NewReader(body), true) {
				return 92
			}
		}
		if mode != "missing-identity" {
			fmt.Println("bootstrapped SERVICE_RUNTIME_USER_ID via Supabase admin API", serviceID)
		}
	} else if mode == "unexpected-bootstrap" {
		fmt.Println("bootstrapped SERVICE_RUNTIME_USER_ID via Supabase admin API", serviceID)
	}
	if mode != "missing-diagnostic" {
		fmt.Fprintln(os.Stderr, "Error: failed to parse DATABASE_URL")
	}
	if mode == "credential-echo" {
		fmt.Println(serviceKey, servicePassword, jwtSecret)
	}
	if mode == "panic" {
		fmt.Fprintln(os.Stderr, "panicked at Cannot drop a runtime")
		return 101
	}
	if mode == "exit-zero" {
		return 0
	}
	return 1
}
