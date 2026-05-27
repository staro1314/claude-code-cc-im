import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let rl = null;

function getRl() {
    if (!rl) {
        rl = createInterface({ input: stdin, output: stdout });
    }
    return rl;
}

export function closePrompts() {
    if (rl) {
        rl.close();
        rl = null;
    }
}

/**
 * 带默认值的输入提示
 */
export async function input(question, defaultValue = '') {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    const answer = await getRl().question(`${question}${suffix}: `);
    const trimmed = answer.trim();
    return trimmed || defaultValue;
}

/**
 * Y/n 确认
 */
export async function confirm(question, defaultValue = true) {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = await getRl().question(`${question} [${hint}]: `);
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '') return defaultValue;
    return trimmed === 'y' || trimmed === 'yes';
}

/**
 * 多选（输入逗号分隔的序号）
 */
export async function multiSelect(question, options) {
    console.log(`\n${question}`);
    options.forEach((opt, i) => {
        console.log(`  ${i + 1}. ${opt}`);
    });
    console.log(`  (输入序号，逗号分隔，如: 1,3)`);

    while (true) {
        const answer = await getRl().question('> ');
        const trimmed = answer.trim();
        if (trimmed === '') {
            console.log('  至少选择一项');
            continue;
        }
        if (trimmed.toLowerCase() === 'a') {
            return [...options];
        }
        const indices = trimmed.split(',').map(s => parseInt(s.trim(), 10));
        const selected = [];
        let valid = true;
        for (const idx of indices) {
            if (isNaN(idx) || idx < 1 || idx > options.length) {
                console.log(`  无效序号: ${idx}，请输入 1-${options.length}`);
                valid = false;
                break;
            }
            selected.push(options[idx - 1]);
        }
        if (valid && selected.length > 0) {
            return [...new Set(selected)];
        }
    }
}

/**
 * 打印分隔线
 */
export function separator() {
    console.log('─'.repeat(50));
}

/**
 * 打印成功消息
 */
export function success(msg) {
    console.log(`  ✓ ${msg}`);
}

/**
 * 打印错误消息
 */
export function error(msg) {
    console.log(`  ✗ ${msg}`);
}

/**
 * 打印信息消息
 */
export function info(msg) {
    console.log(`  → ${msg}`);
}
