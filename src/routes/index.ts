import { Router } from "express";
import { publicRouter } from "./public.routes";
import { authRouter } from "./auth.routes";
import { adminRouter } from "./admin.routes";
import { apiCredentialsRouter } from "./api-credentials.routes";
import { openApiRouter } from "./open";
import { billingRouter } from "./billing.routes";
import { devicesRouter } from "./devices.routes";
import { templatesRouter } from "./templates.routes";
import { messagesRouter } from "./messages.routes";
import { contactGroupsRouter } from "./contact-groups.routes";
import { contactsRouter } from "./contacts.routes";
import { bulkCampaignsRouter } from "./bulk-campaigns.routes";
import { autoReplyRulesRouter } from "./auto-reply-rules.routes";
import { callResponderRulesRouter } from "./call-responder-rules.routes";
import { chatbotFlowsRouter } from "./chatbot-flows.routes";
import { liveChatRouter } from "./live-chat.routes";
import { groupGrabberRouter } from "./group-grabber.routes";
import { dashboardRouter } from "./dashboard.routes";
import {
  aiCatalogRouter,
  aiCredentialsRouter,
} from "./ai-credentials.routes";

const apiRouter = Router();

// Public and Authentication
apiRouter.use("/public", publicRouter);
apiRouter.use("/auth", authRouter);

// Administration and Integrations
apiRouter.use("/admin", adminRouter);
apiRouter.use("/api-credentials", apiCredentialsRouter);
apiRouter.use("/open", openApiRouter);

// Billing & Workspace
apiRouter.use("/billing", billingRouter);
apiRouter.use("/dashboard", dashboardRouter);

// WhatsApp Messaging & Devices
apiRouter.use("/devices", devicesRouter);
apiRouter.use("/messages", messagesRouter);
apiRouter.use("/templates", templatesRouter);
apiRouter.use("/live-chat", liveChatRouter);

// Contacts & Campaigns
apiRouter.use("/contacts", contactsRouter);
apiRouter.use("/contact-groups", contactGroupsRouter);
apiRouter.use("/bulk-campaigns", bulkCampaignsRouter);
apiRouter.use("/group-grabber", groupGrabberRouter);

// Automation & AI
apiRouter.use("/auto-reply-rules", autoReplyRulesRouter);
apiRouter.use("/call-responder-rules", callResponderRulesRouter);
apiRouter.use("/chatbot-flows", chatbotFlowsRouter);
apiRouter.use("/ai-credentials", aiCredentialsRouter);
apiRouter.use("/ai", aiCatalogRouter);

export { apiRouter };
