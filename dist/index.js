"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_1 = require("./env");
const app_1 = require("./app");
const bulk_campaigns_service_1 = require("./services/bulk_campaigns.service");
const port = env_1.env.PORT;
app_1.app.listen(port, () => {
    console.log(`FlexoWhats API listening on http://localhost:${port}`);
    console.log(`[whatsapp] bridge ${env_1.env.WHATSAPP_BRIDGE_ENABLED ? "ENABLED (real QR + send)" : "DISABLED (outbound simulated)"}`);
    (0, bulk_campaigns_service_1.startBulkCampaignScheduledWorker)();
});
