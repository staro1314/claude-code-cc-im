export class AccessControl {
    allowedUserIds;
    constructor(allowedUserIds) {
        this.allowedUserIds = new Set(allowedUserIds);
    }
    isAllowed(userId) {
        // Empty whitelist = allow all (dev mode)
        if (this.allowedUserIds.size === 0)
            return true;
        return this.allowedUserIds.has(userId);
    }
}
