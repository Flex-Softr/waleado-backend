import { prisma } from "../lib/prisma";
import { TEMPLATES, TEMPLATE_KEYS, type TemplateKey } from "./templates";

/** A template after applying the admin's override on top of the built-in default. */
export type ResolvedTemplate = {
  key: TemplateKey;
  label: string;
  variables: string[];
  whatsapp: string | null;
  email: { subject: string; body: string } | null;
  whatsappEnabled: boolean;
  emailEnabled: boolean;
  /** True when the admin changed anything. */
  customized: boolean;
};

type OverrideRow = Awaited<ReturnType<typeof prisma.notificationTemplate.findMany>>[number];

function resolve(key: TemplateKey, row: OverrideRow | undefined): ResolvedTemplate {
  const def = TEMPLATES[key];
  return {
    key,
    label: def.label,
    variables: def.variables,
    whatsapp: def.whatsapp === null ? null : row?.whatsappBody ?? def.whatsapp,
    email:
      def.email === null
        ? null
        : { subject: row?.emailSubject ?? def.email.subject, body: row?.emailBody ?? def.email.body },
    whatsappEnabled: row?.whatsappEnabled ?? true,
    emailEnabled: row?.emailEnabled ?? true,
    customized: Boolean(row),
  };
}

export async function getTemplate(key: TemplateKey): Promise<ResolvedTemplate> {
  const row = await prisma.notificationTemplate.findUnique({ where: { key } });
  return resolve(key, row ?? undefined);
}

export async function listTemplates(): Promise<ResolvedTemplate[]> {
  const rows = await prisma.notificationTemplate.findMany();
  return TEMPLATE_KEYS.map((key) => resolve(key, rows.find((r) => r.key === key)));
}

export type TemplateOverrideInput = {
  whatsappBody?: string | null;
  emailSubject?: string | null;
  emailBody?: string | null;
  whatsappEnabled?: boolean;
  emailEnabled?: boolean;
};

export async function saveTemplateOverride(key: TemplateKey, input: TemplateOverrideInput) {
  await prisma.notificationTemplate.upsert({
    where: { key },
    create: { key, ...input },
    update: input,
  });
  return getTemplate(key);
}

/** Back to the built-in text and enabled channels. */
export async function resetTemplate(key: TemplateKey) {
  await prisma.notificationTemplate.deleteMany({ where: { key } });
  return getTemplate(key);
}
