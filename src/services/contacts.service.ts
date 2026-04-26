import { ContactStatus, Prisma } from "@prisma/client";
import { env } from "../env";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import {
  validateAndFormatPhone,
  validatePhoneForGrabberImport,
} from "../lib/phone";
import { checkE164RegisteredOnWhatsApp } from "./wa-phone-presence.service";

export type ContactStatusApi = "verified" | "unverified" | "invalid";

function statusToApi(s: ContactStatus): ContactStatusApi {
  switch (s) {
    case ContactStatus.VERIFIED:
      return "verified";
    case ContactStatus.INVALID:
      return "invalid";
    default:
      return "unverified";
  }
}

function apiToStatus(s: ContactStatusApi): ContactStatus {
  switch (s) {
    case "verified":
      return ContactStatus.VERIFIED;
    case "invalid":
      return ContactStatus.INVALID;
    default:
      return ContactStatus.UNVERIFIED;
  }
}

export type ContactRowJson = {
  id: string;
  name: string;
  phone: string;
  status: ContactStatusApi;
  createdAt: string;
  updatedAt: string;
};

export type GroupStatsJson = {
  total: number;
  verified: number;
  unverified: number;
  invalid: number;
};

export type ContactGroupListItemJson = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  stats: GroupStatsJson;
};

function contactToRow(c: {
  id: string;
  name: string;
  phone: string;
  status: ContactStatus;
  createdAt: Date;
  updatedAt: Date;
}): ContactRowJson {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    status: statusToApi(c.status),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function assertGroupInWorkspace(
  workspaceId: string,
  groupId: string
): Promise<{ id: string; name: string; createdAt: Date; updatedAt: Date }> {
  const g = await prisma.contactGroup.findFirst({
    where: { id: groupId, workspaceId },
  });
  if (!g) {
    throw new AppError(404, "Group not found", "NOT_FOUND");
  }
  return g;
}

async function buildStatsMap(
  workspaceId: string
): Promise<Map<string, GroupStatsJson>> {
  const rows = await prisma.contact.groupBy({
    by: ["groupId", "status"],
    where: { group: { workspaceId } },
    _count: { _all: true },
  });

  const map = new Map<string, GroupStatsJson>();

  function ensure(gid: string): GroupStatsJson {
    let s = map.get(gid);
    if (!s) {
      s = { total: 0, verified: 0, unverified: 0, invalid: 0 };
      map.set(gid, s);
    }
    return s;
  }

  for (const r of rows) {
    const s = ensure(r.groupId);
    const n = r._count._all;
    s.total += n;
    if (r.status === ContactStatus.VERIFIED) s.verified += n;
    else if (r.status === ContactStatus.INVALID) s.invalid += n;
    else s.unverified += n;
  }

  return map;
}

export async function listGroups(
  workspaceId: string
): Promise<ContactGroupListItemJson[]> {
  const [groups, statsMap] = await Promise.all([
    prisma.contactGroup.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
    }),
    buildStatsMap(workspaceId),
  ]);

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    stats:
      statsMap.get(g.id) ?? {
        total: 0,
        verified: 0,
        unverified: 0,
        invalid: 0,
      },
  }));
}

export async function getGroupDetail(
  workspaceId: string,
  groupId: string
): Promise<{
  group: ContactGroupListItemJson;
  contacts: ContactRowJson[];
}> {
  const g = await assertGroupInWorkspace(workspaceId, groupId);
  const statsMap = await buildStatsMap(workspaceId);
  const contacts = await prisma.contact.findMany({
    where: { groupId },
    orderBy: { createdAt: "desc" },
  });

  return {
    group: {
      id: g.id,
      name: g.name,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
      stats:
        statsMap.get(g.id) ?? {
          total: 0,
          verified: 0,
          unverified: 0,
          invalid: 0,
        },
    },
    contacts: contacts.map(contactToRow),
  };
}

export async function createGroup(
  workspaceId: string,
  name: string
): Promise<ContactGroupListItemJson> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new AppError(400, "Group name is required", "VALIDATION");
  }
  const g = await prisma.contactGroup.create({
    data: {
      workspaceId,
      name: trimmed.slice(0, 200),
    },
  });
  return {
    id: g.id,
    name: g.name,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    stats: { total: 0, verified: 0, unverified: 0, invalid: 0 },
  };
}

export async function updateGroup(
  workspaceId: string,
  groupId: string,
  name: string
): Promise<ContactGroupListItemJson> {
  await assertGroupInWorkspace(workspaceId, groupId);
  const trimmed = name.trim();
  if (!trimmed) {
    throw new AppError(400, "Group name is required", "VALIDATION");
  }
  const g = await prisma.contactGroup.update({
    where: { id: groupId },
    data: { name: trimmed.slice(0, 200) },
  });
  const statsMap = await buildStatsMap(workspaceId);
  return {
    id: g.id,
    name: g.name,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    stats:
      statsMap.get(g.id) ?? {
        total: 0,
        verified: 0,
        unverified: 0,
        invalid: 0,
      },
  };
}

export async function deleteGroup(
  workspaceId: string,
  groupId: string
): Promise<void> {
  await assertGroupInWorkspace(workspaceId, groupId);
  await prisma.contactGroup.delete({ where: { id: groupId } });
}

export async function createContact(
  workspaceId: string,
  groupId: string,
  input: { name: string; phone: string }
): Promise<ContactRowJson> {
  await assertGroupInWorkspace(workspaceId, groupId);
  const name = input.name.trim() || "Contact";
  const v = validateAndFormatPhone(input.phone);
  if (!v.valid) {
    throw new AppError(400, v.message, "INVALID_PHONE");
  }
  try {
    const c = await prisma.contact.create({
      data: {
        groupId,
        name: name.slice(0, 200),
        phone: v.e164,
        status: ContactStatus.UNVERIFIED,
      },
    });
    return contactToRow(c);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new AppError(
        409,
        "This phone number is already in the group",
        "DUPLICATE_PHONE"
      );
    }
    throw e;
  }
}

export type BulkLineResult = {
  created: ContactRowJson[];
  skipped: { phone: string; reason: string }[];
};

/** Prisma/Postgres parameter budget: keep chunks moderate. */
const BULK_INSERT_CHUNK = 300;

function parseBulkLine(line: string): { name: string; phoneRaw: string } {
  const t = line.trim();
  if (!t) return { name: "Contact", phoneRaw: "" };
  const parts = t.split(/\t/);
  if (parts.length >= 2) {
    return {
      name: parts[0]!.trim() || "Contact",
      phoneRaw: parts[parts.length - 1]!.trim(),
    };
  }
  const sepPriority: readonly string[] = [";", "\uFF1B", ",", "،", "\uFF0C"];
  let bestIdx = -1;
  let bestLen = 1;
  for (const sep of sepPriority) {
    const idx = t.indexOf(sep);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = sep.length;
    }
  }
  if (bestIdx !== -1) {
    return {
      name: t.slice(0, bestIdx).trim() || "Contact",
      phoneRaw: t.slice(bestIdx + bestLen).trim(),
    };
  }
  return { name: "Contact", phoneRaw: t };
}

export type BulkCreatePhoneMode = "strict" | "grabber";

export async function bulkCreateContacts(
  workspaceId: string,
  groupId: string,
  lines: string[],
  options?: { phoneMode?: BulkCreatePhoneMode }
): Promise<BulkLineResult> {
  await assertGroupInWorkspace(workspaceId, groupId);

  const phoneMode = options?.phoneMode ?? "strict";
  const validatePhone =
    phoneMode === "grabber"
      ? validatePhoneForGrabberImport
      : validateAndFormatPhone;

  const skipped: { phone: string; reason: string }[] = [];
  type ValidRow = { name: string; e164: string; phoneRaw: string };
  const validated: ValidRow[] = [];
  const seenInBatch = new Set<string>();

  for (const line of lines) {
    const { name, phoneRaw } = parseBulkLine(line);
    if (!phoneRaw) {
      const hint = line.trim();
      if (hint.length > 0) {
        skipped.push({
          phone: hint.length > 96 ? `${hint.slice(0, 96)}…` : hint,
          reason:
            "Empty phone — wrong column or separator (use tab, comma, or semicolon between name and phone)",
        });
      }
      continue;
    }
    const v = validatePhone(phoneRaw);
    if (!v.valid) {
      skipped.push({ phone: phoneRaw, reason: v.message });
      continue;
    }
    if (seenInBatch.has(v.e164)) {
      skipped.push({ phone: phoneRaw, reason: "Duplicate in paste" });
      continue;
    }
    seenInBatch.add(v.e164);
    validated.push({
      name: name.slice(0, 200),
      e164: v.e164,
      phoneRaw,
    });
  }

  if (validated.length === 0) {
    return { created: [], skipped };
  }

  const dbSkipped: { phone: string; reason: string }[] = [];

  const created: ContactRowJson[] = await prisma.$transaction(
    async (tx) => {
      const phones = [...new Set(validated.map((r) => r.e164))];
      const existing = await tx.contact.findMany({
        where: { groupId, phone: { in: phones } },
        select: { phone: true },
      });
      const existingSet = new Set(existing.map((r) => r.phone));

      const rowsToInsert: {
        groupId: string;
        name: string;
        phone: string;
        status: ContactStatus;
      }[] = [];

      for (const r of validated) {
        if (existingSet.has(r.e164)) {
          dbSkipped.push({
            phone: r.phoneRaw,
            reason: "Already in this group",
          });
          continue;
        }
        rowsToInsert.push({
          groupId,
          name: r.name,
          phone: r.e164,
          status: ContactStatus.UNVERIFIED,
        });
      }

      const out: ContactRowJson[] = [];
      for (let i = 0; i < rowsToInsert.length; i += BULK_INSERT_CHUNK) {
        const chunk = rowsToInsert.slice(i, i + BULK_INSERT_CHUNK);
        if (chunk.length === 0) continue;
        const inserted = await tx.contact.createManyAndReturn({
          data: chunk,
        });
        for (const c of inserted) {
          out.push(contactToRow(c));
        }
      }
      return out;
    },
    {
      maxWait: 10_000,
      timeout: 60_000,
    }
  );

  return { created, skipped: [...skipped, ...dbSkipped] };
}

export async function importMembersFromGrabber(
  workspaceId: string,
  groupId: string,
  members: { name: string; phone: string }[]
): Promise<BulkLineResult> {
  const lines = members
    .map((m) => {
      const phone = m.phone.trim();
      if (!phone) return null;
      const name = (m.name || "Contact").trim() || "Contact";
      return `${name}\t${phone}`;
    })
    .filter((x): x is string => x !== null);
  return bulkCreateContacts(workspaceId, groupId, lines, {
    phoneMode: "grabber",
  });
}

export async function removeInvalidContactsInGroup(
  workspaceId: string,
  groupId: string
): Promise<{ removed: number }> {
  await assertGroupInWorkspace(workspaceId, groupId);
  const res = await prisma.contact.deleteMany({
    where: { groupId, status: ContactStatus.INVALID },
  });
  return { removed: res.count };
}

async function revalidateContactRows(
  workspaceId: string,
  rows: { id: string; phone: string; status: ContactStatus }[]
): Promise<{ updated: number; whatsappChecked: boolean }> {
  let updated = 0;
  type Valid = {
    id: string;
    e164: string;
    prevPhone: string;
    prevStatus: ContactStatus;
  };
  const valid: Valid[] = [];

  for (const c of rows) {
    const strict = validateAndFormatPhone(c.phone);
    const v = strict.valid
      ? strict
      : validatePhoneForGrabberImport(c.phone);
    if (!v.valid) {
      if (c.status !== ContactStatus.INVALID) {
        await prisma.contact.update({
          where: { id: c.id },
          data: { status: ContactStatus.INVALID },
        });
        updated += 1;
      }
      continue;
    }
    valid.push({
      id: c.id,
      e164: v.e164,
      prevPhone: c.phone,
      prevStatus: c.status,
    });
  }

  let whatsappChecked = false;
  let waByE164: Map<string, boolean> | null = null;
  if (valid.length > 0 && env.WHATSAPP_BRIDGE_ENABLED) {
    const unique = [...new Set(valid.map((x) => x.e164))];
    waByE164 = await checkE164RegisteredOnWhatsApp(workspaceId, unique);
    whatsappChecked = waByE164 !== null;
  }

  for (const c of valid) {
    let nextStatus: ContactStatus;
    if (waByE164 !== null) {
      nextStatus = waByE164.get(c.e164)
        ? ContactStatus.VERIFIED
        : ContactStatus.UNVERIFIED;
    } else {
      nextStatus =
        c.prevStatus === ContactStatus.INVALID
          ? ContactStatus.UNVERIFIED
          : c.prevStatus;
    }

    if (c.prevPhone !== c.e164 || c.prevStatus !== nextStatus) {
      await prisma.contact.update({
        where: { id: c.id },
        data: { phone: c.e164, status: nextStatus },
      });
      updated += 1;
    }
  }

  return { updated, whatsappChecked };
}

export async function revalidateAllContactsInWorkspace(
  workspaceId: string
): Promise<{ updated: number; whatsappChecked: boolean }> {
  const contacts = await prisma.contact.findMany({
    where: { group: { workspaceId } },
    select: { id: true, phone: true, status: true },
  });
  return revalidateContactRows(workspaceId, contacts);
}

export async function revalidateContactsInGroup(
  workspaceId: string,
  groupId: string
): Promise<{ updated: number; whatsappChecked: boolean }> {
  await assertGroupInWorkspace(workspaceId, groupId);
  const contacts = await prisma.contact.findMany({
    where: { groupId },
    select: { id: true, phone: true, status: true },
  });
  return revalidateContactRows(workspaceId, contacts);
}

export async function updateContact(
  workspaceId: string,
  contactId: string,
  input: { name?: string; phone?: string; status?: ContactStatusApi }
): Promise<ContactRowJson> {
  const c = await prisma.contact.findFirst({
    where: {
      id: contactId,
      group: { workspaceId },
    },
  });
  if (!c) {
    throw new AppError(404, "Contact not found", "NOT_FOUND");
  }

  let phone = c.phone;
  let status = c.status;
  let name = c.name;

  if (input.name !== undefined) {
    const t = input.name.trim();
    if (!t) {
      throw new AppError(400, "Name cannot be empty", "VALIDATION");
    }
    name = t.slice(0, 200);
  }

  let phoneChanged = false;
  if (input.phone !== undefined) {
    const v = validateAndFormatPhone(input.phone);
    if (!v.valid) {
      throw new AppError(400, v.message, "INVALID_PHONE");
    }
    phone = v.e164;
    phoneChanged = phone !== c.phone;
  }

  if (phoneChanged) {
    status = ContactStatus.UNVERIFIED;
  } else if (input.status !== undefined) {
    status = apiToStatus(input.status);
  }

  try {
    const next = await prisma.contact.update({
      where: { id: contactId },
      data: { name, phone, status },
    });
    return contactToRow(next);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new AppError(
        409,
        "This phone number is already in the group",
        "DUPLICATE_PHONE"
      );
    }
    throw e;
  }
}

export async function deleteContact(
  workspaceId: string,
  contactId: string
): Promise<void> {
  const c = await prisma.contact.findFirst({
    where: {
      id: contactId,
      group: { workspaceId },
    },
    select: { id: true },
  });
  if (!c) {
    throw new AppError(404, "Contact not found", "NOT_FOUND");
  }
  await prisma.contact.delete({ where: { id: contactId } });
}
