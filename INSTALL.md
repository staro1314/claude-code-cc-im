# cc-im 安装配置指南

## 1. 克隆仓库
```bash
git clone https://github.com/staro1314/claude-code-cc-im.git
cd claude-code-cc-im
```

## 2. 安装依赖
```bash
npm install
```

## 3. 配置环境变量
复制 `.env.example` 为 `.env`，填入以下配置：
```bash
# 企业微信机器人配置
WECOM_BOT_ID=your_bot_id
WECOM_BOT_SECRET=your_bot_secret

# Claude Code 配置
CLAUDE_CLI_PATH=path/to/claude
CLAUDE_WORK_DIR=path/to/your/project
```

## 4. 配置 Claude Code Hook
在 Claude Code 的 settings.json 中添加：
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"path/to/cc-im/dist/hook/hook-script.js\""
          }
        ]
      }
    ]
  }
}
```

## 5. 启动服务
```bash
# 方式一：直接启动
npm start

# 方式二：使用启动脚本（Windows）
启动.bat
```

## 6. 功能说明
- 权限确认卡片会自动发送 frame 展示完整详情
- 支持 Edit、Bash、Write 等工具的权限确认
- 企业微信消息会实时推送到聊天窗口

## 7. 注意事项
- 需要 Node.js >= 20
- 需要预先安装 Claude Code CLI
- 企业微信机器人需要在管理后台配置权限

## 8. 配置文件说明

### config.json
复制 `config.example.json` 为 `config.json`，填入实际配置：
```bash
cp config.example.json config.json
```

配置项说明：
- `claudeWorkDir`: Claude Code 工作目录
- `allowedBaseDirs`: 允许访问的目录列表
- `claudeCliPath`: Claude Code CLI 路径
- `wecomBotId`: 企业微信机器人 ID
- `wecomBotSecret`: 企业微信机器人 Secret
- `claudeSkipPermissions`: 是否跳过权限检查（建议 true）

### 启动脚本
- `启动.bat`: Windows 启动脚本（自动检测路径）
- `停止.bat`: Windows 停止脚本
- `重启.bat`: Windows 重启脚本

## 9. 验证安装
1. 启动服务后，在企业微信中发送消息测试
2. 触发 Edit/Bash 等工具，检查权限确认卡片是否正常显示
3. 查看日志文件 `~/.cc-im/logs/` 确认服务运行状态
