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
import { notificationsRouter } from "./notifications.routes";
import { requireActiveSubscription } from "../middleware/require-active-subscription";

const apiRouter = Router();

// Notifications
apiRouter.use("/notifications", notificationsRouter);

// Public and Authentication
apiRouter.use("/public", publicRouter);
apiRouter.use("/auth", authRouter);

// Administration and Integrations
apiRouter.use("/admin", adminRouter);
apiRouter.use("/api-credentials", requireActiveSubscription, apiCredentialsRouter);
apiRouter.use("/open", openApiRouter);

// Billing & Workspace
apiRouter.use("/billing", billingRouter);
apiRouter.use("/dashboard", requireActiveSubscription, dashboardRouter);

// WhatsApp Messaging & Devices
apiRouter.use("/devices", requireActiveSubscription, devicesRouter);
apiRouter.use("/messages", requireActiveSubscription, messagesRouter);
apiRouter.use("/templates", requireActiveSubscription, templatesRouter);
apiRouter.use("/live-chat", liveChatRouter);

// Contacts & Campaigns
apiRouter.use("/contacts", requireActiveSubscription, contactsRouter);
apiRouter.use("/contact-groups", requireActiveSubscription, contactGroupsRouter);
apiRouter.use("/bulk-campaigns", requireActiveSubscription, bulkCampaignsRouter);
apiRouter.use("/group-grabber", requireActiveSubscription, groupGrabberRouter);

// Automation & AI
apiRouter.use("/auto-reply-rules", requireActiveSubscription, autoReplyRulesRouter);
apiRouter.use("/call-responder-rules", requireActiveSubscription, callResponderRulesRouter);
apiRouter.use("/chatbot-flows", requireActiveSubscription, chatbotFlowsRouter);
apiRouter.use("/ai-credentials", requireActiveSubscription, aiCredentialsRouter);
apiRouter.use("/ai", requireActiveSubscription, aiCatalogRouter);

export { apiRouter };
