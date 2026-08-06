import { env } from "./env";
import { app } from "./app";
import { expireAllDueSslCommerzWorkspaces } from "./services/billing.service";
import { startBulkCampaignScheduledWorker } from "./services/bulk_campaigns.service";
import { ensureConnectedWaSessionsOnStartup } from "./services/wa-device-session.service";

const port = env.PORT;
const SSLCOMMERZ_EXPIRY_POLL_MS = 60 * 60 * 1000;

app.listen(port, () => {
  console.log(`FlexoWhats API listening on http://localhost:${port}`);
  console.log(
    `[whatsapp] bridge ${env.WHATSAPP_BRIDGE_ENABLED ? "ENABLED (real QR + send)" : "DISABLED (outbound simulated)"}`
  );
  startBulkCampaignScheduledWorker();
  void ensureConnectedWaSessionsOnStartup();
  void expireAllDueSslCommerzWorkspaces().catch((err) => {
    console.error("[billing] SSLCommerz expiry sweep failed", err);
  });
  setInterval(() => {
    void expireAllDueSslCommerzWorkspaces().catch((err) => {
      console.error("[billing] SSLCommerz expiry sweep failed", err);
    });
  }, SSLCOMMERZ_EXPIRY_POLL_MS);
});
