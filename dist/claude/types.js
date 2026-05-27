export function isStreamInit(event) {
    return event.type === 'system' && 'subtype' in event && event.subtype === 'init';
}
export function isContentBlockDelta(event) {
    return (event.type === 'stream_event' &&
        'event' in event &&
        typeof event.event === 'object' &&
        event.event !== null &&
        'type' in event.event &&
        event.event.type === 'content_block_delta');
}
export function isStreamResult(event) {
    return event.type === 'result' && 'subtype' in event;
}
export function isContentBlockStart(event) {
    return (event.type === 'stream_event' &&
        'event' in event &&
        typeof event.event === 'object' &&
        event.event !== null &&
        'type' in event.event &&
        event.event.type === 'content_block_start');
}
export function isContentBlockStop(event) {
    return (event.type === 'stream_event' &&
        'event' in event &&
        typeof event.event === 'object' &&
        event.event !== null &&
        'type' in event.event &&
        event.event.type === 'content_block_stop');
}
