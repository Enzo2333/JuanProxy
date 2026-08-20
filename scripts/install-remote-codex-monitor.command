#!/bin/zsh
set -u

cd "$(dirname "$0")"
chmod +x ./JuanProxy-Remote-Codex-Monitor
xattr -d com.apple.quarantine ./JuanProxy-Remote-Codex-Monitor 2>/dev/null || true
./JuanProxy-Remote-Codex-Monitor
status=$?
echo
read "?按 Enter 关闭..."
exit $status
