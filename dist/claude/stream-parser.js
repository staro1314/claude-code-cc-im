import { isContentBlockDelta, isStreamResult } from './types.js';
export function parseStreamLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function extractTextDelta(event) {
    if (isContentBlockDelta(event) && event.event.delta?.type === 'text_delta' && event.event.delta.text) {
        return { text: event.event.delta.text };
    }
    return null;
}
export function extractThinkingDelta(event) {
    if (isContentBlockDelta(event) && event.event.delta?.type === 'thinking_delta' && event.event.delta.thinking) {
        return { text: event.event.delta.thinking };
    }
    return null;
}
export function extractResult(event) {
    if (isStreamResult(event)) {
        return {
            success: event.subtype === 'success',
            result: event.result,
            accumulated: '',
            cost: event.total_cost_usd,
            durationMs: event.duration_ms,
            numTurns: event.num_turns,
            toolStats: {},
        };
    }
    return null;
}
