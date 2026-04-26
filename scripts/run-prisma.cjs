"use strict";

/**
 * Runs Prisma CLI with the same env resolution as server/src/env.ts
 * (root .env → .env.local overrides → server/.env fills remaining keys).
 */
const path = require("path");
const { config } = require("dotenv");
const { spawnSync } = require("child_process");

const serverDir = path.join(__dirname, "..");
const repoRoot = path.join(serverDir, "..");

config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(repoRoot, ".env.local"), override: true });
config({ path: path.join(serverDir, ".env") });

function normalizeDatabaseUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const u = new URL(url);
    if (u.hostname === "localhost") {
      u.hostname = "127.0.0.1";
      return u.toString();
    }
  } catch (_) {
    /* keep original */
  }
  return url;
}
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);
}

const prismaCli = path.join(serverDir, "node_modules", "prisma", "build", "index.js");
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [prismaCli, ...args], {
  cwd: serverDir,
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
