/**
 * Seeds demo users — each user gets their own workspace (OWNER) so local testing
 * matches SaaS tenant isolation. Idempotent: safe to run multiple times.
 *
 * Default password for all seed users: SeedPass12345
 *
 * Run: `npm run db:seed` or `npm run seed:users` from `server/` (after migrate).
 */
import path from "path";
import { config } from "dotenv";
import { PrismaClient, MembershipRole, UserRole, Plan } from "@prisma/client";

import { hashPassword } from "../src/lib/password";
import { normalizeDatabaseUrl } from "../src/lib/normalize-database-url";

const repoRoot = path.join(__dirname, "../..");
const serverDir = path.join(__dirname, "..");
config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(repoRoot, ".env.local"), override: true });
config({ path: path.join(serverDir, ".env") });

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Add it to repo root `.env` or `.env.local` (see .env.example), or `server/.env`, then run migrations and seed again."
  );
  process.exit(1);
}

const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
process.env.DATABASE_URL = databaseUrl;

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

/** Shared dev password (meets app minimum length). */
export const SEED_USER_PASSWORD = "SeedPass12345";

const SEED_USERS: {
  email: string;
  name: string;
  phone?: string;
  membershipRole: MembershipRole;
  userRole: UserRole;
}[] = [
  {
    email: "owner@seed.waleado.local",
    name: "Seed Owner",
    phone: "+15551234567",
    membershipRole: "OWNER",
    userRole: "CUSTOMER",
  },
  {
    email: "admin@seed.waleado.local",
    name: "Seed Admin",
    phone: "+15559876543",
    membershipRole: "OWNER",
    userRole: "ADMIN",
  },
  {
    email: "member@seed.waleado.local",
    name: "Seed Member",
    phone: "+15553334444",
    membershipRole: "OWNER",
    userRole: "CUSTOMER",
  },
];

function workspaceSlugForEmail(email: string): string {
  const base = email
    .split("@")[0]
    ?.replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `seed-ws-${base || "user"}`;
}

async function main() {
  const passwordHash = await hashPassword(SEED_USER_PASSWORD);

  const legacyShared = await prisma.workspace.findUnique({
    where: { slug: "seed-demo-workspace" },
    select: { id: true },
  });
  if (legacyShared) {
    await prisma.membership.deleteMany({
      where: {
        workspaceId: legacyShared.id,
        user: {
          email: { in: SEED_USERS.map((u) => u.email.toLowerCase()) },
        },
      },
    });
  }

  for (const row of SEED_USERS) {
    const email = row.email.toLowerCase();
    const slug = workspaceSlugForEmail(email);
    const workspaceName = `${row.name}'s workspace`;

    const workspace = await prisma.workspace.upsert({
      where: { slug },
      create: {
        name: workspaceName,
        slug,
        plan: row.userRole === "ADMIN" ? Plan.BUSINESS : Plan.FREE,
        subscriptionStatus: row.userRole === "ADMIN" ? "active" : undefined,
      },
      update: {
        name: workspaceName,
        ...(row.userRole === "ADMIN"
          ? {
              plan: Plan.BUSINESS,
              subscriptionStatus: "active",
              trialUsed: false,
              trialStartedAt: null,
              trialEndsAt: null,
            }
          : {}),
      },
    });

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: row.name,
        phone: row.phone ?? null,
        passwordHash,
        role: row.userRole,
      },
      update: {
        name: row.name,
        phone: row.phone ?? null,
        passwordHash,
        role: row.userRole,
      },
    });

    await prisma.membership.upsert({
      where: {
        userId_workspaceId: {
          userId: user.id,
          workspaceId: workspace.id,
        },
      },
      create: {
        userId: user.id,
        workspaceId: workspace.id,
        role: row.membershipRole,
      },
      update: {
        role: row.membershipRole,
      },
    });

    console.log(
      `  user=${row.userRole.padEnd(8)} membership=${row.membershipRole.padEnd(6)} ${email} → workspace ${workspace.slug}`
    );
  }

  console.log("\nPassword for all seed users:", SEED_USER_PASSWORD);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
