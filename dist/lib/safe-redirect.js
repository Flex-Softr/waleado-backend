"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSafeInternalPath = isSafeInternalPath;
/** Avoid open redirects via ?next=//evil.com */
function isSafeInternalPath(path) {
    if (!path)
        return false;
    if (!path.startsWith("/"))
        return false;
    if (path.startsWith("//"))
        return false;
    if (path.includes("://"))
        return false;
    return true;
}
