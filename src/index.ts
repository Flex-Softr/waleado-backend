import { env } from "./env";
import { app } from "./app";
import { startBulkCampaignScheduledWorker } from "./services/bulk_campaigns.service";

const port = env.PORT;

app.listen(port, () => {
  console.log(`FlexoWhats API listening on http://localhost:${port}`);
  console.log(
    `[whatsapp] bridge ${env.WHATSAPP_BRIDGE_ENABLED ? "ENABLED (real QR + send)" : "DISABLED (outbound simulated)"}`
  );
  startBulkCampaignScheduledWorker();
});
