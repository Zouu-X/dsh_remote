# DSH Remote

通过你的私有 Tailscale 网络（tailnet），用手机控制运行在 Mac 上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent。

> **独立的社区项目。** DSH Remote 与 DeepSeek 无关，也未获得其背书。
>
> **状态：** 早期单用户版本。它可以在你自己的 Mac 上正常工作，但不是多用户 SaaS 产品。

[English](README.md)

## 它能做什么

DSH Remote 让 DeepSeek Harness 始终只监听 `127.0.0.1`，并通过私有 Tailscale 连接在手机端提供一个移动友好的 PWA：

- 面向手机的 **Hosts、Tasks、Approvals、Review** 四个页面
- 创建工作区和 Session、发送任务、向运行中的 Session 追加指令
- 实时查看 Agent 消息、工具调用、终端输出、Diff 和测试结果
- 回答 Agent 提问，批准或拒绝一次性权限申请
- 支持离线 PWA 壳、断线重连、事件去重和缺口回填
- 用户级 LaunchAgent，随 Mac 启动，并跟随手动管理的 Harness
- 基于 Tailscale 对端身份的设备识别，支持可选设备白名单

## 架构

```text
手机 PWA
  │  经 Tailscale 的 HTTPS/WSS
  ▼
Mac 上的 Tailscale Serve  （https://<你的-Mac>.<你的-tailnet>.ts.net:443）
  │  TLS 终止 + PROXY protocol
  ▼
Remote Host Adapter  127.0.0.1:3090  （手机 UI + 版本化 Remote RPC/事件）
  │  仅放行白名单方法
  ▼
DeepSeek Harness Adapter
  │
  ▼
DeepSeek Harness Web  127.0.0.1:3080  （仅 loopback）
  ▼
工作区 / Agent Loop / Shell / 文件
```

## 安全模型

- DeepSeek Harness 和 Remote Host Adapter 都只监听 loopback，不绑定 `0.0.0.0`，不暴露公网。
- 只有 Tailscale Serve 可以访问 Remote Host Adapter。
- Harness 的 `--trusted-host` 只用于可达性/来源保护，不当作身份认证。
- 从不信任客户端提交的身份 header。来源 IP 来自 Tailscale Serve 的 PROXY protocol，再通过 `tailscale status --json` 解析成设备身份。
- Remote Host 只代理固定白名单中的 RPC 方法；`settings.*`、`credentials.*`、目录/文件选择器、Preset 修改等高权限 loopback 方法永远返回 `forbidden`。
- 设备私钥保存在 macOS Keychain。本项目从不读取、记录或迁移 DeepSeek API Key，它继续保留在 Harness 自己的凭据文件中。
- 当前版本**不包含**设备吊销、二维码配对、云中继和推送通知。请自行保护好你的 tailnet。

## 环境要求

- macOS（项目使用了 LaunchAgent、Keychain 和 `caffeinate`）
- Node.js 24+ 和 pnpm 11（通常执行 `corepack enable` 即可）
- 已配置 DeepSeek API 凭据的 DeepSeek Harness（见 [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)）。DSH Remote 不接触该凭据
- **Mac 和手机都必须安装 Tailscale、登录到同一 tailnet，并启用 MagicDNS。** 这是必须项：手机只通过你的私有 Tailscale 网络连接，不会经过公网。
- 安装了 Tailscale 并登录到同一 tailnet 的手机

## 一键安装（推荐）

### 1. 安装并登录 Tailscale

在 Mac 上：

```bash
brew install --cask tailscale
open -a Tailscale
tailscale up
```

如果安装后找不到 `tailscale` 命令，请打开 Tailscale 应用并从菜单栏图标登录。

在手机上，从 App Store / Play Store 安装 Tailscale，并用同一账号登录。

在 [Tailscale 管理控制台](https://login.tailscale.com/admin/dns)中，确保你的 tailnet 已启用 **MagicDNS**。

### 2. 克隆仓库并运行一键安装脚本

```bash
git clone https://github.com/Zouu-X/dsh_remote.git dsh-remote
cd dsh-remote
./macos/launch-agent/setup.sh
```

脚本会检查/安装依赖、协助登录 Tailscale、安装 Node 依赖、构建 PWA、以“手动管理 Harness + 自动跟随”模式安装 Remote Host LaunchAgent、配置 Tailscale Serve，并打印手机访问地址。

### 3. 手动启动 DeepSeek Harness

安装脚本会打印适用于你 Mac 的准确命令，形如：

```bash
npx @deepseek-ai/dsh web --trusted-host <你的-Mac>.<你的-tailnet>.ts.net
```

保持它运行即可，Remote Host LaunchAgent 会自动跟随 `127.0.0.1:3080`。

### 4. 在手机上打开应用

在手机上打开脚本打印的 `https://<你的-Mac>.<你的-tailnet>.ts.net`，并添加到主屏幕。

---

## 手动快速开始

### 1. 安装依赖并构建

```bash
git clone https://github.com/Zouu-X/dsh_remote.git dsh-remote
cd dsh-remote
corepack pnpm install
corepack pnpm -r build
```

### 2. 获取 Mac 的 Tailscale 主机名

```bash
DSH_TS_HOST=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
echo "$DSH_TS_HOST"
```

应看到类似 `your-mac.your-tailnet.ts.net` 的名称。

### 3. 在 loopback 上启动 DeepSeek Harness

在单独的终端中运行：

```bash
npx @deepseek-ai/dsh web --trusted-host "$DSH_TS_HOST"
```

保持它运行。LaunchAgent 默认跟随你手动管理的 Harness。如果想自动监督运行，见[可选的 Harness 监督器](#可选的-harness-监督器)。

### 4. 安装 Remote Host LaunchAgent

```bash
macos/launch-agent/install.sh
```

这会安装一个用户级 LaunchAgent（不是 root daemon）。它会等待 `127.0.0.1:3080` 上的 Harness，然后启动监听 `127.0.0.1:3090` 的 Remote Host Adapter。

### 5. 让 Tailscale Serve 指向 Remote Host

```bash
# 可选：先关闭旧的 HTTPS serve 配置。
tailscale serve --https=443 off 2>/dev/null || true

tailscale serve --bg --yes --tls-terminated-tcp=443 --proxy-protocol=1 3090
tailscale serve status
```

也可以使用项目自带脚本：

```bash
macos/launch-agent/configure-tailscale-serve.sh
```

### 6. 在手机上打开应用

在连接到同一 tailnet 的手机上打开：

```text
https://<你的-Mac>.<你的-tailnet>.ts.net
```

添加到主屏幕即可作为 PWA 使用。

## 设备白名单

默认情况下，同一 tailnet 中所有已登录设备都能访问 Remote Host。如果希望设置更严格，可以只允许你的手机：

```bash
# 查看手机的 Tailscale 节点 ID。
tailscale status

# 按节点 ID 允许一个设备。
macos/launch-agent/devices.sh add <tailscale-device-id>

# 查看当前白名单。
macos/launch-agent/devices.sh list

# 恢复为“允许同一 tailnet 中所有设备”。
macos/launch-agent/devices.sh allow-all
```

修改后脚本会自动重启 LaunchAgent 使其生效。

## 配置

`install.sh` 读取以下环境变量。你可以在运行前 export，也可以把 `macos/launch-agent/launch-agent.env.example` 复制为 `macos/launch-agent/launch-agent.env` 后编辑。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DSH_REMOTE_HARNESS_URL` | `http://127.0.0.1:3080` | Harness HTTP 基地址 |
| `DSH_REMOTE_PORT` | `3090` | Remote Host Adapter 监听端口 |
| `DSH_REMOTE_STATIC_DIR` | `<repo>/apps/mobile-web/dist` | Host 提供的内置 PWA 文件 |
| `DSH_REMOTE_STATE_FILE` | `~/.dsh-remote/host-state.json` | 持久化的 Mac Host 身份 |
| `DSH_REMOTE_ALLOWED_DEVICE_IDS` | 空 | 逗号分隔的 Tailscale 设备 ID；为空表示允许同一 tailnet 中所有设备 |
| `DSH_REMOTE_IDENTITY_PROVIDER` | `tailscale` | `tailscale` 通过 `tailscale status --json` 解析对端；`none` 禁用非 loopback 远程访问 |
| `DSH_REMOTE_SECRET_STORE` | `mac-keychain` | 在 Keychain 中保存 Host 设备私钥；测试时可设为 `none` |
| `DSH_REMOTE_CAFFEINATE` | 安装后的 LaunchAgent 默认为 `auto`（手动 CLI 启动默认为 `off`） | `auto` 表示仅在有 Session 运行时防止 Mac 睡眠 |
| `DSH_REMOTE_TRUSTED_HOST` | 自动检测 | 传给可选 Harness 监督器的 MagicDNS 名称 |
| `DSH_REMOTE_HARNESS_POLL_SECONDS` | `15` | LaunchAgent 检查 Harness 是否可用的间隔 |
| `DSH_INSTALL_HARNESS_SUPERVISOR` | `0` | 设为 `1` 时安装可选的 Harness 监督器 |
| `DSH_REMOTE_NODE` | 安装时的 `node` 路径 | LaunchAgent 使用的 Node 可执行文件 |

Remote Host CLI 也接受同名的命令行参数：

```bash
node packages/remote-host/dist/cli.js --help
```

## 可选的 Harness 监督器

如果你不想手动管理 Harness：

```bash
DSH_INSTALL_HARNESS_SUPERVISOR=1 macos/launch-agent/install.sh
```

只有当 `127.0.0.1:3080` 没有服务监听时，监督器才会启动 `dsh web`。默认的手动管理方式在升级期间更不容易出现意外。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `apps/mobile-web` | 手机 PWA（React + Vite） |
| `packages/remote-protocol` | 版本化的 RPC/事件信封与编解码 |
| `packages/remote-domain` | Host/Session/Approval/Review 领域模型 |
| `packages/remote-client` | `AgentHostTransport` + Tailscale 传输实现 |
| `packages/remote-host` | Loopback Remote Host HTTP/WebSocket 服务 |
| `packages/auth-core` | `RemotePrincipal`、能力与 RPC 白名单 |
| `packages/adapter-deepseek` | 唯一与 DeepSeek Harness 通信的包 |
| `macos/launch-agent` | 一键安装、LaunchAgent 模板、安装器、设备管理、Tailscale Serve 助手 |
| `tools/` | 连通性测试与 Remote Host 自检工具 |

## Remote API 边界

Remote Host 只代理 `packages/auth-core` 中声明的方法（`host.describe`、`workspace.list`、`workspace.create`、`session.list`、`session.search`、`session.create`、`session.history`、`session.prompt`、`session.updateQueue`、`session.cancel`、`approval.respond`、`question.respond`）。

`settings.*`、`credentials.*`、目录选择器、文件打开和 Preset 修改在远程永远返回 `forbidden`。

## 开发

```bash
corepack pnpm install
corepack pnpm -r typecheck
corepack pnpm -r test
corepack pnpm -r build

# 本地手机开发服务器（127.0.0.1:5173）
corepack pnpm dev:mobile

# 连接运行中的 Harness，本地启动 Host
corepack pnpm dev:host
```

连通性测试：

```bash
# 先执行 pnpm -r build，然后本地测试 Remote Host
node tools/remote-host-check/check.mjs --base http://127.0.0.1:3090

# 经 Tailscale Serve 测试 Remote Host
node tools/remote-host-check/check.mjs --base https://<你的-Mac>.<你的-tailnet>.ts.net
```

## 已知限制

- 单用户 tailnet 模型。还没有账号系统、设备吊销界面、二维码配对、云中继或推送通知。
- 主要在 iOS 上验证过。Android 应可通过 PWA 使用，但尚未完成完整的真机 QA。
- DeepSeek Harness 仍处于早期阶段，其网络接口可能变化；所有 DeepSeek Harness 调用都隔离在 `packages/adapter-deepseek`。
- 当前版本不会替代 DeepSeek Harness 中已配置的 Agent sandbox 和审批策略。

## 许可证

[MIT](LICENSE)

DeepSeek Harness 和 DeepSeek 是其各自所有者的商标或注册商标。
