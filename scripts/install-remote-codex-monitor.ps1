param(
  [switch]$Run,
  [string]$ProxyUrl,
  [string]$ApiKey,
  [int]$PollSeconds = 5
)

$ErrorActionPreference = 'Stop'
$taskName = 'JuanProxy Remote Codex Monitor'
$scriptPath = $PSCommandPath
$statePath = Join-Path $env:LOCALAPPDATA 'JuanProxy\remote-codex-monitor-state.json'
$logPath = Join-Path $env:LOCALAPPDATA 'JuanProxy\remote-codex-monitor.log'
$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$pollSeconds = [Math]::Max(2, $PollSeconds)

function Get-CodexProviderSettings {
  if (-not (Test-Path -LiteralPath $configPath)) { throw "Codex 配置不存在: $configPath" }
  $lines = Get-Content -LiteralPath $configPath
  $provider = ($lines | Where-Object { $_ -match '^\s*model_provider\s*=\s*["'']([^"'']+)' } | Select-Object -First 1) -replace '^.*=[\s"'']+([^"'']+).*$', '$1'
  if (-not $provider) { throw 'Codex model_provider 未配置' }
  $section = $false
  $baseUrl = $null
  $envKey = $null
  foreach ($line in $lines) {
    if ($line -match '^\s*\[model_providers\.([^\]]+)\]') {
      $section = $Matches[1] -eq $provider
      continue
    }
    if (-not $section) { continue }
    if ($line -match '^\s*base_url\s*=\s*["'']([^"'']+)["'']') { $baseUrl = $Matches[1] }
    if ($line -match '^\s*env_key\s*=\s*["'']([^"'']+)["'']') { $envKey = $Matches[1] }
  }
  if (-not $baseUrl) { throw "未找到生效站点 base_url: $provider" }
  if (-not $ApiKey) {
    if ($envKey) { $ApiKey = [Environment]::GetEnvironmentVariable($envKey, 'User') }
    if (-not $ApiKey -and $envKey) { $ApiKey = [Environment]::GetEnvironmentVariable($envKey) }
    if (-not $ApiKey) { $ApiKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY') }
    $authPath = Join-Path $env:USERPROFILE '.codex\auth.json'
    if (-not $ApiKey -and (Test-Path -LiteralPath $authPath)) {
      try { $ApiKey = ((Get-Content -Raw -LiteralPath $authPath | ConvertFrom-Json).OPENAI_API_KEY) } catch {}
    }
  }
  if (-not $ApiKey) { throw '远程 Codex API key 未找到' }
  return @{ BaseUrl = $baseUrl; ApiKey = [string]$ApiKey; Provider = $provider }
}

function Get-EventEndpoint([string]$baseUrl) {
  $uri = [Uri]$baseUrl
  $builder = [UriBuilder]$uri
  $path = $builder.Path.TrimEnd('/')
  $builder.Path = "$path/__proxy/remote-codex-events"
  return $builder.Uri.AbsoluteUri
}

function Read-State {
  if (-not (Test-Path -LiteralPath $statePath)) { return @{ keys = @(); since = (Get-Date).ToUniversalTime().ToString('o') } }
  try { return (Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json) } catch { return @{ keys = @(); since = (Get-Date).ToUniversalTime().ToString('o') } }
}

function Save-State($state) {
  $dir = Split-Path -Parent $statePath
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$statePath.$PID.tmp"
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -Force -LiteralPath $tmp -Destination $statePath
}

function Convert-CodexTime($Value, $Fallback) {
  if ($null -eq $Value) { return $Fallback }
  if ($Value -is [long] -or $Value -is [int] -or $Value -is [double] -or $Value -is [decimal]) {
    try { return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Value).UtcDateTime.ToString('o') } catch { return $Fallback }
  }
  try { return ([DateTimeOffset]::Parse([string]$Value)).UtcDateTime.ToString('o') } catch { return $Fallback }
}

function Get-NewCompletions {
  param($Known, $Since)
  $result = @()
  $sessionsPath = Join-Path $env:USERPROFILE '.codex\sessions'
  if (-not (Test-Path -LiteralPath $sessionsPath)) { return $result }
  Get-ChildItem -LiteralPath $sessionsPath -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue | ForEach-Object {
    $threadId = $null; $cwd = $null; $isSubagent = $false; $turnStart = @{}; $latestGoalStatus = $null; $lines = @()
    try { $lines = Get-Content -LiteralPath $_.FullName -ErrorAction Stop } catch { return }
    foreach ($line in $lines) {
      if ($line -notmatch '"type":"event_msg"') {
        if (-not $threadId -and $line -match '"type":"session_meta"') {
          try {
            $meta = $line | ConvertFrom-Json
            $threadId = [string]$meta.payload.id
            $cwd = [string]$meta.payload.cwd
            $isSubagent = $meta.payload.thread_source -eq 'subagent' -or [bool]$meta.payload.parent_thread_id
          } catch {}
        }
        if ($isSubagent) { break }
        continue
      }
      try { $entry = $line | ConvertFrom-Json } catch { continue }
      if (-not $threadId -and $entry.payload -and $entry.payload.thread_id) { $threadId = [string]$entry.payload.thread_id }
      $payload = $entry.payload
      if ($payload.type -eq 'task_started') { $turnStart[[string]$payload.turn_id] = Convert-CodexTime $payload.started_at ([string]$entry.timestamp) }
      elseif ($payload.type -eq 'thread_goal_updated') {
        $latestGoalStatus = [string]$payload.goal.status
        if ($latestGoalStatus -in @('paused', 'complete')) {
          $createdAt = Convert-CodexTime $payload.goal.createdAt ([string]$entry.timestamp)
          $updatedAt = Convert-CodexTime $payload.goal.updatedAt ([string]$entry.timestamp)
          $id = "$threadId`:goal`:$createdAt`:$updatedAt`:$latestGoalStatus"
          if ($Known -notcontains $id -and $updatedAt -ge $Since) {
            $result += [pscustomobject]@{ type = 'goal'; key = $id; threadId = $threadId; cwd = $cwd; status = $latestGoalStatus; createdAt = $createdAt; updatedAt = $updatedAt }
          }
        }
      }
      elseif ($payload.type -eq 'task_complete' -and -not $payload.error -and $payload.turn_id) {
        if ($latestGoalStatus -in @('active', 'paused', 'blocked')) { continue }
        $id = "$threadId`:$([string]$payload.turn_id)"
        if ($Known -contains $id) { continue }
        $at = Convert-CodexTime $payload.completed_at ([string]$entry.timestamp)
        if ($at -lt $Since) { continue }
        $result += [pscustomobject]@{ type = 'completion'; key = $id; threadId = $threadId; turnId = [string]$payload.turn_id; cwd = $cwd; startedAt = $turnStart[[string]$payload.turn_id]; completedAt = $at; durationMs = $payload.duration_ms }
      }
    }
  }
  return $result
}

if (-not $Run) {
  $currentSettings = Get-CodexProviderSettings
  $null = Get-EventEndpoint $(if ($ProxyUrl) { $ProxyUrl } else { $currentSettings.BaseUrl })
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Run"
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Output "已安装并启动: $taskName"
  exit 0
}

$state = Read-State
$state = [pscustomobject]@{
  keys = @($state.keys)
  since = if ($state.since) { [string]$state.since } else { (Get-Date).ToUniversalTime().ToString('o') }
}
Save-State $state
$lastErrorMessage = $null
while ($true) {
  try {
    $settings = Get-CodexProviderSettings
    $endpoint = if ($ProxyUrl) { Get-EventEndpoint $ProxyUrl } else { Get-EventEndpoint $settings.BaseUrl }
    $known = @($state.keys)
    $events = @(Get-NewCompletions -Known $known -Since ([string]$state.since))
    if ($events.Count -gt 0) {
      $sourceId = [Environment]::MachineName
      $body = @{ source = @{ id = $sourceId; name = $sourceId }; events = $events } | ConvertTo-Json -Depth 8
      Invoke-RestMethod -Method Post -Uri $endpoint -Headers @{ Authorization = "Bearer $($settings.ApiKey)" } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
      $state.keys = @($known + @($events | ForEach-Object { $_.key })) | Select-Object -Last 10000
      Save-State $state
    }
    $lastErrorMessage = $null
  } catch {
    if ($_.Exception.Message -ne $lastErrorMessage) {
      $lastErrorMessage = $_.Exception.Message
      $message = "$(Get-Date -Format o) $lastErrorMessage"
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
      Add-Content -LiteralPath $logPath -Value $message -Encoding UTF8
    }
  }
  Start-Sleep -Seconds $pollSeconds
}
