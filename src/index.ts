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
// 2. Start HTTP Server & Background Workers
// ==========================================
const server = app.listen(port, () => {
  console.log(`FlexoWhats API listening on http://localhost:${port}`);
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

const sslInterval = setInterval(() => {
  void expireAllDueSslCommerzWorkspaces().catch((err) => {
    console.error("[billing] SSLCommerz expiry sweep failed", err);
  });
}, SSLCOMMERZ_EXPIRY_POLL_MS);

// ==========================================
// 3. Graceful Shutdown Handling (SIGTERM, SIGINT)
// ==========================================
let isShuttingDown = false;

async function handleShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[shutdown] Received ${signal}. Starting graceful shutdown...`);

  // Clear recurring timers
  clearInterval(sslInterval);
  stopWaDeviceWatchdog();

  // Stop accepting new incoming HTTP connections
  server.close(() => {
    console.log("[shutdown] HTTP server closed.");
  });

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
