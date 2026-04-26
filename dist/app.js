"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const pino_http_1 = __importDefault(require("pino-http"));
const env_1 = require("./env");
const error_handler_1 = require("./middleware/error-handler");
const billing_routes_1 = require("./routes/billing.routes");
const devices_routes_1 = require("./routes/devices.routes");
const messages_routes_1 = require("./routes/messages.routes");
const templates_routes_1 = require("./routes/templates.routes");
const contact_groups_routes_1 = require("./routes/contact-groups.routes");
const contacts_routes_1 = require("./routes/contacts.routes");
const bulk_campaigns_routes_1 = require("./routes/bulk-campaigns.routes");
const auto_reply_rules_routes_1 = require("./routes/auto-reply-rules.routes");
const chatbot_flows_routes_1 = require("./routes/chatbot-flows.routes");
const live_chat_routes_1 = require("./routes/live-chat.routes");
const group_grabber_routes_1 = require("./routes/group-grabber.routes");
const dashboard_routes_1 = require("./routes/dashboard.routes");
const admin_routes_1 = require("./routes/admin.routes");
const health_routes_1 = require("./routes/health.routes");
const auth_routes_1 = require("./routes/auth.routes");
const stripe_webhook_1 = require("./routes/stripe-webhook");
const sslcommerz_callbacks_routes_1 = require("./routes/sslcommerz-callbacks.routes");
const app = (0, express_1.default)();
exports.app = app;
/** Dynamic JSON API must not emit ETags: browsers send If-None-Match → 304, and fetch treats 304 as !ok so clients break. */
app.set("etag", false);
if (env_1.env.TRUST_PROXY) {
    app.set("trust proxy", 1);
}
app.use((0, pino_http_1.default)({
    autoLogging: true,
    customLogLevel: (_req, res, err) => {
        if (res.statusCode >= 500 || err)
            return "error";
        if (res.statusCode >= 400)
            return "warn";
        return "info";
    },
}));
app.use((0, helmet_1.default)({
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));
const origins = env_1.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
app.use((0, cors_1.default)({
    origin: origins.length ? origins : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use((0, cookie_parser_1.default)());
app.post("/v1/webhooks/stripe", express_1.default.raw({ type: "application/json" }), (req, res, next) => {
    (0, stripe_webhook_1.stripeWebhookHandler)(req, res).catch(next);
});
app.use("/v1/webhooks/payments/sslcommerz", express_1.default.urlencoded({ extended: false }), sslcommerz_callbacks_routes_1.sslCommerzIpnRouter);
app.use("/v1/payments/sslcommerz", sslcommerz_callbacks_routes_1.sslCommerzBrowserRouter);
app.use(express_1.default.json({ limit: env_1.env.HTTP_JSON_BODY_LIMIT }));
app.use("/v1", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, private");
    next();
});
app.use(health_routes_1.healthRouter);
app.use("/v1/auth", auth_routes_1.authRouter);
app.use("/v1/billing", billing_routes_1.billingRouter);
app.use("/v1/devices", devices_routes_1.devicesRouter);
app.use("/v1/templates", templates_routes_1.templatesRouter);
app.use("/v1/messages", messages_routes_1.messagesRouter);
app.use("/v1/contact-groups", contact_groups_routes_1.contactGroupsRouter);
app.use("/v1/contacts", contacts_routes_1.contactsRouter);
app.use("/v1/bulk-campaigns", bulk_campaigns_routes_1.bulkCampaignsRouter);
app.use("/v1/auto-reply-rules", auto_reply_rules_routes_1.autoReplyRulesRouter);
app.use("/v1/chatbot-flows", chatbot_flows_routes_1.chatbotFlowsRouter);
app.use("/v1/live-chat", live_chat_routes_1.liveChatRouter);
app.use("/v1/group-grabber", group_grabber_routes_1.groupGrabberRouter);
app.use("/v1/dashboard", dashboard_routes_1.dashboardRouter);
app.use("/v1/admin", admin_routes_1.adminRouter);
app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
});
app.use(error_handler_1.errorHandler);
