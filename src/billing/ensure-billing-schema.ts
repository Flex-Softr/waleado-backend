import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma";

/**
 * Billing migrations written to be idempotent. They are applied at startup so a deploy
 * works whether or not `prisma migrate deploy` runs in the pipeline. Order matters:
 * a new enum value must be committed before other statements can use it.
 */
const MIGRATIONS = ["20261109115900_plan_starter_tier", "20261109120000_billing_v2"];

function migrationsDir(): string {
  // dist/billing -> <root>/prisma/migrations ; src/billing (tsx) -> same.
  return path.resolve(__dirname, "../../prisma/migrations");
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/^-- >>>\s*$/m)
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
}

export async function ensureBillingSchema(): Promise<void> {
  const dir = migrationsDir();
  for (const name of MIGRATIONS) {
    const file = path.join(dir, name, "migration.sql");
    if (!fs.existsSync(file)) {
      console.warn(`[billing] migration file missing, skipped: ${file}`);
      continue;
    }
    const statements = splitStatements(fs.readFileSync(file, "utf8"));
    for (const statement of statements) {
      // Each statement runs on its own (autocommit) so enum additions are visible to the next ones.
      await prisma.$executeRawUnsafe(statement);
    }
  }
  console.log("[billing] schema verified (plans, prices, invoices)");
}
