"use strict";

/**
 * Frees a TCP port before `npm run dev` (avoids EADDRINUSE when a previous tsx/node is still bound).
 * Unix/macOS: uses lsof. Windows: no-op (start dev manually if the port is stuck).
 */
const port = process.argv[2] || "4000";

if (process.platform === "win32") {
  process.exit(0);
}

const { execSync } = require("child_process");

try {
  const out = execSync(`lsof -ti tcp:${port}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!out) process.exit(0);
  const pids = [...new Set(out.split(/\s+/).filter(Boolean))];
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch (_) {
      /* ignore */
    }
  }
} catch (_) {
  /* nothing listening or lsof failed */
}

process.exit(0);
