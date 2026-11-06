// Isolated smoke for an exact published controller binary. This intentionally
// stops at database URL parsing: it is not a healthy database lifecycle test.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	serviceID       = "00000000-0000-4000-8000-000000000001"
	serviceEmail    = "controller-startup@example.test"
	serviceKey      = "inert-startup-service-role"
	servicePassword = "inert-startup-password-override"
	jwtSecret       = "inert-startup-hmac-fallback"
	adminPath       = "/auth/v1/admin/users"
	jwksPath        = "/auth/v1/.well-known/jwks.json"
	outputLimit     = 32 * 1024
)

type counts struct {
	JWKS   int `json:"jwks"`
	Lookup int `json:"lookup"`
	Create int `json:"create"`
}

type caseResult struct {
	Name       string   `json:"name"`
	Passed     bool     `json:"passed"`
	ExitCode   int      `json:"exitCode"`
	DurationMS int64    `json:"durationMs"`
	Requests   counts   `json:"requests"`
	Failures   []string `json:"failures,omitempty"`
}

type report struct {
	SchemaVersion int          `json:"schemaVersion"`
	Passed        bool         `json:"passed"`
	Scope         string       `json:"scope"`
	Cases         []caseResult `json:"cases"`
	Failure       string       `json:"failure,omitempty"`
}

// This writer drains both child streams but retains at most outputLimit bytes.
// Any overflow immediately cancels the owned child; no child bytes are printed.
type boundedOutput struct {
	mu       sync.Mutex
	data     bytes.Buffer
	overflow bool
	cancel   context.CancelFunc
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := outputLimit - b.data.Len()
	if len(p) > remaining {
		b.data.Write(p[:remaining])
		b.overflow = true
		b.cancel()
	} else {
		b.data.Write(p)
	}
	return len(p), nil
}

func runCase(binary, name string) caseResult {
	return runCaseWithDeadline(binary, name, 15*time.Second)
}

// Tests use a shorter deadline and their own fake executable subprocess. Neither
// the deadline nor extra arguments can be configured through the production CLI.
func runCaseWithDeadline(binary, name string, deadline time.Duration, arguments ...string) (result caseResult) {
	started := time.Now()
	result = caseResult{Name: name, ExitCode: -1}
	defer func() { result.DurationMS = time.Since(started).Milliseconds() }()
	fail := func(code string) { result.Failures = append(result.Failures, code) }
	directory, err := os.MkdirTemp("/tmp", "instafy-controller-startup-")
	if err != nil {
		fail("temporary_directory_failed")
		return
	}
	defer os.RemoveAll(directory) // Only this successfully created private fixture.

	var requestMu sync.Mutex
	var requestCounts counts
	var requestFailures []string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestMu.Lock()
		defer requestMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		bad := func(code string) {
			if len(requestFailures) < 8 {
				requestFailures = append(requestFailures, code)
			}
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{ "error": "inert fixture mismatch" }`)
		}
		if r.URL.Path == jwksPath && r.Method == http.MethodGet {
			requestCounts.JWKS++
			if r.URL.RawQuery != "" {
				bad("jwks_query_unexpected")
				return
			}
			io.WriteString(w, `{ "keys": [] }`)
			return
		}
		if r.URL.Path != adminPath {
			bad("unexpected_request_path")
			return
		}
		if r.Header.Get("apikey") != serviceKey || r.Header.Get("authorization") != "Bearer "+serviceKey {
			bad("admin_credentials_mismatch")
			return
		}
		switch r.Method {
		case http.MethodGet:
			requestCounts.Lookup++
			query := r.URL.Query()
			if len(query) != 1 || len(query["email"]) != 1 || query.Get("email") != serviceEmail {
				bad("lookup_email_mismatch")
				return
			}
			if name == "missing_user_creation" {
				io.WriteString(w, `{ "users": [] }`)
			} else {
				io.WriteString(w, `{ "users": [{ "id": "`+serviceID+`" }] }`)
			}
		case http.MethodPost:
			requestCounts.Create++
			if name != "missing_user_creation" || r.URL.RawQuery != "" {
				bad("unexpected_user_creation")
				return
			}
			var body struct {
				Email        string `json:"email"`
				Password     string `json:"password"`
				EmailConfirm bool   `json:"email_confirm"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&body) != nil || body.Email != serviceEmail || body.Password != servicePassword || !body.EmailConfirm {
				bad("create_payload_mismatch")
				return
			}
			if decoder.Decode(new(any)) != io.EOF {
				bad("create_payload_trailing_data")
				return
			}
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, `{ "id": "`+serviceID+`" }`)
		default:
			bad("unexpected_request_method")
		}
	})
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		fail("loopback_listener_failed")
		return
	}
	server := &http.Server{
		Handler: handler, ReadHeaderTimeout: time.Second, ReadTimeout: 2 * time.Second,
		WriteTimeout: 2 * time.Second, MaxHeaderBytes: 8192,
		ErrorLog: log.New(io.Discard, "", 0),
	}
	defer server.Close()
	go server.Serve(listener)

	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	defer cancel()
	output := &boundedOutput{cancel: cancel}
	command := exec.CommandContext(ctx, binary, arguments...)
	command.Dir = directory
	command.Env = []string{
		"HOME=" + directory,
		"TMPDIR=" + directory,
		"WORKSPACE_ROOT=" + filepath.Join(directory, "workspaces"),
		"DATABASE_URL=not-a-database-connection",
		"SUPABASE_PROJECT_URL=http://" + listener.Addr().String(),
		"SUPABASE_JWT_SECRET=" + jwtSecret,
		"SUPABASE_SERVICE_ROLE_KEY=" + serviceKey,
		"SERVICE_RUNTIME_USER_EMAIL=  CONTROLLER-STARTUP@EXAMPLE.TEST  ",
		"MANAGED_AI_ENABLED=false",
		"MANAGED_AI_STARTUP_CHECK=false",
		"RUST_LOG=info",
	}
	if name == "missing_user_creation" {
		command.Env = append(command.Env, "SERVICE_RUNTIME_USER_PASSWORD=  "+servicePassword+"  ")
	}
	if name == "explicit_uuid_bypass" {
		command.Env = append(command.Env, "SERVICE_RUNTIME_USER_ID=  "+serviceID+"  ")
	}
	command.Stdout, command.Stderr = output, output
	command.Stdin = nil // exec provides the null device, not inherited input.
	command.WaitDelay = time.Second
	if err := command.Start(); err != nil {
		fail("controller_spawn_failed")
		return
	}
	reaped := false
	defer func() {
		if !reaped {
			command.Process.Kill() // Exact owned child; never a discovered PID/group.
			command.Wait()
		}
	}()
	runError := command.Wait() // CommandContext kills at deadline; Wait reaps it.
	reaped = true
	if command.ProcessState != nil {
		result.ExitCode = command.ProcessState.ExitCode()
	}
	if ctx.Err() == context.DeadlineExceeded {
		fail("controller_timeout")
	}
	if result.ExitCode != 1 || runError == nil {
		fail("expected_normal_error_exit_1")
	}
	if _, ok := runError.(*exec.ExitError); !ok {
		fail("expected_process_exit_error")
	}
	output.mu.Lock()
	text, overflow := output.data.String(), output.overflow
	output.mu.Unlock()
	if overflow {
		fail("controller_output_limit_exceeded")
	}
	if !strings.Contains(text, "failed to parse DATABASE_URL") {
		fail("expected_database_parse_diagnostic")
	}
	if strings.Contains(text, "panicked at") || strings.Contains(text, "Cannot drop a runtime") {
		fail("controller_panicked")
	}
	for _, value := range []string{serviceKey, servicePassword, jwtSecret} {
		if strings.Contains(text, value) {
			fail("inert_credential_echoed")
			break
		}
	}
	if name == "explicit_uuid_bypass" {
		if strings.Contains(text, "bootstrapped SERVICE_RUNTIME_USER_ID") || strings.Contains(text, "failed to bootstrap SERVICE_RUNTIME_USER_ID") {
			fail("explicit_identity_did_not_bypass_bootstrap")
		}
	} else if !strings.Contains(text, "bootstrapped SERVICE_RUNTIME_USER_ID via Supabase admin API") || !strings.Contains(text, serviceID) {
		fail("expected_service_identity_bootstrap")
	}
	server.Close()
	requestMu.Lock()
	result.Requests = requestCounts
	result.Failures = append(result.Failures, requestFailures...)
	requestMu.Unlock()
	expected := counts{JWKS: 1, Lookup: 1}
	if name == "missing_user_creation" {
		expected.Create = 1
	}
	if name == "explicit_uuid_bypass" {
		expected.Lookup = 0
	}
	if result.Requests != expected {
		fail("request_counts_mismatch")
	}
	result.Passed = len(result.Failures) == 0
	return
}

func main() {
	result := report{SchemaVersion: 1, Passed: true, Scope: "isolated_controller_startup_before_database_io", Cases: []caseResult{}}
	if len(os.Args) != 2 || !filepath.IsAbs(os.Args[1]) {
		result.Passed, result.Failure = false, "one_absolute_controller_binary_path_required"
	} else if info, err := os.Stat(os.Args[1]); err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		result.Passed, result.Failure = false, "controller_binary_not_executable"
	} else {
		for _, name := range []string{"existing_user_lookup", "missing_user_creation", "explicit_uuid_bypass"} {
			item := runCase(os.Args[1], name)
			result.Cases = append(result.Cases, item)
			result.Passed = result.Passed && item.Passed
		}
	}
	json.NewEncoder(os.Stdout).Encode(result)
	if !result.Passed {
		os.Exit(1)
	}
}
