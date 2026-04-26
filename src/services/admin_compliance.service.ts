import { ContactStatus, OutboundKind } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AdminResponseMeta } from "../lib/admin-response-meta";
import { adminResponseMeta } from "../lib/admin-response-meta";
import { isPlatformOperatorEmail } from "./admin_overview.service";

export type AdminComplianceKpi = {
  label: string;
  value: string;
  hint?: string;
};

export type AdminComplianceBreakdown = {
  key: string;
  count: number;
};

export type AdminComplianceTemplateRow = {
  id: string;
  name: string;
  waTemplateName: string;
  active: boolean;
  language: string;
  category: string;
  workspaceName: string;
  workspaceSlug: string;
  updatedAt: string;
};

export type AdminComplianceJson = {
  scope: "platform" | "workspace";
  generatedAt: string;
  meta: AdminResponseMeta;
  kpis: AdminComplianceKpi[];
  contactByStatus: AdminComplianceBreakdown[];
  bulkCampaignByStatus: AdminComplianceBreakdown[];
  templates: AdminComplianceTemplateRow[];
};

const tw = (platform: boolean, workspaceId: string) =>
  platform ? {} : { workspaceId };

const contactWhere = (platform: boolean, workspaceId: string) =>
  platform ? {} : { group: { workspaceId } };

export async function getAdminCompliance(
  operatorEmail: string,
  workspaceId: string
): Promise<AdminComplianceJson> {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const platform = isPlatformOperatorEmail(operatorEmail);
  const scope = platform ? "platform" : "workspace";
  const wT = tw(platform, workspaceId);
  const wC = contactWhere(platform, workspaceId);

  const [
    templatesTotal,
    templatesActive,
    mediaAssets,
    contactsTotal,
    verified,
    invalid,
    contactGroups,
    contactByStatus,
    bulkByStatus,
    templateSends30d,
    templateRows,
  ] = await Promise.all([
    prisma.messageTemplate.count({ where: wT }),
    prisma.messageTemplate.count({ where: { ...wT, active: true } }),
    prisma.templateMediaAsset.count({ where: wT }),
    prisma.contact.count({ where: wC }),
    prisma.contact.count({ where: { ...wC, status: ContactStatus.VERIFIED } }),
    prisma.contact.count({ where: { ...wC, status: ContactStatus.INVALID } }),
    prisma.contactGroup.count({ where: wT }),
    prisma.contact.groupBy({
      by: ["status"],
      where: wC,
      _count: { _all: true },
    }),
    prisma.bulkCampaign.groupBy({
      by: ["status"],
      where: wT,
      _count: { _all: true },
    }),
    prisma.outboundMessage.count({
      where: {
        ...(platform ? {} : { workspaceId }),
        kind: OutboundKind.TEMPLATE,
        createdAt: { gte: d30 },
      },
    }),
    prisma.messageTemplate.findMany({
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

  const verifiedPct =
    contactsTotal > 0
      ? `${Math.round((verified / contactsTotal) * 100)}%`
      : "—";

  const kpis: AdminComplianceKpi[] =
    scope === "platform"
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

  const byContact: AdminComplianceBreakdown[] = contactByStatus
    .map((g) => ({
      key: g.status,
      count: g._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  const byBulk: AdminComplianceBreakdown[] = bulkByStatus
    .map((g) => ({
      key: g.status,
      count: g._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  const templates: AdminComplianceTemplateRow[] = templateRows.map((t) => ({
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
    meta: adminResponseMeta(
      templates.length === 0 && contactRows === 0 && bulkRows === 0,
      "No templates, contacts, or bulk campaigns in scope yet."
    ),
    kpis,
    contactByStatus: byContact,
    bulkCampaignByStatus: byBulk,
    templates,
  };
}
