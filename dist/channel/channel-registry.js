/**
 * Channel Registry
 *
 * Manages multiple channel server instances. Each Claude Code client
 * registers itself when it starts, and cc-im routes messages to the
 * correct channel based on the registry.
 *
 * Registry file: ~/.cc-im/channel-registry.json
 * Format: { "clientId": { "port": 18789, "startedAt": "...", "pid": 12345 } }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '../logger.js';

const log = createLogger('ChannelRegistry');
const APP_HOME = join(homedir(), '.cc-im');
const REGISTRY_FILE = join(APP_HOME, 'channel-registry.json');

/**
 * Read the registry from disk
 */
function readRegistry() {
    try {
        if (existsSync(REGISTRY_FILE)) {
            return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
        }
    } catch (err) {
        log.warn('Failed to read registry:', err.message);
    }
    return {};
}

/**
 * Write the registry to disk
 */
function writeRegistry(registry) {
    try {
        mkdirSync(APP_HOME, { recursive: true });
        writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    } catch (err) {
        log.error('Failed to write registry:', err.message);
    }
}

/**
 * Register a channel server instance
 *
 * @param {string} clientId - Unique identifier for this Claude Code instance
 * @param {number} port - Port the channel server is listening on
 * @returns {boolean} - true if registered successfully
 */
export function registerChannel(clientId, port) {
    const registry = readRegistry();

    // Check if port is already in use by another client
    for (const [existingId, info] of Object.entries(registry)) {
        if (info.port === port && existingId !== clientId) {
            log.warn(`Port ${port} already registered by client ${existingId}`);
            return false;
        }
    }

    registry[clientId] = {
        port,
        startedAt: new Date().toISOString(),
        pid: process.pid,
    };

    writeRegistry(registry);
    log.info(`Registered channel: ${clientId} on port ${port}`);
    return true;
}

/**
 * Unregister a channel server instance
 *
 * @param {string} clientId - Client to unregister
 */
export function unregisterChannel(clientId) {
    const registry = readRegistry();
    if (registry[clientId]) {
        delete registry[clientId];
        writeRegistry(registry);
        log.info(`Unregistered channel: ${clientId}`);
    }
}

/**
 * Get the port for a specific client
 *
 * @param {string} clientId - Client to look up
 * @returns {number|null} - Port number or null if not found
 */
export function getChannelPort(clientId) {
    const registry = readRegistry();
    return registry[clientId]?.port ?? null;
}

/**
 * Get all registered channels
 *
 * @returns {Object} - Registry of all channels
 */
export function getAllChannels() {
    return readRegistry();
}

/**
 * Get the default (first) channel port
 * Used for backward compatibility
 *
 * @returns {number|null} - Port number or null if no channels registered
 */
export function getDefaultChannelPort() {
    const registry = readRegistry();
    const channels = Object.values(registry);
    return channels.length > 0 ? channels[0].port : null;
}

/**
 * Remove stale entries (processes that are no longer running)
 *
 * @returns {number} - Number of entries removed
 */
export function cleanupRegistry() {
    const registry = readRegistry();
    let removed = 0;

    for (const [clientId, info] of Object.entries(registry)) {
        try {
            // Check if process is still running
            process.kill(info.pid, 0);
        } catch {
            // Process is not running, remove entry
            delete registry[clientId];
            removed++;
            log.info(`Removed stale channel: ${clientId} (PID ${info.pid} not running)`);
        }
    }

    if (removed > 0) {
        writeRegistry(registry);
    }

    return removed;
}
