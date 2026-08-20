# JuanProxy Remote Codex Monitor

## 中文介绍

JuanProxy Remote Codex Monitor 是用于 Windows 和 macOS 的独立原生后台监控程序，不需要安装 Node.js、Go 或其他第三方运行时。

程序会读取当前用户 `~/.codex/config.toml` 中正在生效的 Codex 站点配置与 API key，监控本机根任务的 rollout，并向 JuanProxy 上报：

- 普通对话回答完成
- 目标完成
- 目标暂停

目标运行期间的单轮回答不会触发通知。事件会在本机持久化、去重，并在网络或飞书发送失败后重试。需要先在 JuanProxy 中开启“远程 Codex 回答或目标完成/暂停”。

安装完成后会自动打开仅限本机访问的状态界面，显示后台运行状态、最近检查、当前监控站点和具体错误，并提供“立即检查”按钮。关闭界面不会停止后台监控；再次双击同版本程序即可重新打开。

### 下载选择

| 系统 | 芯片 | 推荐下载 | 独立程序 |
| --- | --- | --- | --- |
| Windows 10/11 | x64 | `JuanProxy-Remote-Codex-Monitor-Windows-x64.zip` | `JuanProxy-Remote-Codex-Monitor-Windows-x64.exe` |
| macOS | Apple Silicon（M1/M2/M3/M4 及后续） | `JuanProxy-Remote-Codex-Monitor-macOS-Apple-Silicon.zip` | `JuanProxy-Remote-Codex-Monitor-macOS-Apple-Silicon` |
| macOS | Intel | `JuanProxy-Remote-Codex-Monitor-macOS-Intel.zip` | `JuanProxy-Remote-Codex-Monitor-macOS-Intel` |

Windows 独立 `.exe` 可以直接双击。macOS 推荐下载压缩包并双击其中的 `Install-JuanProxy-Remote-Monitor.command`；直接下载的 macOS 独立程序可能需要先在终端执行 `chmod +x 文件路径`，再运行该文件。

## English Introduction

JuanProxy Remote Codex Monitor is a standalone native background monitor for Windows and macOS. Node.js, Go, and third-party runtimes are not required.

It reads the active Codex provider configuration and API key from the current user's `~/.codex` directory, watches root-task rollout files, and reports:

- Ordinary answer completion
- Goal completion
- Goal pause

Individual turns do not generate notifications while a goal is active. Events are persisted locally, deduplicated, and retried after network or Feishu delivery failures. Enable **Remote Codex answer or goal completion/pause** in JuanProxy first.

After installation, a local-only status UI opens automatically. It shows the background process, recent checks, current endpoint, and actionable errors, and includes a **Check now** control. Closing the page does not stop monitoring; launch the same version again to reopen it.

### Downloads

| Platform | Processor | Recommended package | Standalone executable |
| --- | --- | --- | --- |
| Windows 10/11 | x64 | `JuanProxy-Remote-Codex-Monitor-Windows-x64.zip` | `JuanProxy-Remote-Codex-Monitor-Windows-x64.exe` |
| macOS | Apple Silicon (M1/M2/M3/M4 and later) | `JuanProxy-Remote-Codex-Monitor-macOS-Apple-Silicon.zip` | `JuanProxy-Remote-Codex-Monitor-macOS-Apple-Silicon` |
| macOS | Intel | `JuanProxy-Remote-Codex-Monitor-macOS-Intel.zip` | `JuanProxy-Remote-Codex-Monitor-macOS-Intel` |

The standalone Windows `.exe` can be launched directly. On macOS, the ZIP package and its `Install-JuanProxy-Remote-Monitor.command` launcher are recommended. A directly downloaded macOS executable may first require `chmod +x PATH_TO_FILE` in Terminal.
