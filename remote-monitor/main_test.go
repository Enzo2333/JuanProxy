package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseCodexConfigUsesActiveProvider(t *testing.T) {
	settings, err := parseCodexConfig(`
model_provider = "juanproxy"

[model_providers.other]
base_url = "https://other.example/v1"

[model_providers.juanproxy]
base_url = "https://proxy.example/v1"
env_key = "JUANPROXY_API_KEY"
`)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Provider != "juanproxy" || settings.BaseURL != "https://proxy.example/v1" || settings.EnvKey != "JUANPROXY_API_KEY" {
		t.Fatalf("unexpected settings: %#v", settings)
	}
	endpoint, err := eventEndpoint(settings.BaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "https://proxy.example/v1/__proxy/remote-codex-events" {
		t.Fatalf("unexpected endpoint: %s", endpoint)
	}
}

func TestLoadProviderSettingsUsesInstalledKeyWhenBackgroundHasNoShellEnvironment(t *testing.T) {
	home := t.TempDir()
	config := `
model_provider = "juanproxy"

[model_providers.juanproxy]
base_url = "https://proxy.example/v1"
env_key = "JUANPROXY_API_KEY"
`
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JUANPROXY_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")

	settings, err := loadProviderSettingsFrom(home, &installedConfig{
		Provider: "juanproxy",
		BaseURL:  "https://proxy.example/v1",
		APIKey:   "persisted-local-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if settings.APIKey != "persisted-local-key" {
		t.Fatalf("background should use the installation key, got %q", settings.APIKey)
	}
}

func TestCodexSessionsDirUsesInstalledCodexHome(t *testing.T) {
	configRoot := t.TempDir()
	codexDir := filepath.Join(t.TempDir(), "custom-codex")
	t.Setenv("LOCALAPPDATA", configRoot)
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	dataDir, err := monitorDataDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := saveJSON(filepath.Join(dataDir, configFile), installedConfig{CodexHome: codexDir}); err != nil {
		t.Fatal(err)
	}

	sessionsDir, err := codexSessionsDir()
	if err != nil {
		t.Fatal(err)
	}
	if sessionsDir != filepath.Join(codexDir, "sessions") {
		t.Fatalf("unexpected sessions directory: %s", sessionsDir)
	}
}

func TestStatusUIReportsHealthAndRequestsImmediateCheck(t *testing.T) {
	healthPath := filepath.Join(t.TempDir(), healthFile)
	if err := saveJSON(healthPath, monitorHealth{
		PID:           42,
		Version:       "test",
		LastCheckAt:   "2026-08-20T08:00:00Z",
		LastSuccessAt: "2026-08-20T08:00:00Z",
		Endpoint:      "https://proxy.example/v1/__proxy/remote-codex-events",
	}); err != nil {
		t.Fatal(err)
	}
	checkNow := make(chan struct{}, 1)
	handler := statusUIHandler(healthPath, checkNow)

	status := httptest.NewRecorder()
	handler.ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	if status.Code != http.StatusOK {
		t.Fatalf("unexpected status response: %d %s", status.Code, status.Body.String())
	}
	var health monitorHealth
	if err := json.Unmarshal(status.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if health.PID != 42 || health.Endpoint == "" {
		t.Fatalf("unexpected health payload: %#v", health)
	}
	if strings.Contains(status.Body.String(), "apiKey") {
		t.Fatal("status response must not expose credentials")
	}

	check := httptest.NewRecorder()
	handler.ServeHTTP(check, httptest.NewRequest(http.MethodPost, "/api/check", nil))
	if check.Code != http.StatusAccepted {
		t.Fatalf("unexpected check response: %d %s", check.Code, check.Body.String())
	}
	select {
	case <-checkNow:
	default:
		t.Fatal("immediate check was not requested")
	}

	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(page.Body.String(), "立即检查") || !strings.Contains(page.Body.String(), "/api/status") {
		t.Fatal("status page is missing monitoring controls")
	}
}

func TestInspectRolloutSeparatesAnswerAndGoalNotifications(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-2026-08-20T00-00-00-11111111-1111-1111-1111-111111111111.jsonl")
	lines := []string{
		`{"timestamp":"2026-08-20T01:00:00Z","type":"session_meta","payload":{"id":"thread-1","cwd":"C:\\work","thread_source":"app"}}`,
		`{"timestamp":"2026-08-20T01:00:01Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"answer-1","completed_at":1787187601000,"duration_ms":1000}}`,
		`{"timestamp":"2026-08-20T01:01:00Z","type":"event_msg","payload":{"type":"thread_goal_updated","goal":{"status":"active","createdAt":1787187660,"updatedAt":1787187660}}}`,
		`{"timestamp":"2026-08-20T01:01:05Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"goal-turn","completed_at":1787187665000,"duration_ms":5000}}`,
		`{"timestamp":"2026-08-20T01:01:06Z","type":"event_msg","payload":{"type":"thread_goal_updated","goal":{"status":"paused","createdAt":1787187660,"updatedAt":1787187666}}}`,
		`{"timestamp":"2026-08-20T01:02:00Z","type":"event_msg","payload":{"type":"thread_goal_updated","goal":{"status":"complete","createdAt":1787187660,"updatedAt":1787187720}}}`,
		`{"timestamp":"2026-08-20T01:03:00Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"answer-2","completed_at":1787187780000}}`,
	}
	if err := os.WriteFile(path, []byte(joinLines(lines)), 0o600); err != nil {
		t.Fatal(err)
	}

	events, err := inspectRollout(path, time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 {
		t.Fatalf("expected 4 events, got %d: %#v", len(events), events)
	}
	if events[0].Type != "completion" || events[0].TurnID != "answer-1" {
		t.Fatalf("first event should be the ordinary answer: %#v", events[0])
	}
	if events[1].Type != "goal" || events[1].Status != "paused" {
		t.Fatalf("second event should be goal paused: %#v", events[1])
	}
	if events[2].Type != "goal" || events[2].Status != "complete" {
		t.Fatalf("third event should be goal complete: %#v", events[2])
	}
	if events[3].Type != "completion" || events[3].TurnID != "answer-2" {
		t.Fatalf("ordinary notifications should resume after goal completion: %#v", events[3])
	}
}

func joinLines(lines []string) string {
	result := ""
	for _, line := range lines {
		result += line + "\n"
	}
	return result
}
