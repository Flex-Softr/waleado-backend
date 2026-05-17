import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env } from "./env";
import { errorHandler } from "./middleware/error-handler";
import { billingRouter } from "./routes/billing.routes";
import { devicesRouter } from "./routes/devices.routes";
import { messagesRouter } from "./routes/messages.routes";
import { templatesRouter } from "./routes/templates.routes";
import { contactGroupsRouter } from "./routes/contact-groups.routes";
import { contactsRouter } from "./routes/contacts.routes";
import { bulkCampaignsRouter } from "./routes/bulk-campaigns.routes";
import { autoReplyRulesRouter } from "./routes/auto-reply-rules.routes";
import { chatbotFlowsRouter } from "./routes/chatbot-flows.routes";
import { liveChatRouter } from "./routes/live-chat.routes";
import { groupGrabberRouter } from "./routes/group-grabber.routes";
import { dashboardRouter } from "./routes/dashboard.routes";
import { adminRouter } from "./routes/admin.routes";
import { healthRouter } from "./routes/health.routes";
import { publicRouter } from "./routes/public.routes";
import { authRouter } from "./routes/auth.routes";
import { stripeWebhookHandler } from "./routes/stripe-webhook";
import {
  sslCommerzBrowserRouter,
  sslCommerzIpnRouter,
} from "./routes/sslcommerz-callbacks.routes";

const app = express();

/** Dynamic JSON API must not emit ETags: browsers send If-None-Match → 304, and fetch treats 304 as !ok so clients break. */
app.set("etag", false);

if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

app.use(
  pinoHttp({
    autoLogging: true,
    customLogLevel: (_req, res, err) => {
      if (res.statusCode >= 500 || err) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  })
);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

const origins = env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: origins.length ? origins : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(cookieParser());

app.post(
  "/v1/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    stripeWebhookHandler(req, res).catch(next);
  }
);

app.use(
  "/v1/webhooks/payments/sslcommerz",
  express.urlencoded({ extended: false }),
  sslCommerzIpnRouter
);
/** SSLCommerz may GET-redirect or POST form data to success/fail/cancel URLs — parse body when present. */
app.use(
  "/v1/payments/sslcommerz",
  express.urlencoded({ extended: false }),
  sslCommerzBrowserRouter
);

app.use(express.json({ limit: env.HTTP_JSON_BODY_LIMIT }));

app.use("/v1", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, private");
  next();
});

app.use(healthRouter);
app.use("/v1/public", publicRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/billing", billingRouter);
app.use("/v1/devices", devicesRouter);
app.use("/v1/templates", templatesRouter);
app.use("/v1/messages", messagesRouter);
app.use("/v1/contact-groups", contactGroupsRouter);
app.use("/v1/contacts", contactsRouter);
app.use("/v1/bulk-campaigns", bulkCampaignsRouter);
app.use("/v1/auto-reply-rules", autoReplyRulesRouter);
app.use("/v1/chatbot-flows", chatbotFlowsRouter);
app.use("/v1/live-chat", liveChatRouter);
app.use("/v1/group-grabber", groupGrabberRouter);
app.use("/v1/dashboard", dashboardRouter);
app.use("/v1/admin", adminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
});

app.use(errorHandler);

export { app };
