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
	"net"
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
	configFile  = "remote-codex-monitor-config.json"
	healthFile  = "remote-codex-monitor-health.json"
	statusAddr  = "127.0.0.1:43121"
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

type installedConfig struct {
	CodexHome string `json:"codexHome"`
	Provider  string `json:"provider"`
	BaseURL   string `json:"baseUrl"`
	APIKey    string `json:"apiKey"`
}

type monitorHealth struct {
	PID           int    `json:"pid"`
	Version       string `json:"version"`
	StartedAt     string `json:"startedAt"`
	LastCheckAt   string `json:"lastCheckAt"`
	LastSuccessAt string `json:"lastSuccessAt,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	Endpoint      string `json:"endpoint,omitempty"`
	StatusURL     string `json:"statusUrl,omitempty"`
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
	case "--status":
		message, err = "状态页已在默认浏览器中打开。", openStatusPage()
	default:
		if health, running := activeMonitorHealth(); running && health.Version == version {
			message, err = fmt.Sprintf("后台监控正在运行。\n后台 PID：%d\n状态页：%s", health.PID, statusPageURL()), openStatusPage()
		} else {
			message, err = installMonitor()
		}
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
	codexDir, err := codexHome()
	if err != nil {
		return "", err
	}
	settings, err := loadProviderSettingsFrom(codexDir, nil)
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
	if err := saveJSON(filepath.Join(dataDir, configFile), installedConfig{
		CodexHome: codexDir,
		Provider:  settings.Provider,
		BaseURL:   settings.BaseURL,
		APIKey:    settings.APIKey,
	}); err != nil {
		return "", fmt.Errorf("保存后台运行配置失败：%w", err)
	}
	healthPath := filepath.Join(dataDir, healthFile)
	_ = os.Remove(healthPath)
	installStartedAt := time.Now().UTC()
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

	health, err := waitForMonitorHealth(healthPath, installStartedAt, 20*time.Second)
	if err != nil {
		if health.PID != 0 {
			_ = openStatusPage()
			return fmt.Sprintf("已安装并启动，当前检查异常：%s\n请在状态页查看并重试。\n后台 PID：%d\n状态页：%s\n日志：%s", err, health.PID, statusPageURL(), filepath.Join(dataDir, "remote-codex-monitor.log")), nil
		}
		return "", fmt.Errorf("后台自检失败：%w\n日志：%s", err, filepath.Join(dataDir, "remote-codex-monitor.log"))
	}
	_ = openStatusPage()
	return fmt.Sprintf("已安装并通过后台自检。\n安装器现在退出，监控进程会持续运行。\n后台 PID：%d\n版本：%s\n站点：%s\n状态页：%s\n日志：%s", health.PID, version, settings.BaseURL, statusPageURL(), filepath.Join(dataDir, "remote-codex-monitor.log")), nil
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
	healthPath := filepath.Join(dataDir, healthFile)
	checkNow := make(chan struct{}, 1)
	statusURL, err := startStatusUI(healthPath, checkNow)
	if err != nil {
		return fmt.Errorf("启动本地状态页失败：%w", err)
	}
	health := monitorHealth{
		PID:       os.Getpid(),
		Version:   version,
		StartedAt: time.Now().UTC().Format(time.RFC3339Nano),
		StatusURL: statusURL,
	}
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
		err := checkMonitor(client, &state, statePath)
		recordMonitorHealth(healthPath, &health, err)
		if err != nil {
			if err.Error() != lastError {
				appendLog(err)
				lastError = err.Error()
			}
		} else {
			lastError = ""
		}
		timer := time.NewTimer(pollEvery)
		select {
		case <-timer.C:
		case <-checkNow:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
	}
}

func checkMonitor(client *http.Client, state *monitorState, statePath string) error {
	if err := preflightMonitor(client); err != nil {
		return err
	}
	return pollOnce(client, state, statePath)
}

func pollOnce(client *http.Client, state *monitorState, statePath string) error {
	settings, err := loadRuntimeProviderSettings()
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

func preflightMonitor(client *http.Client) error {
	settings, err := loadRuntimeProviderSettings()
	if err != nil {
		return err
	}
	endpoint, err := eventEndpoint(settings.BaseURL)
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+settings.APIKey)
	request.Header.Set("User-Agent", "JuanProxy-Remote-Codex-Monitor/"+version)
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("监控站点不可达：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("监控站点检查失败：HTTP %d %s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	var probe struct {
		OK      bool `json:"ok"`
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&probe); err != nil || !probe.OK {
		return errors.New("监控站点返回了无效的检查结果")
	}
	if !probe.Enabled {
		return errors.New("JuanProxy 的远程完成通知未启用")
	}
	return nil
}

func statusPageURL() string {
	return "http://" + statusAddr
}

func startStatusUI(healthPath string, checkNow chan<- struct{}) (string, error) {
	listener, err := net.Listen("tcp", statusAddr)
	if err != nil {
		return "", err
	}
	server := &http.Server{Handler: statusUIHandler(healthPath, checkNow)}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			appendLog(fmt.Errorf("本地状态页异常退出：%w", err))
		}
	}()
	return statusPageURL(), nil
}

func openStatusPage() error {
	url := statusPageURL()
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return nil
	}
}

func activeMonitorHealth() (monitorHealth, bool) {
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(statusPageURL() + "/api/status")
	if err != nil {
		return monitorHealth{}, false
	}
	defer response.Body.Close()
	var health monitorHealth
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health) != nil || health.PID == 0 {
		return monitorHealth{}, false
	}
	return health, true
}

func statusUIHandler(healthPath string, checkNow chan<- struct{}) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writer.Header().Set("Allow", http.MethodGet)
			http.Error(writer, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeStatusJSON(writer, http.StatusOK, readMonitorHealth(healthPath))
	})
	mux.HandleFunc("/api/check", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writer.Header().Set("Allow", http.MethodPost)
			http.Error(writer, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		select {
		case checkNow <- struct{}{}:
		default:
		}
		writeStatusJSON(writer, http.StatusAccepted, map[string]bool{"accepted": true})
	})
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/" || request.Method != http.MethodGet {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(writer, statusPageHTML)
	})
	return mux
}

func readMonitorHealth(path string) monitorHealth {
	var health monitorHealth
	raw, err := os.ReadFile(path)
	if err == nil && json.Unmarshal(raw, &health) == nil {
		return health
	}
	health.LastError = "尚未收到后台进程状态"
	return health
}

func writeStatusJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

const statusPageHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>JuanProxy 远程 Codex 监控</title>
<style>
:root { color: #17212b; background: #f4f7f8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; }
main { max-width: 760px; margin: 0 auto; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
h1 { margin: 0; font-size: 22px; font-weight: 650; }
button { min-width: 96px; height: 36px; border: 1px solid #126d67; border-radius: 5px; color: #fff; background: #126d67; font: inherit; cursor: pointer; }
button:hover { background: #0d5752; }
button:disabled { cursor: wait; opacity: .65; }
.summary { display: flex; align-items: center; gap: 10px; padding: 16px 0; border-top: 1px solid #d6dce0; border-bottom: 1px solid #d6dce0; font-size: 16px; font-weight: 600; }
.dot { width: 10px; height: 10px; flex: 0 0 10px; border-radius: 50%; background: #87949c; }
.ok .dot { background: #16803b; }
.bad .dot { background: #b42318; }
dl { display: grid; grid-template-columns: 144px minmax(0, 1fr); margin: 0; }
dt, dd { min-height: 42px; padding: 11px 0; border-bottom: 1px solid #d6dce0; }
dt { color: #52616b; }
dd { margin: 0; overflow-wrap: anywhere; }
.error { display: none; margin-top: 18px; padding: 12px; border-left: 3px solid #b42318; background: #fff1ef; color: #7a271a; overflow-wrap: anywhere; }
.error.visible { display: block; }
.updated { margin: 14px 0 0; color: #66747c; font-size: 13px; }
@media (max-width: 520px) { body { padding: 16px; } header { align-items: flex-start; } h1 { font-size: 20px; } dl { grid-template-columns: 1fr; } dt { min-height: auto; padding-bottom: 3px; border-bottom: 0; } dd { padding-top: 3px; } }
</style>
</head>
<body>
<main>
  <header><h1>JuanProxy 远程 Codex 监控</h1><button id="check" type="button">立即检查</button></header>
  <section id="summary" class="summary"><span class="dot"></span><span id="status">正在读取状态</span></section>
  <dl>
    <dt>后台进程</dt><dd id="pid">-</dd>
    <dt>版本</dt><dd id="version">-</dd>
    <dt>启动时间</dt><dd id="startedAt">-</dd>
    <dt>最近检查</dt><dd id="lastCheckAt">-</dd>
    <dt>最近成功</dt><dd id="lastSuccessAt">-</dd>
    <dt>监控站点</dt><dd id="endpoint">-</dd>
  </dl>
  <div id="error" class="error"></div>
  <p id="updated" class="updated"></p>
</main>
<script>
const ids = ['pid', 'version', 'startedAt', 'lastCheckAt', 'lastSuccessAt', 'endpoint'];
const text = (id, value) => document.getElementById(id).textContent = value || '-';
const formatTime = value => value ? new Date(value).toLocaleString() : '-';
async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const health = await response.json();
    ids.forEach(id => text(id, id.endsWith('At') ? formatTime(health[id]) : health[id]));
    const failed = Boolean(health.lastError);
    document.getElementById('summary').className = 'summary ' + (failed ? 'bad' : 'ok');
    text('status', failed ? '后台运行，检查异常' : health.lastSuccessAt ? '后台运行正常' : '后台运行，等待首次检查');
    const error = document.getElementById('error');
    error.textContent = health.lastError || '';
    error.className = failed ? 'error visible' : 'error';
    text('updated', '页面更新：' + new Date().toLocaleTimeString());
  } catch (error) {
    document.getElementById('summary').className = 'summary bad';
    text('status', '状态页读取失败');
    const element = document.getElementById('error');
    element.textContent = error.message;
    element.className = 'error visible';
  }
}
document.getElementById('check').addEventListener('click', async event => {
	 const button = event.currentTarget;
	 button.disabled = true;
	 await fetch('/api/check', { method: 'POST' });
	 setTimeout(refresh, 500);
	 setTimeout(() => button.disabled = false, 750);
});
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`

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

func loadRuntimeProviderSettings() (providerSettings, error) {
	dataDir, err := monitorDataDir()
	if err != nil {
		return providerSettings{}, err
	}
	installed := readInstalledConfig(filepath.Join(dataDir, configFile))
	home := installed.CodexHome
	if home == "" {
		home, err = codexHome()
		if err != nil {
			return providerSettings{}, err
		}
	}
	return loadProviderSettingsFrom(home, &installed)
}

func loadProviderSettingsFrom(home string, installed *installedConfig) (providerSettings, error) {
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
	if settings.APIKey == "" && installed != nil &&
		settings.Provider == installed.Provider && settings.BaseURL == installed.BaseURL {
		settings.APIKey = strings.TrimSpace(installed.APIKey)
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
	return saveJSON(path, state)
}

func saveJSON(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
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

func readInstalledConfig(path string) installedConfig {
	var config installedConfig
	raw, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(raw, &config)
	}
	return config
}

func recordMonitorHealth(path string, health *monitorHealth, checkErr error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	health.LastCheckAt = now
	if settings, err := loadRuntimeProviderSettings(); err == nil {
		health.Endpoint, _ = eventEndpoint(settings.BaseURL)
	}
	if checkErr != nil {
		health.LastError = checkErr.Error()
	} else {
		health.LastError = ""
		health.LastSuccessAt = now
	}
	_ = saveJSON(path, *health)
}

func waitForMonitorHealth(path string, after time.Time, timeout time.Duration) (monitorHealth, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var health monitorHealth
		raw, err := os.ReadFile(path)
		if err == nil && json.Unmarshal(raw, &health) == nil && !parseTime(health.LastCheckAt).Before(after) {
			if health.LastError != "" {
				return health, errors.New(health.LastError)
			}
			if health.LastSuccessAt != "" {
				return health, nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return monitorHealth{}, errors.New("20 秒内未收到后台进程状态")
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
	dataDir, err := monitorDataDir()
	if err != nil {
		return "", err
	}
	installed := readInstalledConfig(filepath.Join(dataDir, configFile))
	home := installed.CodexHome
	if home == "" {
		home, err = codexHome()
		if err != nil {
			return "", err
		}
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
