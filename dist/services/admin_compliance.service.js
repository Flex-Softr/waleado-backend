"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminCompliance = getAdminCompliance;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const admin_response_meta_1 = require("../lib/admin-response-meta");
const admin_overview_service_1 = require("./admin_overview.service");
const tw = (platform, workspaceId) => platform ? {} : { workspaceId };
const contactWhere = (platform, workspaceId) => platform ? {} : { group: { workspaceId } };
async function getAdminCompliance(operatorEmail, workspaceId) {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const wT = tw(platform, workspaceId);
    const wC = contactWhere(platform, workspaceId);
    const [templatesTotal, templatesActive, mediaAssets, contactsTotal, verified, invalid, contactGroups, contactByStatus, bulkByStatus, templateSends30d, templateRows,] = await Promise.all([
        prisma_1.prisma.messageTemplate.count({ where: wT }),
        prisma_1.prisma.messageTemplate.count({ where: { ...wT, active: true } }),
        prisma_1.prisma.templateMediaAsset.count({ where: wT }),
        prisma_1.prisma.contact.count({ where: wC }),
        prisma_1.prisma.contact.count({ where: { ...wC, status: client_1.ContactStatus.VERIFIED } }),
        prisma_1.prisma.contact.count({ where: { ...wC, status: client_1.ContactStatus.INVALID } }),
        prisma_1.prisma.contactGroup.count({ where: wT }),
        prisma_1.prisma.contact.groupBy({
            by: ["status"],
            where: wC,
            _count: { _all: true },
        }),
        prisma_1.prisma.bulkCampaign.groupBy({
            by: ["status"],
            where: wT,
            _count: { _all: true },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                ...(platform ? {} : { workspaceId }),
                kind: client_1.OutboundKind.TEMPLATE,
                createdAt: { gte: d30 },
            },
        }),
        prisma_1.prisma.messageTemplate.findMany({
            where: wT,
            select: {
                id: true,
                name: true,
                waTemplateName: true,
                active: true,
                language: true,
                category: true,
                updatedAt: true,
                workspace: { select: { name: true, slug: true } },
            },
            orderBy: [{ updatedAt: "desc" }],
            take: platform ? 200 : 150,
        }),
    ]);
    const unverified = Math.max(0, contactsTotal - verified - invalid);
    const verifiedPct = contactsTotal > 0
        ? `${Math.round((verified / contactsTotal) * 100)}%`
        : "—";
    const kpis = scope === "platform"
        ? [
            {
                label: "Message templates",
                value: `${templatesActive} active / ${templatesTotal}`,
                hint: "WhatsApp template library",
            },
            {
                label: "Template media assets",
                value: String(mediaAssets),
                hint: "Uploaded files for sends",
            },
            {
                label: "Contacts",
                value: String(contactsTotal),
                hint: `${verifiedPct} verified · ${unverified} unverified · ${invalid} invalid`,
            },
            {
                label: "Contact groups",
                value: String(contactGroups),
                hint: "Audience segmentation",
            },
            {
                label: "Template sends (30d)",
                value: String(templateSends30d),
                hint: "OutboundMessage TEMPLATE",
            },
        ]
        : [
            {
                label: "Templates",
                value: `${templatesActive} active / ${templatesTotal}`,
                hint: undefined,
            },
            {
                label: "Media assets",
                value: String(mediaAssets),
                hint: undefined,
            },
            {
                label: "Contacts",
                value: String(contactsTotal),
                hint: `${verifiedPct} verified · ${unverified} unverified · ${invalid} invalid`,
            },
            {
                label: "Contact groups",
                value: String(contactGroups),
                hint: undefined,
            },
            {
                label: "Template sends (30d)",
                value: String(templateSends30d),
                hint: undefined,
            },
        ];
    const byContact = contactByStatus
        .map((g) => ({
        key: g.status,
        count: g._count._all,
    }))
        .sort((a, b) => b.count - a.count);
    const byBulk = bulkByStatus
        .map((g) => ({
        key: g.status,
        count: g._count._all,
    }))
        .sort((a, b) => b.count - a.count);
    const templates = templateRows.map((t) => ({
        id: t.id,
        name: t.name,
        waTemplateName: t.waTemplateName,
        active: t.active,
        language: t.language,
        category: t.category,
        workspaceName: t.workspace.name,
        workspaceSlug: t.workspace.slug,
        updatedAt: t.updatedAt.toISOString(),
    }));
    const contactRows = byContact.reduce((s, r) => s + r.count, 0);
    const bulkRows = byBulk.reduce((s, r) => s + r.count, 0);
    return {
        scope,
        generatedAt: now.toISOString(),
        meta: (0, admin_response_meta_1.adminResponseMeta)(templates.length === 0 && contactRows === 0 && bulkRows === 0, "No templates, contacts, or bulk campaigns in scope yet."),
        kpis,
        contactByStatus: byContact,
        bulkCampaignByStatus: byBulk,
        templates,
    };
}
