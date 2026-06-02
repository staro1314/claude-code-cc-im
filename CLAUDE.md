# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CC-IM is a multi-platform bot bridge that lets you remotely control Claude Code CLI from WeChat Work (企业微信), Feishu (飞书), or Telegram. It spawns Claude CLI as a subprocess, parses its stream-json output, and relays messages bidirectionally between IM platforms and Claude.

## Commands

```bash
# Install dependencies (uses pnpm)
pnpm install

# Build (TypeScript → dist/)
pnpm run build

# Dev mode (watch with tsx)
pnpm run dev

# Lint (biome)
pnpm run lint

# Run tests
pnpm test

# Run single test file
pnpm test -- tests/some.test.ts

# Start built service
pnpm start

# CLI commands
cc-im setup          # Interactive configuration wizard
cc-im channel        # Start WeChat Work Channel mode (Windows recommended)
cc-im -d             # Daemon mode (background)
cc-im stop           # Stop daemon
cc-im status         # Check daemon status
```

## Architecture

### Core Flow

```
IM Platform → Platform Client → Event Handler → Claude Task → CLI Runner → Claude CLI subprocess
                                                                                    ↓
IM Platform ← Message Sender ← Stream Parser ← stdout (stream-json) ←──────────────┘
```

### Key Modules

- **`index.ts`** — Entry point. Loads config, initializes all enabled platforms in parallel, starts hook server.
- **`config.ts`** — Loads config from env vars + `~/.cc-im/config.json`. Env vars take precedence.
- **`claude/cli-runner.ts`** — Spawns Claude CLI with `--output-format stream-json --verbose`. Handles session resume, model selection, timeout, proxy.
- **`claude/stream-parser.ts`** — Parses Claude's stream-json output: extracts text deltas, thinking deltas, tool calls, and results.
- **`shared/claude-task.ts`** — Shared execution layer used by all platforms. Manages the lifecycle of a Claude CLI invocation.
- **`session/session-manager.ts`** — Per-user session tracking. Each user gets an independent Claude session (session ID for `--resume`).
- **`queue/request-queue.ts`** — Concurrency control. Same-session requests are serialized; different sessions can run concurrently. Max 3 queued messages per session.

### Platform Modules (feishu/, telegram/, wecom/)

Each platform has three files:
- **`client.ts`** — SDK initialization and connection setup
- **`event-handler.ts`** — Incoming message handling, command routing, @mention stripping
- **`message-sender.ts`** — Outgoing message formatting and delivery

### Channel Mode (`channel/`)

An MCP (Model Context Protocol) server that bridges WeChat Work directly into Claude Code CLI via the channels protocol. Used on Windows with `claude --dangerously-load-development-channels server:wechat-work`.

- **`wechat-channel.js`** — MCP server exposing `reply` and `permission` tools to Claude
- **`bridge-server.js`** — HTTP bridge between cc-im service and the MCP channel
- **`channel-registry.js`** — Multi-client registry for concurrent channel instances

### Hook System (`hook/`)

- **`hook-script.js`** — Claude Code PreToolUse hook. Intercepts tool calls and forwards to permission server for interactive approval.
- **`permission-server.ts`** — HTTP server (default port 18900) that sends permission cards to IM platforms and waits for user decision.
- **`watch-script.js`** — Monitoring hook for `/watch` command (tracks tool calls and completion events).
- **`ensure-hook.ts`** — Auto-configures hooks in `~/.claude/settings.json`.

### Data Storage

All persistent data lives in `~/.cc-im/`:
- `config.json` — Configuration
- `data/sessions.json` — Session persistence
- `data/active-chats.json` — Active chat records for lifecycle notifications
- `logs/` — Daily log files
- `claude-raw/latest.jsonl` — Raw Claude CLI output for monitoring

## Key Patterns

- **Platform abstraction**: All platforms share the same Claude task execution layer (`shared/claude-task.ts`) and session management. Platform-specific code only handles IM protocol details.
- **Streaming**: Feishu uses CardKit for typewriter effect, Telegram uses `editMessage` for real-time updates, WeChat Work uses `replyStream` for native streaming.
- **Permission flow**: Hook script → HTTP POST to permission server → IM card with allow/deny buttons → user clicks → decision returned to Claude CLI.
- **Message dedup**: `shared/message-dedup.ts` prevents duplicate processing of the same message (common with webhooks).
- **Long message splitting**: Messages exceeding platform limits are automatically split into multiple messages.

## Environment Variables

Key variables (see README.md for full list):
- `WECOM_BOT_ID` / `WECOM_BOT_SECRET` — WeChat Work credentials
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` — Feishu credentials
- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `CLAUDE_CLI_PATH` — Path to Claude CLI (default: `claude`)
- `CLAUDE_WORK_DIR` — Default working directory for Claude
- `CLAUDE_TIMEOUT_MS` — Execution timeout (default: 600000 / 10 min)
- `LOG_LEVEL` — DEBUG/INFO/WARN/ERROR

## Development Notes

- Source is TypeScript compiled to `dist/`. The `src/` directory is not in the repo (only compiled JS).
- Uses ES modules (`"type": "module"` in package.json).
- Package manager is pnpm (v10.28.0).
- Node.js >= 20 required.
- The `channel/` subdirectory contains some `.js` files (not TypeScript) that are MCP server entry points.
