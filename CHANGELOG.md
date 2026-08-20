# Changelog

All notable changes to JuanProxy will be documented in this file.

The format is based on Keep a Changelog, and this project uses semantic versioning once formal releases begin.

## [Unreleased]

### Fixed

- Codex completion notifications now poll within 10 seconds and stop waiting for thread-name metadata after 3 seconds before sending with a fallback title.
- No-usable-site and recovery notifications now apply the same manual selection, rate-limit pause, and automatic multiplier-limit rules as proxy routing.
- Codex completion monitoring now separates rollout modification time from event time so delayed writes are still discovered.
- Codex task recovery now retries turns stopped by selected-model capacity errors or Responses streams that close before `response.completed`.
- Sensitive-word upstream 500 responses now retry other matching sites only for the current request without changing the globally selected site.
- Remote account sync now paginates Key lists and matches full New API keys even when the remote omits the `sk-` prefix.
- Modern-v1 Turnstile login and browser-backed WAF/Cloudflare verification are supported across manual and scheduled sync operations.
- Sessions established before metadata or browser verification failures are preserved, and WAF challenges no longer trigger unnecessary account re-login.

### Added

- Dependency-free Windows x64, macOS Apple Silicon, and macOS Intel remote Codex monitors are published as double-click installers on GitHub Releases; they follow the active Codex API configuration and report deduplicated answer and goal completion events through an independent Feishu notification switch.
- Independent Feishu Watchdog monitoring now uses event-specific card titles and provides separate switches for effective-multiplier changes, per-account low balances, prolonged lack of usable sites, program outages, ordinary Codex answers, and Codex goal completion or pause.
- Optional Codex task recovery now waits for replayable requests during temporary site outages and resumes matching stopped Windows Codex App tasks after a site recovers, controlled by one default-off switch.
- Shared remote accounts now unify credentials for the same dashboard origin and username, persist reusable login sessions, and expose explicit account logout.
- Creating a remote key now imports it immediately as a new local site while copying the source site's sync, multiplier, mapping, capability, rate-limit, and recovery settings.
- Responsive layout now uses a compact 15px desktop baseline, adds information columns on wide screens, and reflows the site workspace and forms for narrow windows.
- Sites can lock a directly entered real multiplier or derive it from the synced account multiplier times an optional custom multiplier; selection, limits, sorting, and displays now use that result.
- Desktop UI now uses a user-tool workspace with Overview, Sites, Strategy, Diagnostics, and Settings views.
- Request route trace observability now keeps recent per-request site attempts in the UI and writes sanitized `proxy.route-trace` entries to the runtime JSONL log.
- Open source project metadata, security policy, contribution guide, and CI test workflow.
- Stable application identifier `zone.huawei.juanproxy`.

### Changed

- Feishu card titles now put the notification type first, followed by the relevant thread, site, status, or multiplier change.
- Remote sync, key creation, and group switching reuse a shared account session and only log in again after an explicit `401/403` authentication failure.
- Imported and legacy sites with the same remote account identity are reconciled immediately instead of retaining duplicate account configuration.
