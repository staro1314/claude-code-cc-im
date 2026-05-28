# CC-IM

> 企业微信 / 飞书 / Telegram 遥控 Claude Code CLI 的多平台桥接服务

CC-IM 让你通过手机上的企业微信、飞书或 Telegram 远程操控 Claude Code CLI。在外用手机发消息，在家用电脑直接操作——同一个 Claude 实例，随时随地访问。

```
手机企业微信/飞书/Telegram  →  CC-IM 服务  →  Claude Code CLI  →  你的电脑/服务器
```

## 使用场景

| 场景 | 说明 |
|------|------|
| **远程办公** | 在家用电脑跑 Claude Code，外出时用手机企业微信远程操控 |
| **团队协作** | 多人共享一个 Claude 实例，各自独立会话 |
| **服务器部署** | 在云服务器上运行，随时随地访问 |
| **权限管控** | 通过白名单控制谁能使用，支持逐条审批敏感操作 |

## 功能

- **多平台支持**：飞书、Telegram 和企业微信，可同时运行或单独使用
- **Channel 模式**：企业微信直连 Claude Code CLI，原生交互体验（Windows 一键启动）
- **流式输出**：飞书端使用 CardKit 打字机效果，Telegram 端通过 editMessage 实时更新，企业微信端使用 replyStream 原生流式回复
- **思考过程展示**：实时显示 Claude 的思考过程（折叠面板）
- **工具调用通知**：流式显示当前正在使用的工具及参数摘要
- **执行过程实时推送**：Channel 模式下通过 Hook + Session 文件监控，实时推送工具调用、执行结果和思考过程到企业微信
- **图片消息支持**：支持发送图片给 Claude 进行分析
- **截图自动发送**：Claude 使用截图工具后，任务完成时自动将截图上传到聊天窗口
- **话题会话**：飞书群聊话题（thread）独立会话
- **会话管理**：每用户独立 session，支持 `/new` 重置
- **并发控制**：同会话串行执行，不同会话可并发，最多排队 3 条消息
- **长消息分片**：超长内容自动拆分为多条消息
- **权限确认**：通过 Hook 机制实现工具调用的交互式审批
- **白名单**：通过环境变量或配置文件控制访问
- **停止按钮**：执行过程中可随时停止
- **工具使用统计**：完成时显示工具调用次数和类型
- **模型切换**：支持按用户和按话题粒度切换模型
- **轮次追踪**：累计对话轮次，上下文过长时自动提醒压缩
- **生命周期通知**：服务启动/关闭时通知活跃用户（含版本信息和运行时长）
- **守护进程模式**：支持 `-d` 后台运行和 `stop` 停止，`install` 注册为 systemd 开机自启服务
- **终端监控**：通过 `/watch` 命令实时监控终端 Claude Code 的运行状态（工具调用、完成事件）
- **版本更新检查**：启动时自动检查 npm 最新版本，有更新时提示
- **日志等级配置**：支持 DEBUG/INFO/WARN/ERROR 四级日志

## 懒人安装（30 秒搞定）

> 前置要求：[Node.js >= 20](https://nodejs.org/) + [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### Windows 用户（企业微信 Channel 模式）

```bash
# 1. 一键安装
npm install -g cc-im

# 2. 一键配置（自动生成快捷脚本）
cc-im setup

# 3. 双击 ~/.cc-im/启动.bat 即可使用
```

安装完成后，`~/.cc-im/` 下会自动生成：

| 脚本 | 说明 |
|------|------|
| `启动.bat` | 启动 Channel 服务 + Claude Code 客户端 |
| `停止.bat` | 停止所有相关进程 |
| `重启.bat` | 重启服务 |

### macOS / Linux 用户

```bash
npm install -g cc-im
cc-im setup
# 或手动配置环境变量后：
npx cc-im@latest
```

## 安装方式

### 方式一：npm 全局安装（推荐）

```bash
npm install -g cc-im
```

### 方式二：从 GitHub 安装

```bash
npm install -g github:staro1314/claude-code-cc-im
```

### 方式三：从源码构建

```bash
git clone https://github.com/staro1314/claude-code-cc-im.git
cd cc-im
npm install
npm run build
npm link
```

## 快速开始

### 一键配置向导

```bash
cc-im setup
```

向导会自动检测环境、Claude CLI 路径，引导你选择平台、填写凭证，最后生成配置文件和快捷脚本。

### 企业微信 Channel 模式

Channel 模式是推荐的 Windows 使用方式。它通过 Claude Code 的 MCP Channel 协议，将企业微信消息直接注入 Claude Code CLI 终端，实现原生交互体验。

**架构：**

```
企业微信  →  cc-im 服务(18790)  →  wechat-channel MCP  →  Claude Code CLI
                                                              ↓
企业微信  ←  cc-im 服务(18790)  ←  wechat-channel MCP  ←  Claude Code CLI
```

**配置步骤：**

1. 在[企业微信管理后台](https://work.weixin.qq.com)创建智能机器人应用
2. 获取机器人的 Bot ID 和 Secret
3. 配置：

```bash
# 方式一：环境变量
export WECOM_BOT_ID=your_bot_id
export WECOM_BOT_SECRET=your_bot_secret

# 方式二：配置文件 ~/.cc-im/config.json
```

```json
{
  "wecomBotId": "your_bot_id",
  "wecomBotSecret": "your_bot_secret",
  "claudeWorkDir": "D:\\project"
}
```

4. 启动：

```bash
# Windows：双击 ~/.cc-im/启动.bat
# 或手动：
cc-im channel
# 另开终端：
claude --dangerously-load-development-channels server:wechat-work
```

5. 在企业微信中给机器人发消息，Claude Code 终端会实时显示并回复

**快捷键说明：**

- 企业微信中发送 `/allow` 或 `/y` — 允许权限请求
- 企业微信中发送 `/deny` 或 `/n` — 拒绝权限请求
- 企业微信中发送 `/stop` — 停止当前任务

### 其他平台

#### 飞书平台

1. 在[飞书开放平台](https://open.feishu.cn)创建应用，开启机器人能力
2. 添加权限：`im:message`、`im:message:send_as_bot`、`im:message.group_msg`、`im:message.p2p_msg:readonly`、`im:resource`、`cardkit:card:write`
3. 事件订阅中启用**长连接模式**，订阅：`im.message.receive_v1`、`im.message.recalled_v1`
4. 回调订阅：`card.action.trigger`
5. 发布应用，配置凭证：

```bash
export FEISHU_APP_ID=your_app_id
export FEISHU_APP_SECRET=your_app_secret
npx cc-im@latest
```

#### Telegram 平台

1. 通过 [@BotFather](https://t.me/BotFather) 创建 Bot，获取 Token
2. 配置：

```bash
export TELEGRAM_BOT_TOKEN=your_bot_token
npx cc-im@latest
```

3. 在 Telegram 中找到 Bot，发送 `/start` 开始使用

### 同时运行多个平台

```bash
export FEISHU_APP_ID=xxx
export FEISHU_APP_SECRET=xxx
export TELEGRAM_BOT_TOKEN=xxx
export WECOM_BOT_ID=xxx
export WECOM_BOT_SECRET=xxx
npx cc-im@latest
```

### 守护进程模式

```bash
cc-im -d        # 后台启动
cc-im stop      # 停止服务
cc-im status    # 查看运行状态
```

### 开机自启（Linux systemd）

```bash
cc-im install   # 注册并启动服务
cc-im uninstall # 卸载服务
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `/start` | 显示欢迎信息（Telegram） |
| `/help` | 显示帮助信息 |
| `/new` | 开始新会话 |
| `/cd <path>` | 切换工作目录（同时重置会话） |
| `/pwd` | 查看当前工作目录 |
| `/list` | 列出所有项目的工作区 |
| `/cost` | 查看 Claude API 用量和费用 |
| `/status` | 查看当前会话状态 |
| `/model [name]` | 查看或切换模型（按用户/话题粒度） |
| `/doctor` | 运行 Claude 诊断 |
| `/compact [topic]` | 压缩当前对话上下文 |
| `/history [page]` | 查看当前会话的对话历史 |
| `/resume [n]` | 浏览/恢复历史会话 |
| `/watch [level]` | 监控终端 Claude Code（stop/tool/full/off） |
| `/threads` | 列出所有话题会话（飞书） |
| `/stop` | 停止当前运行的任务（企业微信） |
| `/allow` 或 `/y` | 允许权限请求（按钮不可用时的备选） |
| `/deny` 或 `/n` | 拒绝权限请求（按钮不可用时的备选） |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | 飞书平台必填 |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | 飞书平台必填 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | Telegram 平台必填 |
| `WECOM_BOT_ID` | 企业微信机器人 Bot ID | 企业微信平台必填 |
| `WECOM_BOT_SECRET` | 企业微信机器人 Secret | 企业微信平台必填 |
| `WECOM_BOT_NAME` | 企业微信机器人显示名称，用于精确去除群聊 @提及 | 空（启发式匹配） |
| `ALLOWED_USER_IDS` | 白名单用户 ID，逗号分隔，留空不限制 | 空（不限制） |
| `CLAUDE_CLI_PATH` | Claude CLI 可执行文件路径 | `claude` |
| `CLAUDE_WORK_DIR` | 默认工作目录 | 当前目录 |
| `ALLOWED_BASE_DIRS` | 允许 `/cd` 切换的基础目录，逗号分隔 | 同 `CLAUDE_WORK_DIR` |
| `CLAUDE_SKIP_PERMISSIONS` | 跳过权限检查（生产环境建议 `false`） | `false` |
| `CLAUDE_TIMEOUT_MS` | 执行超时（毫秒） | `600000`（10分钟） |
| `CLAUDE_MODEL` | 默认模型（如 `sonnet`、`opus`、`haiku`） | 空（由 Claude Code 决定） |
| `PROXY_URL` | 代理地址，传递给 Claude CLI（如 `http://127.0.0.1:7890`） | 空 |
| `HOOK_SERVER_PORT` | 权限确认 Hook 服务端口 | `18900` |
| `LOG_DIR` | 日志文件存储目录 | `~/.cc-im/logs` |
| `LOG_LEVEL` | 日志等级（`DEBUG`/`INFO`/`WARN`/`ERROR`） | `DEBUG` |

### 白名单用户 ID 格式

- **飞书**：open_id 格式，如 `ou_xxxx`
- **Telegram**：用户数字 ID，如 `123456789`（可通过 [@userinfobot](https://t.me/userinfobot) 获取）
- **企业微信**：企业微信 userid，如 `zhangsan`

## 配置文件

除环境变量外，也支持通过 `~/.cc-im/config.json` 文件配置：

```json
{
  "feishuAppId": "",
  "feishuAppSecret": "",
  "telegramBotToken": "your_bot_token",
  "wecomBotId": "",
  "wecomBotSecret": "",
  "wecomBotName": "",
  "allowedUserIds": ["123456789"],
  "claudeCliPath": "/usr/local/bin/claude",
  "claudeWorkDir": "/home/user/projects",
  "allowedBaseDirs": ["/home/user/projects", "/tmp"],
  "claudeSkipPermissions": false,
  "claudeTimeoutMs": 600000,
  "claudeModel": "sonnet",
  "proxyUrl": "http://127.0.0.1:7890",
  "hookPort": 18900,
  "logDir": "/var/log/cc-im",
  "logLevel": "INFO"
}
```

环境变量优先级高于配置文件。

## 应用数据目录

默认数据目录：`~/.cc-im`

```
~/.cc-im/
├── config.json          # 配置文件
├── 启动.bat             # Windows 快捷启动脚本
├── 停止.bat             # Windows 快捷停止脚本
├── 重启.bat             # Windows 快捷重启脚本
├── channel-registry.json # Channel 模式客户端注册表
├── data/
│   ├── sessions.json    # 会话持久化数据
│   └── active-chats.json # 活跃聊天记录（生命周期通知）
└── logs/                # 日志文件
    ├── 2026-02-14.log
    └── 2026-02-15.log
```

## 权限确认机制

### 配置 Claude CLI Hook

**必须**：在 Claude CLI 配置文件中添加 PreToolUse hook，使权限确认功能正常工作。

编辑 `~/.claude/settings.json`，在 `hooks` 中添加：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "<your-project-path>/dist/hook/hook-script.js"
          }
        ]
      }
    ]
  }
}
```

将 `<your-project-path>` 替换为实际的项目路径（使用绝对路径）。hook 脚本需要执行权限：`chmod +x dist/hook/hook-script.js`

配置修改后需要完全退出 Claude Code 会话（`exit`）并重新启动才能生效。

> 提示：运行 `cc-im setup` 可自动配置 Hook，无需手动编辑。

### 工作流程

当 `CLAUDE_SKIP_PERMISSIONS=false` 时，系统会通过 PreToolUse Hook 拦截敏感操作：

1. Claude Code 尝试调用工具（如执行 Bash 命令）
2. Hook 脚本将请求发送到权限确认服务（端口由 `HOOK_SERVER_PORT` 指定）
3. 服务向用户发送权限确认卡片
4. 用户点击卡片上的"允许"或"拒绝"按钮
5. 决定结果返回给 Claude Code，继续或中止操作

以下只读工具会自动放行，无需确认：
`Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch`、`Task`、`TodoRead`

## 在其他电脑上复刻

### 从 GitHub 克隆安装

```bash
# 1. 克隆项目
git clone https://github.com/staro1314/claude-code-cc-im.git
cd cc-im

# 2. 安装依赖并构建
npm install
npm run build

# 3. 全局链接（可选，让 cc-im 命令全局可用）
npm link

# 4. 配置
cc-im setup
# 按提示选择平台、填写凭证

# 5. 启动
# Windows：双击 ~/.cc-im/启动.bat
# Linux/Mac：cc-im 或 npx cc-im@latest
```

### 从 npm 安装

```bash
npm install -g cc-im
cc-im setup
# 双击 ~/.cc-im/启动.bat（Windows）
```

### 需要同步的配置

在新电脑上需要重新配置：

1. **企业微信凭证**：`~/.cc-im/config.json` 中的 `wecomBotId` 和 `wecomBotSecret`
2. **Claude Code CLI**：确保已安装且在 PATH 中
3. **工作目录**：`claudeWorkDir` 指向你的项目目录
4. **Claude Hook**：`~/.claude/settings.json` 中的 PreToolUse hook 配置

## 项目结构

```
src/
├── index.ts                  # 入口，多平台并行初始化
├── config.ts                 # 配置加载（环境变量 + ~/.cc-im/config.json）
├── constants.ts              # 系统常量
├── logger.ts                 # 带标签的日志系统（自动脱敏）
├── cli.ts                    # CLI 入口（前台/守护进程/systemd 服务管理）
├── access/
│   └── access-control.ts     # 白名单访问控制
├── claude/
│   ├── cli-runner.ts         # Claude CLI 子进程管理
│   ├── stream-parser.ts      # stream-json 格式解析
│   └── types.ts              # Claude 消息类型定义
├── commands/
│   └── handler.ts            # 平台无关的命令处理器
├── feishu/
│   ├── client.ts             # 飞书 SDK 初始化
│   ├── event-handler.ts      # 飞书事件处理
│   ├── message-sender.ts     # 飞书消息发送封装
│   ├── card-builder.ts       # 飞书卡片构建
│   └── cardkit-manager.ts    # CardKit 卡片生命周期管理
├── telegram/
│   ├── client.ts             # Telegraf 初始化
│   ├── event-handler.ts      # Telegram 事件处理
│   └── message-sender.ts     # Telegram 消息发送
├── wecom/
│   ├── client.ts             # 企业微信 WSClient 初始化
│   ├── event-handler.ts      # 企业微信事件处理
│   └── message-sender.ts     # 企业微信消息发送
├── channel/
│   ├── index.js              # Channel 模式入口
│   ├── bridge-server.js      # HTTP 桥接服务
│   ├── wechat-channel.js     # 企业微信 Channel MCP 服务器
│   ├── channel-registry.js   # 多客户端注册表
│   └── wecom-channel-handler.js # 企业微信 Channel 事件处理
├── hook/
│   ├── permission-server.ts  # 权限确认 HTTP 服务
│   ├── hook-script.ts        # Claude Code PreToolUse Hook
│   ├── watch-script.ts       # 监控 Hook
│   ├── watch.ts              # 监控状态管理
│   └── ensure-hook.ts        # Hook 自动配置
├── shared/
│   ├── active-chats.ts       # 活跃聊天记录
│   ├── claude-task.ts        # 共享 Claude 任务执行层
│   ├── history.ts            # 会话历史
│   ├── message-dedup.ts      # 消息去重
│   ├── update-check.ts       # 版本更新检查
│   └── utils.ts              # 共享工具函数
├── session/
│   └── session-manager.ts    # 会话管理
├── setup/
│   ├── detect.js             # 环境检测
│   ├── prompts.js            # 交互式提示
│   ├── shortcuts.js          # 快捷脚本生成
│   └── wizard.js             # 配置向导
└── queue/
    └── request-queue.ts      # 请求队列与并发控制
```

## 常见问题

### Q: 提示 "Claude Code CLI 未找到"？

确保已安装 Claude Code CLI 且在 PATH 中：

```bash
claude --version
# 如果未安装：
npm install -g @anthropic-ai/claude-code
```

### Q: 企业微信群聊中机器人不响应？

群聊中需要 @机器人才会响应。确保机器人已正确配置 Bot ID 和 Secret。

### Q: 权限确认卡片一直弹出？

检查 `~/.claude/settings.json` 中的 hooks 配置是否正确。运行 `cc-im setup` 可自动配置。

### Q: Channel 模式下 Claude CLI 窗口没关闭？

停止脚本会自动杀掉所有相关进程（Claude CLI、cc-im 服务、MCP 服务器）。如果仍有残留，手动执行：

```bash
# Windows
taskkill /FI "WINDOWTITLE eq Claude Code*" /F
taskkill /FI "WINDOWTITLE eq CC-IM*" /F

# 清理注册表
del "%USERPROFILE%\.cc-im\channel-registry.json"
```

### Q: 如何更新到最新版本？

```bash
npm update -g cc-im
```

### Q: 如何查看日志？

```bash
ls ~/.cc-im/logs/
tail -f ~/.cc-im/logs/$(date +%Y-%m-%d).log
```

## License

MIT
