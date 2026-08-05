import { Router } from "express";
import rateLimit from "express-rate-limit";
import { openApiFail } from "../../lib/open-api-response";
import { requireApiClient } from "../../middleware/api-client-auth";
import { openApiErrorHandler } from "../../middleware/open-api-error-handler";
import { openMessagesRouter } from "./messages.routes";
import { openContactGroupsRouter } from "./contact-groups.routes";
import { openCampaignsRouter } from "./campaigns.routes";
import { openDevicesRouter } from "./devices.routes";

const openApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    openApiFail(res, 429, "Too many requests", "RATE_LIMIT");
  },
});

const router = Router();

router.use(openApiLimiter);
router.use(requireApiClient);

router.use("/messages", openMessagesRouter);
router.use("/devices", openDevicesRouter);
router.use("/contact-groups", openContactGroupsRouter);
router.use("/campaigns", openCampaignsRouter);

router.use(openApiErrorHandler);

export { router as openApiRouter };
