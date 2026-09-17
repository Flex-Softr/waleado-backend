import { env } from "./env";
import { app } from "./app";
import { prisma } from "./lib/prisma";
import { expireAllDueSslCommerzWorkspaces } from "./services/billing.service";
import {
  startBulkCampaignScheduledWorker,
  stopBulkCampaignScheduledWorker,
} from "./services/bulk_campaigns.service";
import {
  ensureConnectedWaSessionsOnStartup,
  startWaDeviceWatchdog,
  stopWaDeviceWatchdog,
} from "./services/wa-device-session.service";

// ==========================================
// 1. Process-Level Crash Protection
// ==========================================
process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled Rejection at promise:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught Exception thrown:", error);
});

const port = env.PORT;
const SSLCOMMERZ_EXPIRY_POLL_MS = 60 * 60 * 1000;

// ==========================================
// 2. Database Schema Auto-Healing (Trial Columns)
// ==========================================
async function ensureTrialColumnsExist(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" 
      ADD COLUMN IF NOT EXISTS "trialUsed" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "trialStartedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Workspace" 
      ADD COLUMN IF NOT EXISTS "trialUsed" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "trialStartedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
    `);
    console.log("[db] Database schema verified (trial columns ensured)");
  } catch (err) {
    console.error("[db] Schema auto-ensure warning:", err);
  }
}

// ==========================================
// 3. Start HTTP Server & Background Workers
// ==========================================
let server: ReturnType<typeof app.listen> | null = null;
let sslInterval: NodeJS.Timeout | null = null;

async function bootstrap() {
  await ensureTrialColumnsExist();

  server = app.listen(port, () => {
    console.log(`Waleado API listening on http://localhost:${port}`);
    console.log(
      `[whatsapp] bridge ${env.WHATSAPP_BRIDGE_ENABLED ? "ENABLED (real QR + send)" : "DISABLED (outbound simulated)"}`
    );
    startBulkCampaignScheduledWorker();
    startWaDeviceWatchdog();
    void ensureConnectedWaSessionsOnStartup();
    void expireAllDueSslCommerzWorkspaces().catch((err) => {
      console.error("[billing] SSLCommerz expiry sweep failed", err);
    });
  });

  sslInterval = setInterval(() => {
    void expireAllDueSslCommerzWorkspaces().catch((err) => {
      console.error("[billing] SSLCommerz expiry sweep failed", err);
    });
  }, SSLCOMMERZ_EXPIRY_POLL_MS);
}

void bootstrap();

// ==========================================
// 4. Graceful Shutdown Handling (SIGTERM, SIGINT)
// ==========================================
let isShuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] Received ${signal}. Starting graceful shutdown...`);

  // Clear recurring timers
  if (sslInterval) {
    clearInterval(sslInterval);
  }
  stopWaDeviceWatchdog();

  // Stop accepting new incoming HTTP connections
  if (server) {
    server.close(() => {
      console.log("[shutdown] HTTP server closed.");
    });
  }

  // Force exit after timeout if tasks hang
  const forceExitTimeout = setTimeout(() => {
    console.error("[shutdown] Graceful shutdown timeout (10s) reached. Forcing exit.");
    process.exit(1);
  }, 10_000);
  forceExitTimeout.unref();

  // Drain and cleanly pause active bulk campaign workers
  try {
    await stopBulkCampaignScheduledWorker(5000);
    console.log("[shutdown] Bulk campaign workers drained.");
  } catch (err) {
    console.error("[shutdown] Error stopping campaign workers:", err);
  }

  // Disconnect database client
  try {
    await prisma.$disconnect();
    console.log("[shutdown] Database connections closed.");
  } catch (err) {
    console.error("[shutdown] Error disconnecting database:", err);
  }

  console.log("[shutdown] Graceful shutdown complete. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));
