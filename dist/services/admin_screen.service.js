"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADMIN_SCREEN_MODULE_IDS = void 0;
exports.getAdminScreen = getAdminScreen;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../env");
const errors_1 = require("../lib/errors");
const admin_overview_service_1 = require("./admin_overview.service");
/** Remaining admin nav modules that use the generic screen API */
exports.ADMIN_SCREEN_MODULE_IDS = [
    "feature-flags",
    "integrations",
    "system",
    "audit",
    "support",
    "announcements",
    "reports",
    "settings",
];
function isScreenModuleId(s) {
    return exports.ADMIN_SCREEN_MODULE_IDS.includes(s);
}
async function getAdminScreen(moduleId, operatorEmail, workspaceId) {
    if (!isScreenModuleId(moduleId)) {
        throw new errors_1.AppError(404, "Unknown admin screen", "NOT_FOUND");
    }
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const w = platform ? undefined : { workspaceId };
    const notes = [];
    let kpis = [];
    let tables = [];
    let noData = false;
    let message = null;
    switch (moduleId) {
        case "feature-flags": {
            const hasOperatorList = Boolean(env_1.env.PLATFORM_OPERATOR_EMAILS?.trim());
            kpis = [
                {
                    label: "Stripe",
                    value: env_1.env.STRIPE_SECRET_KEY ? "Configured" : "Off",
                    hint: "Billing integration",
                },
                {
                    label: "WhatsApp bridge",
                    value: env_1.env.WHATSAPP_BRIDGE_ENABLED ? "On" : "Off",
                    hint: "Real sends / QR",
                },
                {
                    label: "Platform operators",
                    value: hasOperatorList ? "Set" : "Not set",
                    hint: hasOperatorList
                        ? "PLATFORM_OPERATOR_EMAILS"
                        : "Admin uses workspace scope only",
                },
            ];
            notes.push("There is no dedicated feature-flag store yet; toggles follow environment and workspace billing state.");
            noData = false;
            message = null;
            break;
        }
        case "integrations": {
            const [webhook24h, webhookTotal] = await Promise.all([
                prisma_1.prisma.stripeEventLog.count({ where: { processedAt: { gte: h24 } } }),
                prisma_1.prisma.stripeEventLog.count(),
            ]);
            kpis = [
                {
                    label: "Stripe API",
                    value: env_1.env.STRIPE_SECRET_KEY ? "Secret configured" : "Not set",
                    hint: env_1.env.STRIPE_SECRET_KEY ? "Live or test key present" : undefined,
                },
                {
                    label: "Webhooks (24h)",
                    value: String(webhook24h),
                    hint: `${webhookTotal} total logged`,
                },
            ];
            if (platform) {
                const events = await prisma_1.prisma.stripeEventLog.findMany({
                    select: {
                        stripeEventId: true,
                        type: true,
                        processedAt: true,
                    },
                    orderBy: { processedAt: "desc" },
                    take: 40,
                });
                tables.push({
                    id: "stripe-events",
                    title: "Recent Stripe webhook events",
                    description: "From the idempotency log (not all vendors).",
                    columns: [
                        { field: "type", header: "Type" },
                        { field: "eventId", header: "Event ID" },
                        { field: "processedAt", header: "Processed" },
                    ],
                    rows: events.map((e) => ({
                        type: e.type,
                        eventId: e.stripeEventId.length > 20
                            ? `${e.stripeEventId.slice(0, 10)}…${e.stripeEventId.slice(-6)}`
                            : e.stripeEventId,
                        processedAt: e.processedAt.toISOString(),
                    })),
                });
                noData = events.length === 0;
                message = noData
                    ? "No Stripe webhook events recorded yet. Complete a checkout or send a test event."
                    : null;
            }
            else {
                noData = false;
                message = null;
                notes.push("Full webhook streams are listed in platform scope (operator email in PLATFORM_OPERATOR_EMAILS).");
            }
            break;
        }
        case "system": {
            const [devicesTotal, devicesConnected, wsCount] = await Promise.all([
                prisma_1.prisma.device.count(),
                prisma_1.prisma.device.count({ where: { status: client_1.DeviceStatus.CONNECTED } }),
                prisma_1.prisma.workspace.count(),
            ]);
            kpis = [
                {
                    label: "Node env",
                    value: env_1.env.NODE_ENV,
                    hint: process.version,
                },
                {
                    label: "App URL",
                    value: env_1.env.APP_PUBLIC_URL.replace(/^https?:\/\//, "").slice(0, 40),
                    hint: "APP_PUBLIC_URL",
                },
                {
                    label: "Workspaces",
                    value: String(wsCount),
                    hint: "Registered orgs",
                },
                {
                    label: "Devices online",
                    value: `${devicesConnected} / ${devicesTotal}`,
                    hint: "WhatsApp sessions",
                },
            ];
            tables.push({
                id: "snapshot",
                title: "Platform snapshot",
                columns: [
                    { field: "key", header: "Signal" },
                    { field: "value", header: "Value" },
                ],
                rows: [
                    { key: "WhatsApp bridge", value: env_1.env.WHATSAPP_BRIDGE_ENABLED ? "enabled" : "disabled" },
                    { key: "Stripe", value: env_1.env.STRIPE_SECRET_KEY ? "configured" : "not configured" },
                    { key: "JSON body limit", value: env_1.env.HTTP_JSON_BODY_LIMIT },
                ],
            });
            noData = false;
            message = null;
            break;
        }
        case "audit": {
            if (platform) {
                const events = await prisma_1.prisma.stripeEventLog.findMany({
                    select: {
                        stripeEventId: true,
                        type: true,
                        processedAt: true,
                    },
                    orderBy: { processedAt: "desc" },
                    take: 60,
                });
                tables.push({
                    id: "audit-proxy",
                    title: "Processed events (Stripe webhook log)",
                    description: "A dedicated immutable audit trail is not in the database yet; this is a stand-in timeline.",
                    columns: [
                        { field: "type", header: "Type" },
                        { field: "eventId", header: "Event ID" },
                        { field: "processedAt", header: "Processed (UTC)" },
                    ],
                    rows: events.map((e) => ({
                        type: e.type,
                        eventId: e.stripeEventId,
                        processedAt: e.processedAt.toISOString(),
                    })),
                });
                noData = events.length === 0;
                message = noData
                    ? "No events to show. Audit feed will populate as webhooks are processed."
                    : null;
            }
            else {
                noData = true;
                message =
                    "Workspace admins do not receive the global audit stream. Use platform scope for operators.";
                notes.push("Connect a dedicated audit store to log admin actions and reads.");
            }
            break;
        }
        case "support": {
            const threadWhere = w ? { workspaceId } : {};
            const msgWhere = w
                ? { thread: { workspaceId } }
                : {};
            const [threadCount, msgs24h, active7d, threads] = await Promise.all([
                prisma_1.prisma.liveChatThread.count({ where: threadWhere }),
                prisma_1.prisma.liveChatMessage.count({
                    where: { ...msgWhere, createdAt: { gte: h24 } },
                }),
                prisma_1.prisma.liveChatThread.count({
                    where: {
                        ...threadWhere,
                        OR: [
                            { lastMessageAt: { gte: d7 } },
                            { updatedAt: { gte: d7 } },
                        ],
                    },
                }),
                prisma_1.prisma.liveChatThread.findMany({
                    where: threadWhere,
                    select: {
                        peerPhone: true,
                        peerLabel: true,
                        lastPreview: true,
                        lastMessageAt: true,
                        updatedAt: true,
                        workspace: { select: { name: true, slug: true } },
                    },
                    orderBy: [{ updatedAt: "desc" }],
                    take: 40,
                }),
            ]);
            kpis = [
                { label: "Live chat threads", value: String(threadCount), hint: "In scope" },
                { label: "Messages (24h)", value: String(msgs24h), hint: "LiveChatMessage" },
                {
                    label: "Active (7d)",
                    value: String(active7d),
                    hint: "Touched in last 7 days",
                },
            ];
            tables.push({
                id: "threads",
                title: "Recent threads",
                description: "Newest activity first.",
                columns: [
                    { field: "workspace", header: "Workspace" },
                    { field: "slug", header: "Slug" },
                    { field: "peer", header: "Peer" },
                    { field: "preview", header: "Preview" },
                    { field: "lastAt", header: "Last message" },
                ],
                rows: threads.map((t) => {
                    const peer = `${t.peerLabel || ""} ${t.peerPhone}`.trim();
                    const lastAt = t.lastMessageAt?.toISOString() ?? t.updatedAt.toISOString();
                    const preview = t.lastPreview || "—";
                    return {
                        workspace: platform ? t.workspace.name : "—",
                        slug: platform ? t.workspace.slug : "—",
                        peer,
                        preview,
                        lastAt,
                    };
                }),
            });
            noData = threadCount === 0;
            message = noData
                ? "No live chat threads yet. Conversations appear when customers message linked devices."
                : null;
            break;
        }
        case "announcements": {
            noData = true;
            message =
                "No announcement records in the database. Add a banner store or CMS integration when ready.";
            kpis = [];
            notes.push("Ship an Announcement model or external feed to populate this screen.");
            break;
        }
        case "reports": {
            const contactWhere = w ? { group: { workspaceId } } : {};
            const [contacts, templates, outbound30d, bulkDone] = await Promise.all([
                prisma_1.prisma.contact.count({ where: contactWhere }),
                prisma_1.prisma.messageTemplate.count({ where: w ? { workspaceId } : {} }),
                prisma_1.prisma.outboundMessage.count({
                    where: { ...threadWhereToOutbound(w), createdAt: { gte: d30 } },
                }),
                prisma_1.prisma.bulkCampaign.count({
                    where: {
                        ...(w ? { workspaceId } : {}),
                        status: client_1.BulkCampaignStatus.COMPLETED,
                    },
                }),
            ]);
            kpis = [
                { label: "Contacts", value: String(contacts), hint: "Audience rows" },
                { label: "Templates", value: String(templates), hint: "Message templates" },
                { label: "Outbound (30d)", value: String(outbound30d), hint: "All kinds" },
                { label: "Bulk campaigns done", value: String(bulkDone), hint: "COMPLETED" },
            ];
            tables.push({
                id: "export-readiness",
                title: "Report scope summary",
                columns: [
                    { field: "metric", header: "Metric" },
                    { field: "count", header: "Count" },
                ],
                rows: [
                    { metric: "Contacts", count: contacts },
                    { metric: "Templates", count: templates },
                    { metric: "Outbound (30d)", count: outbound30d },
                    { metric: "Bulk completed", count: bulkDone },
                ],
            });
            const sum = contacts + templates + outbound30d + bulkDone;
            noData = sum === 0;
            message = noData
                ? "No reportable volume in scope yet. Import contacts or send traffic to see metrics."
                : null;
            break;
        }
        case "settings": {
            if (platform) {
                const rows = await prisma_1.prisma.workspace.findMany({
                    select: {
                        name: true,
                        slug: true,
                        plan: true,
                        subscriptionStatus: true,
                        updatedAt: true,
                    },
                    orderBy: { updatedAt: "desc" },
                    take: 120,
                });
                tables.push({
                    id: "workspaces",
                    title: "Workspaces (recent updates)",
                    description: "Plan and billing fields as stored on each workspace.",
                    columns: [
                        { field: "name", header: "Name" },
                        { field: "slug", header: "Slug" },
                        { field: "plan", header: "Plan" },
                        { field: "subscriptionStatus", header: "Sub status" },
                        { field: "updatedAt", header: "Updated" },
                    ],
                    rows: rows.map((r) => ({
                        name: r.name,
                        slug: r.slug,
                        plan: r.plan,
                        subscriptionStatus: r.subscriptionStatus ?? "—",
                        updatedAt: r.updatedAt.toISOString(),
                    })),
                });
                noData = rows.length === 0;
                message = noData ? "No workspaces in the database." : null;
                kpis = [
                    { label: "Listed", value: String(rows.length), hint: "Max 120 recent" },
                ];
            }
            else {
                const ws = await prisma_1.prisma.workspace.findUnique({
                    where: { id: workspaceId },
                    select: {
                        name: true,
                        slug: true,
                        plan: true,
                        subscriptionStatus: true,
                        stripeCustomerId: true,
                        stripeSubscriptionId: true,
                        currentPeriodEnd: true,
                        updatedAt: true,
                        createdAt: true,
                    },
                });
                if (!ws) {
                    noData = true;
                    message = "Workspace not found.";
                    kpis = [];
                }
                else {
                    kpis = [
                        { label: "Plan", value: ws.plan, hint: ws.subscriptionStatus ?? undefined },
                        {
                            label: "Stripe customer",
                            value: ws.stripeCustomerId ? "Linked" : "None",
                            hint: undefined,
                        },
                    ];
                    tables.push({
                        id: "workspace",
                        title: "Current workspace",
                        columns: [
                            { field: "field", header: "Field" },
                            { field: "value", header: "Value" },
                        ],
                        rows: [
                            { field: "Name", value: ws.name },
                            { field: "Slug", value: ws.slug },
                            { field: "Plan", value: ws.plan },
                            {
                                field: "Subscription status",
                                value: ws.subscriptionStatus ?? "—",
                            },
                            {
                                field: "Stripe subscription",
                                value: ws.stripeSubscriptionId ?? "—",
                            },
                            {
                                field: "Period end",
                                value: ws.currentPeriodEnd?.toISOString() ?? "—",
                            },
                            { field: "Created", value: ws.createdAt.toISOString() },
                            { field: "Updated", value: ws.updatedAt.toISOString() },
                        ],
                    });
                    noData = false;
                    message = null;
                }
            }
            break;
        }
        default:
            throw new errors_1.AppError(404, "Unknown admin screen", "NOT_FOUND");
    }
    return {
        moduleId,
        scope,
        generatedAt: now.toISOString(),
        meta: { noData, message },
        kpis,
        tables,
        notes,
    };
}
function threadWhereToOutbound(w) {
    return w ? { workspaceId: w.workspaceId } : {};
}
