import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { createLogger } from '../logger.js';
import { APP_HOME } from '../constants.js';
const log = createLogger('Session');
const SESSIONS_FILE = join(APP_HOME, 'data', 'sessions.json');
function isUserSession(val) {
    if (typeof val !== 'object' || val === null)
        return false;
    const obj = val;
    return typeof obj.workDir === 'string';
}
export class SessionManager {
    sessions = new Map();
    convSessionMap = new Map(); // userId:convId -> sessionId
    rootMsgIndex = new Map(); // rootMessageId -> location
    static MAX_CONV_SESSION_MAP_SIZE = 200;
    defaultWorkDir;
    allowedBaseDirs;
    saveTimer = null;
    static SAVE_DEBOUNCE_MS = 500;
    constructor(defaultWorkDir, allowedBaseDirs) {
        this.defaultWorkDir = defaultWorkDir;
        this.allowedBaseDirs = allowedBaseDirs;
        this.load();
    }
    getSessionId(userId) {
        return this.sessions.get(userId)?.sessionId;
    }
    setSessionId(userId, sessionId) {
        const session = this.sessions.get(userId);
        if (session) {
            session.sessionId = sessionId;
        }
        else {
            this.sessions.set(userId, { sessionId, workDir: this.defaultWorkDir });
        }
        this.save();
    }
    generateConvId() {
        return randomBytes(4).toString('hex');
    }
    getConvId(userId) {
        const session = this.sessions.get(userId);
        if (session) {
            if (!session.activeConvId) {
                session.activeConvId = this.generateConvId();
                this.save();
            }
            return session.activeConvId;
        }
        const convId = this.generateConvId();
        this.sessions.set(userId, { workDir: this.defaultWorkDir, activeConvId: convId });
        this.save();
        return convId;
    }
    getSessionIdForConv(userId, convId) {
        // 如果是当前活跃 convId，直接从 session 读
        const session = this.sessions.get(userId);
        if (session?.activeConvId === convId) {
            return session.sessionId;
        }
        // 否则从 convSessionMap 读（旧 convId 的 sessionId）
        return this.convSessionMap.get(`${userId}:${convId}`);
    }
    setSessionIdForConv(userId, convId, sessionId) {
        const session = this.sessions.get(userId);
        if (session?.activeConvId === convId) {
            session.sessionId = sessionId;
            this.save();
        }
        else {
            // 旧 convId，存到 convSessionMap
            this.convSessionMap.set(`${userId}:${convId}`, sessionId);
            this.pruneConvSessionMap();
        }
    }
    pruneConvSessionMap() {
        while (this.convSessionMap.size > SessionManager.MAX_CONV_SESSION_MAP_SIZE) {
            const oldest = this.convSessionMap.keys().next().value;
            if (oldest !== undefined)
                this.convSessionMap.delete(oldest);
            else
                break;
        }
    }
    getWorkDir(userId) {
        return this.sessions.get(userId)?.workDir ?? this.defaultWorkDir;
    }
    async resolveAndValidatePath(baseDir, targetDir) {
        const resolved = resolve(baseDir, targetDir);
        if (!existsSync(resolved)) {
            throw new Error(`目录不存在: ${resolved}`);
        }
        const realPath = await realpath(resolved);
        const allowed = this.allowedBaseDirs.some((base) => realPath === base || realPath.startsWith(base + '/'));
        if (!allowed) {
            throw new Error(`目录不在允许范围内: ${realPath}\n允许的目录: ${this.allowedBaseDirs.join(', ')}`);
        }
        return realPath;
    }
    async setWorkDir(userId, workDir) {
        const currentDir = this.getWorkDir(userId);
        const realPath = await this.resolveAndValidatePath(currentDir, workDir);
        const session = this.sessions.get(userId);
        if (session) {
            // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
            if (session.activeConvId && session.sessionId) {
                this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
                this.pruneConvSessionMap();
            }
            session.workDir = realPath;
            session.sessionId = undefined;
            session.activeConvId = this.generateConvId();
        }
        else {
            this.sessions.set(userId, { workDir: realPath, activeConvId: this.generateConvId() });
        }
        // 切换目录也立即同步保存，确保会话重置生效
        this.flushSync();
        log.info(`WorkDir changed for user ${userId}: ${realPath}, session cleared`);
        return realPath;
    }
    newSession(userId) {
        const session = this.sessions.get(userId);
        if (session) {
            // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
            if (session.activeConvId && session.sessionId) {
                this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
                this.pruneConvSessionMap();
            }
            session.sessionId = undefined;
            session.activeConvId = this.generateConvId();
            session.totalTurns = 0;
            this.flushSync();
            log.info(`New session started for user: ${userId}`);
            return true;
        }
        return false;
    }
    resumeSession(userId, sessionId) {
        const session = this.sessions.get(userId);
        if (!session)
            return false;
        // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
        if (session.activeConvId && session.sessionId) {
            this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
            this.pruneConvSessionMap();
        }
        session.sessionId = sessionId;
        session.activeConvId = this.generateConvId();
        session.totalTurns = 0;
        this.flushSync();
        log.info(`Resumed session for user ${userId}: ${sessionId}`);
        return true;
    }
    addTurns(userId, turns) {
        const session = this.sessions.get(userId);
        if (!session)
            return 0;
        session.totalTurns = (session.totalTurns ?? 0) + turns;
        this.save();
        return session.totalTurns;
    }
    addTurnsForThread(userId, threadId, turns) {
        const thread = this.sessions.get(userId)?.threads?.[threadId];
        if (!thread)
            return 0;
        thread.totalTurns = (thread.totalTurns ?? 0) + turns;
        this.save();
        return thread.totalTurns;
    }
    getModel(userId, threadId) {
        const session = this.sessions.get(userId);
        if (threadId) {
            const threadModel = session?.threads?.[threadId]?.claudeModel;
            if (threadModel)
                return threadModel;
        }
        return session?.claudeModel;
    }
    setModel(userId, model, threadId) {
        if (threadId) {
            const thread = this.sessions.get(userId)?.threads?.[threadId];
            if (thread) {
                thread.claudeModel = model;
                this.save();
                return;
            }
        }
        const session = this.sessions.get(userId);
        if (session) {
            session.claudeModel = model;
        }
        else {
            this.sessions.set(userId, { workDir: this.defaultWorkDir, activeConvId: this.generateConvId(), claudeModel: model });
        }
        this.save();
    }
    // ─── Thread Session Methods ───
    getThreadSession(userId, threadId) {
        return this.sessions.get(userId)?.threads?.[threadId];
    }
    setThreadSession(userId, threadId, session) {
        // 清除旧的 rootMsgIndex 条目（如果该 threadId 已有旧 session）
        const oldThread = this.sessions.get(userId)?.threads?.[threadId];
        if (oldThread?.rootMessageId) {
            this.rootMsgIndex.delete(oldThread.rootMessageId);
        }
        const userSession = this.sessions.get(userId);
        if (userSession) {
            if (!userSession.threads)
                userSession.threads = {};
            userSession.threads[threadId] = session;
        }
        else {
            this.sessions.set(userId, {
                workDir: this.defaultWorkDir,
                activeConvId: this.generateConvId(),
                threads: { [threadId]: session },
            });
        }
        // 维护反向索引
        if (session.rootMessageId) {
            this.rootMsgIndex.set(session.rootMessageId, { userId, threadId });
        }
        this.save();
    }
    removeThreadSession(userId, threadId) {
        const threads = this.sessions.get(userId)?.threads;
        if (threads) {
            const thread = threads[threadId];
            if (thread?.rootMessageId) {
                this.rootMsgIndex.delete(thread.rootMessageId);
            }
            delete threads[threadId];
            this.flushSync();
        }
    }
    getSessionIdForThread(userId, threadId) {
        return this.sessions.get(userId)?.threads?.[threadId]?.sessionId;
    }
    setSessionIdForThread(userId, threadId, sessionId) {
        const thread = this.sessions.get(userId)?.threads?.[threadId];
        if (thread) {
            thread.sessionId = sessionId;
            this.save();
        }
    }
    getWorkDirForThread(userId, threadId) {
        return this.sessions.get(userId)?.threads?.[threadId]?.workDir ?? this.getWorkDir(userId);
    }
    async setWorkDirForThread(userId, threadId, workDir, rootMessageId) {
        let thread = this.sessions.get(userId)?.threads?.[threadId];
        if (!thread) {
            // 话题会话尚未创建（如首条消息就是 /cd），自动初始化
            this.setThreadSession(userId, threadId, {
                workDir: this.getWorkDir(userId),
                rootMessageId: rootMessageId ?? '',
                threadId,
            });
            thread = this.sessions.get(userId)?.threads?.[threadId];
            if (!thread) {
                throw new Error(`Failed to initialize thread session: user=${userId}, thread=${threadId}`);
            }
        }
        const realPath = await this.resolveAndValidatePath(thread.workDir, workDir);
        thread.workDir = realPath;
        thread.sessionId = undefined; // 切换目录重置会话
        this.flushSync();
        log.info(`Thread ${threadId} workDir changed for user ${userId}: ${realPath}`);
        return realPath;
    }
    newThreadSession(userId, threadId) {
        const thread = this.sessions.get(userId)?.threads?.[threadId];
        if (thread) {
            thread.sessionId = undefined;
            thread.totalTurns = 0;
            this.flushSync();
            log.info(`Thread session reset: user=${userId}, thread=${threadId}`);
            return true;
        }
        return false;
    }
    removeThreadByRootMessageId(rootMessageId) {
        const loc = this.rootMsgIndex.get(rootMessageId);
        if (!loc)
            return false;
        const threads = this.sessions.get(loc.userId)?.threads;
        if (threads && threads[loc.threadId]) {
            delete threads[loc.threadId];
            this.rootMsgIndex.delete(rootMessageId);
            this.save();
            return true;
        }
        // 索引过期，清理
        this.rootMsgIndex.delete(rootMessageId);
        return false;
    }
    listThreads(userId) {
        const threads = this.sessions.get(userId)?.threads;
        if (!threads)
            return [];
        return Object.values(threads);
    }
    load() {
        try {
            if (existsSync(SESSIONS_FILE)) {
                const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
                for (const [key, val] of Object.entries(data)) {
                    if (typeof val === 'string') {
                        // Migrate old format: userId -> sessionId
                        this.sessions.set(key, { sessionId: val, workDir: this.defaultWorkDir });
                    }
                    else if (isUserSession(val)) {
                        // 旧数据无 activeConvId，自动生成
                        if (!val.activeConvId) {
                            val.activeConvId = this.generateConvId();
                        }
                        this.sessions.set(key, val);
                        // 重建 rootMsgIndex
                        if (val.threads) {
                            for (const [threadId, thread] of Object.entries(val.threads)) {
                                if (thread.rootMessageId) {
                                    this.rootMsgIndex.set(thread.rootMessageId, { userId: key, threadId });
                                }
                            }
                        }
                    }
                }
                log.info(`Loaded ${this.sessions.size} sessions`);
            }
        }
        catch {
            log.info('No existing sessions found, starting fresh');
        }
    }
    save() {
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush();
        }, SessionManager.SAVE_DEBOUNCE_MS);
    }
    flush() {
        try {
            this.doFlush();
        }
        catch (err) {
            log.error('Failed to save sessions:', err);
        }
    }
    flushSync() {
        // 取消挂起的防抖保存，防止旧数据覆写刚同步写入的内容
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        try {
            this.doFlush();
            log.info('Sessions saved synchronously');
        }
        catch (err) {
            log.error('Failed to save sessions synchronously:', err);
            throw err;
        }
    }
    destroy() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        try {
            this.doFlush();
            log.info('Sessions flushed on destroy');
        }
        catch (err) {
            log.error('Failed to flush sessions on destroy:', err);
        }
    }
    doFlush() {
        const dir = dirname(SESSIONS_FILE);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const obj = {};
        for (const [key, val] of this.sessions) {
            obj[key] = val;
        }
        writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    }
}
