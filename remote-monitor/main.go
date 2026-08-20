package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	monitorName = "JuanProxy Remote Codex Monitor"
	taskName    = "JuanProxy Remote Codex Monitor"
	launchLabel = "com.juanproxy.remote-codex-monitor"
	pollEvery   = 5 * time.Second
)

var version = "dev"

type providerSettings struct {
	Provider string
	BaseURL  string
	EnvKey   string
	APIKey   string
}

type remoteEvent struct {
	Type        string   `json:"type"`
	Key         string   `json:"key"`
	ThreadID    string   `json:"threadId"`
	TurnID      string   `json:"turnId,omitempty"`
	CWD         string   `json:"cwd,omitempty"`
	Status      string   `json:"status,omitempty"`
	StartedAt   string   `json:"startedAt,omitempty"`
	CompletedAt string   `json:"completedAt,omitempty"`
	CreatedAt   string   `json:"createdAt,omitempty"`
	UpdatedAt   string   `json:"updatedAt,omitempty"`
	DurationMS  *float64 `json:"durationMs,omitempty"`
}

type monitorState struct {
	Keys  []string `json:"keys"`
	Since string   `json:"since"`
}

type envelope struct {
	Timestamp json.RawMessage `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type sessionPayload struct {
	ID             string          `json:"id"`
	CWD            string          `json:"cwd"`
	ThreadSource   string          `json:"thread_source"`
	ParentThreadID json.RawMessage `json:"parent_thread_id"`
}

type eventPayload struct {
	Type        string          `json:"type"`
	TurnID      string          `json:"turn_id"`
	ThreadID    string          `json:"thread_id"`
	Error       json.RawMessage `json:"error"`
	StartedAt   json.RawMessage `json:"started_at"`
	CompletedAt json.RawMessage `json:"completed_at"`
	DurationMS  json.RawMessage `json:"duration_ms"`
	Goal        *goalPayload    `json:"goal"`
}

type goalPayload struct {
	Status    string          `json:"status"`
	CreatedAt json.RawMessage `json:"createdAt"`
	UpdatedAt json.RawMessage `json:"updatedAt"`
}

func main() {
	var err error
	var message string
	switch firstArg() {
	case "--run":
		err = runMonitor()
		if err != nil {
			appendLog(err)
		}
		return
	case "--uninstall":
		message, err = uninstallMonitor()
	case "--version":
		notifyUser(monitorName+" "+version, false)
		return
	default:
		message, err = installMonitor()
	}
	if err != nil {
		notifyUser("操作失败："+err.Error(), true)
		return
	}
	notifyUser(message, false)
}

func firstArg() string {
	if len(os.Args) > 1 {
		return os.Args[1]
	}
	return ""
}

func installMonitor() (string, error) {
	settings, err := loadProviderSettings()
	if err != nil {
		return "", err
	}
	if _, err := eventEndpoint(settings.BaseURL); err != nil {
		return "", err
	}

	dataDir, err := monitorDataDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", err
	}
	current, err := os.Executable()
	if err != nil {
		return "", err
	}
	target := filepath.Join(dataDir, executableName())

	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("schtasks.exe", "/End", "/TN", taskName).Run()
		time.Sleep(300 * time.Millisecond)
		if err := copyExecutable(current, target); err != nil {
			return "", err
		}
		command := fmt.Sprintf("\"%s\" --run", target)
		if output, err := exec.Command("schtasks.exe", "/Create", "/TN", taskName, "/SC", "ONLOGON", "/TR", command, "/RL", "LIMITED", "/F").CombinedOutput(); err != nil {
			return "", commandError(err, output)
		}
		if output, err := exec.Command("schtasks.exe", "/Run", "/TN", taskName).CombinedOutput(); err != nil {
			return "", commandError(err, output)
		}
	case "darwin":
		plistPath, domain, err := launchAgentPaths()
		if err != nil {
			return "", err
		}
		_ = exec.Command("launchctl", "bootout", domain, plistPath).Run()
		if err := copyExecutable(current, target); err != nil {
			return "", err
		}
		if err := writeLaunchAgent(plistPath, target, dataDir); err != nil {
			return "", err
		}
		if output, err := exec.Command("launchctl", "bootstrap", domain, plistPath).CombinedOutput(); err != nil {
			return "", commandError(err, output)
		}
	default:
		return "", fmt.Errorf("不支持的系统：%s", runtime.GOOS)
	}

	return fmt.Sprintf("已安装并启动。\n版本：%s\n站点：%s\n日志：%s", version, settings.BaseURL, filepath.Join(dataDir, "remote-codex-monitor.log")), nil
}

func uninstallMonitor() (string, error) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("schtasks.exe", "/End", "/TN", taskName).Run()
		output, err := exec.Command("schtasks.exe", "/Delete", "/TN", taskName, "/F").CombinedOutput()
		if err != nil && !bytes.Contains(bytes.ToLower(output), []byte("cannot find")) {
			return "", commandError(err, output)
		}
	case "darwin":
		plistPath, domain, err := launchAgentPaths()
		if err != nil {
			return "", err
		}
		_ = exec.Command("launchctl", "bootout", domain, plistPath).Run()
		if err := os.Remove(plistPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	default:
		return "", fmt.Errorf("不支持的系统：%s", runtime.GOOS)
	}
	return "后台监控已停止并移除。", nil
}

func runMonitor() error {
	dataDir, err := monitorDataDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	statePath := filepath.Join(dataDir, "remote-codex-monitor-state.json")
	state := readState(statePath)
	if state.Since == "" {
		state.Since = time.Now().UTC().Format(time.RFC3339Nano)
		if err := saveState(statePath, state); err != nil {
			return err
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	lastError := ""
	for {
		if err := pollOnce(client, &state, statePath); err != nil {
			if err.Error() != lastError {
				appendLog(err)
				lastError = err.Error()
			}
		} else {
			lastError = ""
		}
		time.Sleep(pollEvery)
	}
}

func pollOnce(client *http.Client, state *monitorState, statePath string) error {
	settings, err := loadProviderSettings()
	if err != nil {
		return err
	}
	endpoint, err := eventEndpoint(settings.BaseURL)
	if err != nil {
		return err
	}
	since, err := time.Parse(time.RFC3339Nano, state.Since)
	if err != nil {
		since = time.Now().UTC()
	}
	known := make(map[string]bool, len(state.Keys))
	for _, key := range state.Keys {
		known[key] = true
	}
	sessionsDir, err := codexSessionsDir()
	if err != nil {
		return err
	}
	events, err := findEvents(sessionsDir, since, known)
	if err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}
	if err := postEvents(client, endpoint, settings.APIKey, events); err != nil {
		return err
	}
	for _, event := range events {
		state.Keys = append(state.Keys, event.Key)
		if at := eventTime(event); at.After(since) {
			since = at
		}
	}
	if len(state.Keys) > 10000 {
		state.Keys = state.Keys[len(state.Keys)-10000:]
	}
	state.Since = since.UTC().Format(time.RFC3339Nano)
	return saveState(statePath, *state)
}

func findEvents(sessionsDir string, since time.Time, known map[string]bool) ([]remoteEvent, error) {
	events := make([]remoteEvent, 0)
	err := filepath.WalkDir(sessionsDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "rollout-") || !strings.HasSuffix(entry.Name(), ".jsonl") {
			return nil
		}
		found, err := inspectRollout(path, since, known)
		if err == nil {
			events = append(events, found...)
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return events, nil
	}
	sort.Slice(events, func(i, j int) bool { return eventTime(events[i]).Before(eventTime(events[j])) })
	return events, err
}

func inspectRollout(path string, since time.Time, known map[string]bool) ([]remoteEvent, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	threadID := threadIDFromPath(path)
	cwd := ""
	isSubagent := false
	goalStatus := ""
	starts := map[string]string{}
	events := make([]remoteEvent, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		var item envelope
		if err := decodeJSON(scanner.Bytes(), &item); err != nil {
			continue
		}
		fallback := rawTime(item.Timestamp, "")
		if item.Type == "session_meta" {
			var meta sessionPayload
			if json.Unmarshal(item.Payload, &meta) == nil {
				if meta.ID != "" {
					threadID = meta.ID
				}
				cwd = meta.CWD
				isSubagent = meta.ThreadSource == "subagent" || hasJSONValue(meta.ParentThreadID)
			}
			continue
		}
		if item.Type != "event_msg" {
			continue
		}
		var payload eventPayload
		if json.Unmarshal(item.Payload, &payload) != nil {
			continue
		}
		if threadID == "" {
			threadID = payload.ThreadID
		}
		switch payload.Type {
		case "task_started":
			if payload.TurnID != "" {
				starts[payload.TurnID] = rawTime(payload.StartedAt, fallback)
			}
		case "thread_goal_updated":
			if payload.Goal == nil {
				continue
			}
			goalStatus = strings.ToLower(strings.TrimSpace(payload.Goal.Status))
			if goalStatus != "paused" && goalStatus != "complete" {
				continue
			}
			createdAt := rawTime(payload.Goal.CreatedAt, fallback)
			updatedAt := rawTime(payload.Goal.UpdatedAt, fallback)
			key := fmt.Sprintf("%s:goal:%s:%s:%s", threadID, createdAt, updatedAt, goalStatus)
			if threadID != "" && createdAt != "" && updatedAt != "" && !known[key] && !parseTime(updatedAt).Before(since) {
				events = append(events, remoteEvent{Type: "goal", Key: key, ThreadID: threadID, CWD: cwd, Status: goalStatus, CreatedAt: createdAt, UpdatedAt: updatedAt})
			}
		case "task_complete":
			if payload.TurnID == "" || hasJSONValue(payload.Error) || goalStatus == "active" || goalStatus == "paused" || goalStatus == "blocked" {
				continue
			}
			completedAt := rawTime(payload.CompletedAt, fallback)
			key := threadID + ":" + payload.TurnID
			if threadID == "" || completedAt == "" || known[key] || parseTime(completedAt).Before(since) {
				continue
			}
			startedAt := rawTime(payload.StartedAt, starts[payload.TurnID])
			events = append(events, remoteEvent{Type: "completion", Key: key, ThreadID: threadID, TurnID: payload.TurnID, CWD: cwd, StartedAt: startedAt, CompletedAt: completedAt, DurationMS: rawNonNegative(payload.DurationMS)})
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if isSubagent {
		return nil, nil
	}
	return events, nil
}

func postEvents(client *http.Client, endpoint, apiKey string, events []remoteEvent) error {
	hostname, _ := os.Hostname()
	if strings.TrimSpace(hostname) == "" {
		hostname = "remote-codex"
	}
	body, err := json.Marshal(map[string]any{
		"source": map[string]string{"id": hostname, "name": hostname},
		"events": events,
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("User-Agent", "JuanProxy-Remote-Codex-Monitor/"+version)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("上报失败：HTTP %d %s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	return nil
}

func loadProviderSettings() (providerSettings, error) {
	home, err := codexHome()
	if err != nil {
		return providerSettings{}, err
	}
	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		return providerSettings{}, fmt.Errorf("读取 Codex 配置失败：%w", err)
	}
	settings, err := parseCodexConfig(string(raw))
	if err != nil {
		return providerSettings{}, err
	}
	if settings.EnvKey != "" {
		settings.APIKey = strings.TrimSpace(os.Getenv(settings.EnvKey))
	}
	if settings.APIKey == "" {
		settings.APIKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	}
	if settings.APIKey == "" {
		var auth map[string]any
		if raw, err := os.ReadFile(filepath.Join(home, "auth.json")); err == nil && json.Unmarshal(raw, &auth) == nil {
			settings.APIKey = strings.TrimSpace(fmt.Sprint(auth["OPENAI_API_KEY"]))
			if settings.APIKey == "<nil>" {
				settings.APIKey = ""
			}
		}
	}
	if settings.APIKey == "" {
		return providerSettings{}, errors.New("未在生效环境变量或 ~/.codex/auth.json 中找到 API key")
	}
	return settings, nil
}

func parseCodexConfig(raw string) (providerSettings, error) {
	active := ""
	section := ""
	providers := map[string]providerSettings{}
	scanner := bufio.NewScanner(strings.NewReader(raw))
	for scanner.Scan() {
		line := strings.TrimSpace(stripTOMLComment(scanner.Text()))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			name := strings.TrimSpace(line[1 : len(line)-1])
			section = ""
			if strings.HasPrefix(name, "model_providers.") {
				section = trimTOMLString(strings.TrimPrefix(name, "model_providers."))
			}
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = trimTOMLString(value)
		if section == "" && key == "model_provider" && active == "" {
			active = value
			continue
		}
		if section != "" {
			settings := providers[section]
			settings.Provider = section
			if key == "base_url" {
				settings.BaseURL = value
			} else if key == "env_key" {
				settings.EnvKey = value
			}
			providers[section] = settings
		}
	}
	if err := scanner.Err(); err != nil {
		return providerSettings{}, err
	}
	if active == "" {
		return providerSettings{}, errors.New("Codex config.toml 未配置 model_provider")
	}
	settings := providers[active]
	if settings.BaseURL == "" {
		return providerSettings{}, fmt.Errorf("Codex config.toml 未找到生效站点 %q 的 base_url", active)
	}
	return settings, nil
}

func eventEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("Codex base_url 无效：%s", baseURL)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/__proxy/remote-codex-events"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func readState(path string) monitorState {
	var state monitorState
	raw, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(raw, &state)
	}
	return state
}

func saveState(path string, state monitorState) error {
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	_ = os.Remove(path)
	return os.Rename(temporary, path)
}

func monitorDataDir() (string, error) {
	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "JuanProxy"), nil
		}
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "JuanProxy"), nil
}

func codexHome() (string, error) {
	if value := strings.TrimSpace(os.Getenv("CODEX_HOME")); value != "" {
		return value, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex"), nil
}

func codexSessionsDir() (string, error) {
	home, err := codexHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "sessions"), nil
}

func executableName() string {
	if runtime.GOOS == "windows" {
		return "remote-codex-monitor.exe"
	}
	return "remote-codex-monitor"
}

func copyExecutable(source, target string) error {
	if samePath(source, target) {
		return nil
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temporary := target + ".new"
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	_ = os.Remove(target)
	return os.Rename(temporary, target)
}

func samePath(left, right string) bool {
	left, _ = filepath.Abs(left)
	right, _ = filepath.Abs(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func launchAgentPaths() (string, string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	directory := filepath.Join(home, "Library", "LaunchAgents")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", "", err
	}
	return filepath.Join(directory, launchLabel+".plist"), fmt.Sprintf("gui/%d", os.Getuid()), nil
}

func writeLaunchAgent(path, executable, dataDir string) error {
	escape := func(value string) string {
		var result bytes.Buffer
		_ = xml.EscapeText(&result, []byte(value))
		return result.String()
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array><string>%s</string><string>--run</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>%s</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, launchLabel, escape(executable), escape(filepath.Join(dataDir, "remote-codex-monitor.stdout.log")), escape(filepath.Join(dataDir, "remote-codex-monitor.stderr.log")))
	return os.WriteFile(path, []byte(plist), 0o644)
}

func stripTOMLComment(value string) string {
	quote := rune(0)
	escaped := false
	for index, char := range value {
		if escaped {
			escaped = false
			continue
		}
		if char == '\\' && quote == '"' {
			escaped = true
			continue
		}
		if char == '\'' || char == '"' {
			if quote == 0 {
				quote = char
			} else if quote == char {
				quote = 0
			}
			continue
		}
		if char == '#' && quote == 0 {
			return value[:index]
		}
	}
	return value
}

func trimTOMLString(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		return value[1 : len(value)-1]
	}
	if unquoted, err := strconv.Unquote(value); err == nil {
		return unquoted
	}
	return strings.Trim(value, "\"'")
}

func decodeJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(target)
}

func rawTime(raw json.RawMessage, fallback string) string {
	if !hasJSONValue(raw) {
		return fallback
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return fallback
	}
	switch typed := value.(type) {
	case string:
		if number, err := strconv.ParseFloat(typed, 64); err == nil {
			return unixTime(number)
		}
		if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
	case json.Number:
		if number, err := typed.Float64(); err == nil {
			return unixTime(number)
		}
	}
	return fallback
}

func unixTime(value float64) string {
	if value < 1e12 {
		value *= 1000
	}
	seconds := int64(value) / 1000
	nanoseconds := (int64(value) % 1000) * int64(time.Millisecond)
	return time.Unix(seconds, nanoseconds).UTC().Format(time.RFC3339Nano)
}

func rawNonNegative(raw json.RawMessage) *float64 {
	if !hasJSONValue(raw) {
		return nil
	}
	var number json.Number
	if json.Unmarshal(raw, &number) != nil {
		return nil
	}
	value, err := number.Float64()
	if err != nil || value < 0 {
		return nil
	}
	return &value
}

func hasJSONValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

func threadIDFromPath(path string) string {
	name := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	parts := strings.Split(name, "-")
	if len(parts) < 6 {
		return ""
	}
	return strings.Join(parts[len(parts)-5:], "-")
}

func parseTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}

func eventTime(event remoteEvent) time.Time {
	if event.Type == "goal" {
		return parseTime(event.UpdatedAt)
	}
	return parseTime(event.CompletedAt)
}

func commandError(err error, output []byte) error {
	detail := strings.TrimSpace(string(output))
	if detail == "" {
		return err
	}
	return fmt.Errorf("%w：%s", err, detail)
}

func appendLog(err error) {
	dataDir, dirErr := monitorDataDir()
	if dirErr != nil {
		return
	}
	_ = os.MkdirAll(dataDir, 0o700)
	file, openErr := os.OpenFile(filepath.Join(dataDir, "remote-codex-monitor.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if openErr != nil {
		return
	}
	defer file.Close()
	_, _ = fmt.Fprintf(file, "%s %s\n", time.Now().Format(time.RFC3339), err)
}
