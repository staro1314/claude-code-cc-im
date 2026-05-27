import { writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { APP_HOME } from '../constants.js';
import { runChecks, detectClaudeCliPath, detectWorkDir } from './detect.js';
import { generateShortcuts } from './shortcuts.js';
import { input, confirm, multiSelect, closePrompts, separator, success, error, info } from './prompts.js';

const CONFIG_PATH = join(APP_HOME, 'config.json');

/**
 * 打印欢迎横幅
 */
function printBanner() {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         CC-IM Setup Wizard               ║');
    console.log('║    企业微信遥控 Claude Code CLI          ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
}

/**
 * 步骤 0: 环境检测
 */
function checkEnvironment() {
    console.log('[1/10] 环境检测...\n');
    const { allPassed, results } = runChecks();
    for (const r of results) {
        if (r.ok) {
            success(`${r.name}: ${r.message}`);
        } else {
            error(`${r.name}: ${r.message}`);
            if (r.fix) info(`  修复方法: ${r.fix}`);
        }
    }
    console.log('');
    if (!allPassed) {
        error('环境检测未通过，请先安装缺失的依赖');
        console.log('');
    }
    return allPassed;
}

/**
 * 步骤 1: 检测 Claude CLI 路径
 */
async function setupClaudePath(existing) {
    console.log('[2/10] Claude CLI 路径\n');
    const detected = detectClaudeCliPath();
    const defaultVal = existing?.claudeCliPath || detected || '';
    if (detected) {
        info(`检测到: ${detected}`);
    }
    const value = await input('Claude CLI 路径', defaultVal);
    console.log('');
    return value;
}

/**
 * 步骤 2: 工作目录
 */
async function setupWorkDir(existing) {
    console.log('[3/10] 工作目录\n');
    const defaultVal = existing?.claudeWorkDir || detectWorkDir();
    info(`Claude Code 将在此目录下工作`);
    const value = await input('工作目录', defaultVal);
    console.log('');
    return value;
}

/**
 * 步骤 3: 选择平台
 */
async function setupPlatforms(existing) {
    console.log('[4/10] 选择消息平台\n');
    const platforms = ['企业微信 (WeCom)', '飞书 (Feishu)', 'Telegram'];

    // 根据已有配置预选
    const preSelected = [];
    if (existing?.wecomBotId) preSelected.push('企业微信 (WeCom)');
    if (existing?.feishuAppId) preSelected.push('飞书 (Feishu)');
    if (existing?.telegramBotToken) preSelected.push('Telegram');

    let selected;
    if (preSelected.length > 0) {
        info(`当前已配置: ${preSelected.join(', ')}`);
        const keep = await confirm('保留当前平台配置?', true);
        if (keep) {
            selected = preSelected;
        } else {
            selected = await multiSelect('选择要配置的平台:', platforms);
        }
    } else {
        selected = await multiSelect('选择要配置的平台:', platforms);
    }
    console.log('');
    return selected;
}

/**
 * 步骤 4: 企业微信凭证
 */
async function setupWeCom(existing) {
    console.log('[5/10] 企业微信配置\n');
    info('在企业微信管理后台 > 应用管理 > 机器人 中获取');
    console.log('');

    const botId = await input('Bot ID', existing?.wecomBotId || '');
    const botSecret = await input('Bot Secret', existing?.wecomBotSecret || '');
    const botName = await input('Bot 名称 (可选)', existing?.wecomBotName || '');
    console.log('');

    return { wecomBotId: botId, wecomBotSecret: botSecret, wecomBotName: botName || undefined };
}

/**
 * 步骤 4: 飞书凭证
 */
async function setupFeishu(existing) {
    console.log('[5/10] 飞书配置\n');
    info('在飞书开放平台 > 应用凭证 中获取');
    console.log('');

    const appId = await input('App ID', existing?.feishuAppId || '');
    const appSecret = await input('App Secret', existing?.feishuAppSecret || '');
    console.log('');

    return { feishuAppId: appId, feishuAppSecret: appSecret };
}

/**
 * 步骤 4: Telegram 凭证
 */
async function setupTelegram(existing) {
    console.log('[5/10] Telegram 配置\n');
    info('通过 @BotFather 创建机器人获取 Token');
    console.log('');

    const token = await input('Bot Token', existing?.telegramBotToken || '');
    console.log('');

    return { telegramBotToken: token };
}

/**
 * 步骤 5: 高级选项
 */
async function setupAdvanced(existing) {
    console.log('[6/10] 高级选项\n');

    const skipPermissions = await confirm(
        '跳过权限确认? (推荐开启，Claude 执行命令时不再逐个询问)',
        existing?.claudeSkipPermissions ?? true
    );

    const timeoutStr = await input(
        '执行超时 (毫秒)',
        String(existing?.claudeTimeoutMs ?? 600000)
    );
    const timeoutMs = parseInt(timeoutStr, 10) || 600000;

    const proxyUrl = await input('代理 URL (可选，留空跳过)', existing?.proxyUrl || '');
    console.log('');

    return {
        claudeSkipPermissions: skipPermissions,
        claudeTimeoutMs: timeoutMs,
        proxyUrl: proxyUrl || undefined,
    };
}

/**
 * 步骤 6: 允许的用户 ID
 */
async function setupAllowedUsers(existing) {
    console.log('[7/10] 用户访问控制\n');
    info('留空表示允许所有用户（开发模式）');
    info('多个用户 ID 用逗号分隔');
    console.log('');

    const current = (existing?.allowedUserIds || []).join(', ');
    const inputVal = await input('允许的用户 ID', current);
    const allowedUserIds = inputVal
        ? inputVal.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    console.log('');

    return { allowedUserIds };
}

/**
 * 步骤 7: 预览配置
 */
async function reviewConfig(config) {
    console.log('[8/10] 配置预览\n');
    separator();
    console.log(`  Claude CLI:  ${config.claudeCliPath}`);
    console.log(`  工作目录:    ${config.claudeWorkDir}`);
    console.log(`  跳过权限:    ${config.claudeSkipPermissions ? '是' : '否'}`);
    console.log(`  超时:        ${config.claudeTimeoutMs}ms`);
    if (config.proxyUrl) console.log(`  代理:        ${config.proxyUrl}`);
    if (config.wecomBotId) console.log(`  企业微信:    已配置`);
    if (config.feishuAppId) console.log(`  飞书:        已配置`);
    if (config.telegramBotToken) console.log(`  Telegram:    已配置`);
    if (config.allowedUserIds?.length > 0) {
        console.log(`  允许用户:    ${config.allowedUserIds.join(', ')}`);
    } else {
        console.log(`  允许用户:    所有人`);
    }
    separator();
    console.log('');

    return await confirm('保存此配置?', true);
}

/**
 * 主向导流程
 */
export async function runSetup() {
    printBanner();

    // 读取已有配置
    let existing = null;
    if (existsSync(CONFIG_PATH)) {
        try {
            existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
            info('检测到已有配置文件');
            console.log('');
        } catch { /* ignore */ }
    }

    // 步骤 0: 环境检测
    if (!checkEnvironment()) {
        closePrompts();
        process.exit(1);
    }

    // 步骤 1: Claude CLI 路径
    const claudeCliPath = await setupClaudePath(existing);

    // 步骤 2: 工作目录
    const claudeWorkDir = await setupWorkDir(existing);

    // 步骤 3: 选择平台
    const selectedPlatforms = await setupPlatforms(existing);

    // 步骤 4: 平台凭证
    const platformConfig = {};
    for (const platform of selectedPlatforms) {
        if (platform.includes('企业微信')) {
            Object.assign(platformConfig, await setupWeCom(existing));
        } else if (platform.includes('飞书')) {
            Object.assign(platformConfig, await setupFeishu(existing));
        } else if (platform.includes('Telegram')) {
            Object.assign(platformConfig, await setupTelegram(existing));
        }
    }

    // 步骤 5: 高级选项
    const advancedConfig = await setupAdvanced(existing);

    // 步骤 6: 用户访问控制
    const accessConfig = await setupAllowedUsers(existing);

    // 合并配置（保留已有配置中未修改的字段）
    const config = {
        ...(existing || {}),
        ...platformConfig,
        ...advancedConfig,
        ...accessConfig,
        claudeCliPath,
        claudeWorkDir,
        allowedBaseDirs: existing?.allowedBaseDirs || [claudeWorkDir],
    };

    // 步骤 7: 预览确认
    const confirmed = await reviewConfig(config);
    if (!confirmed) {
        info('已取消');
        closePrompts();
        return;
    }

    // 步骤 8: 写入配置
    console.log('[9/10] 保存配置...\n');
    try {
        if (existsSync(CONFIG_PATH)) {
            copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
            info('已备份旧配置为 config.json.bak');
        }
        if (!existsSync(APP_HOME)) {
            const { mkdirSync } = await import('node:fs');
            mkdirSync(APP_HOME, { recursive: true });
        }
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        success(`配置已写入: ${CONFIG_PATH}`);
    } catch (e) {
        error(`写入配置失败: ${e.message}`);
        closePrompts();
        process.exit(1);
    }

    // 步骤 9: 生成快捷脚本
    console.log('\n[10/10] 生成快捷脚本...\n');
    try {
        const { generated, total, dir } = generateShortcuts();
        success(`已生成 ${generated}/${total} 个快捷脚本到 ${dir}`);
    } catch (e) {
        error(`生成脚本失败: ${e.message}`);
    }

    console.log('');
    separator();
    console.log('');
    success('配置完成!');
    console.log('');
    info('启动服务: 双击 ~/.cc-im/启动.bat 或运行 cc-im start');
    info('监控模式: 双击 ~/.cc-im/监控模式.bat');
    console.log('');

    // 询问是否立即启动
    const startNow = await confirm('现在启动服务?', false);
    if (startNow) {
        console.log('');
        info('正在启动 cc-im 服务...');
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'cli.js'), 'start'], {
            stdio: 'inherit',
            detached: true,
        });
        child.unref();
    }

    closePrompts();
}
