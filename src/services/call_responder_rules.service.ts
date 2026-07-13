import {
  CallResponderCallType,
  CallResponderMessageMode,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { requireActiveTemplate } from "./templates.service";

export type CallResponderCallTypeApi =
  | "received"
  | "outgoing"
  | "missed"
  | "rejected";

export type CallResponderMessageModeApi = "text" | "template";

export type CallResponderRuleJson = {
  id: string;
  name: string;
  deviceId: string;
  deviceLabel: string;
  callTypes: CallResponderCallTypeApi[];
  responseDelayMinutes: number;
  messageFormType: CallResponderMessageModeApi;
  messageBody: string | null;
  templateId: string | null;
  templateName: string | null;
  active: boolean;
  responsesSent: number;
  callsToday: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateCallResponderRuleInput = {
  name: string;
  deviceId: string;
  callTypes: CallResponderCallTypeApi[];
  responseDelayMinutes: number;
  messageFormType: CallResponderMessageModeApi;
  messageBody?: string | null;
  templateId?: string | null;
  active?: boolean;
};

export type UpdateCallResponderRuleInput = Partial<
  Omit<CreateCallResponderRuleInput, "deviceId">
> & {
  deviceId?: string;
};

function deviceLabel(d: { name: string; phone: string | null }): string {
  return d.phone ? `${d.name} · ${d.phone}` : d.name;
}

function toPrismaCallType(t: CallResponderCallTypeApi): CallResponderCallType {
  switch (t) {
    case "received":
      return CallResponderCallType.RECEIVED;
    case "outgoing":
      return CallResponderCallType.OUTGOING;
    case "rejected":
      return CallResponderCallType.REJECTED;
    case "missed":
    default:
      return CallResponderCallType.MISSED;
  }
}

function fromPrismaCallType(t: CallResponderCallType): CallResponderCallTypeApi {
  switch (t) {
    case CallResponderCallType.RECEIVED:
      return "received";
    case CallResponderCallType.OUTGOING:
      return "outgoing";
    case CallResponderCallType.REJECTED:
      return "rejected";
    case CallResponderCallType.MISSED:
    default:
      return "missed";
  }
}

function toPrismaMessageMode(
  t: CallResponderMessageModeApi
): CallResponderMessageMode {
  return t === "template"
    ? CallResponderMessageMode.TEMPLATE
    : CallResponderMessageMode.TEXT;
}

function fromPrismaMessageMode(
  t: CallResponderMessageMode
): CallResponderMessageModeApi {
  return t === CallResponderMessageMode.TEMPLATE ? "template" : "text";
}

function toJson(row: {
  id: string;
  name: string;
  deviceId: string;
  callTypes: CallResponderCallType[];
  responseDelayMinutes: number;
  messageMode: CallResponderMessageMode;
  messageBody: string | null;
  templateId: string | null;
  active: boolean;
  responsesSent: number;
  createdAt: Date;
  updatedAt: Date;
  device: { name: string; phone: string | null };
  template: { name: string } | null;
}): CallResponderRuleJson {
  return {
    id: row.id,
    name: row.name,
    deviceId: row.deviceId,
    deviceLabel: deviceLabel(row.device),
    callTypes: row.callTypes.map(fromPrismaCallType),
    responseDelayMinutes: row.responseDelayMinutes,
    messageFormType: fromPrismaMessageMode(row.messageMode),
    messageBody: row.messageBody,
    templateId: row.templateId,
    templateName: row.template?.name ?? null,
    active: row.active,
    responsesSent: row.responsesSent,
    callsToday: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const include = {
  device: { select: { name: true, phone: true } },
  template: { select: { name: true } },
} as const;

async function assertDeviceInWorkspace(workspaceId: string, deviceId: string) {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, workspaceId },
    select: { id: true },
  });
  if (!device) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }
}

async function validateRuleInput(
  workspaceId: string,
  input: CreateCallResponderRuleInput | UpdateCallResponderRuleInput,
  existing?: { messageMode: CallResponderMessageMode; messageBody: string | null; templateId: string | null }
) {
  if (input.deviceId) {
    await assertDeviceInWorkspace(workspaceId, input.deviceId);
  }

  const name = input.name?.trim();
  if (input.name !== undefined && !name) {
    throw new AppError(400, "Rule name is required", "VALIDATION");
  }

  if (input.callTypes !== undefined && input.callTypes.length === 0) {
    throw new AppError(400, "Select at least one call type", "VALIDATION");
  }

  const nextMode =
    input.messageFormType !== undefined
      ? toPrismaMessageMode(input.messageFormType)
      : existing?.messageMode;
  const nextBody =
    input.messageBody !== undefined
      ? input.messageBody?.trim() ?? null
      : existing?.messageBody ?? null;
  const nextTemplateId =
    input.templateId !== undefined
      ? input.templateId?.trim() || null
      : existing?.templateId ?? null;

  if (nextMode === CallResponderMessageMode.TEXT && !nextBody) {
    throw new AppError(400, "Message content is required", "VALIDATION");
  }
  if (nextMode === CallResponderMessageMode.TEMPLATE) {
    if (!nextTemplateId) {
      throw new AppError(400, "Template is required", "VALIDATION");
    }
    await requireActiveTemplate(workspaceId, nextTemplateId);
  }
}

export async function listCallResponderRules(
  workspaceId: string
): Promise<CallResponderRuleJson[]> {
  const rows = await prisma.callResponderRule.findMany({
    where: { workspaceId },
    include,
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toJson);
}

export async function createCallResponderRule(
  workspaceId: string,
  input: CreateCallResponderRuleInput
): Promise<CallResponderRuleJson> {
  await validateRuleInput(workspaceId, input);

  const mode = toPrismaMessageMode(input.messageFormType);
  const row = await prisma.callResponderRule.create({
    data: {
      workspaceId,
      deviceId: input.deviceId,
      name: input.name.trim().slice(0, 200),
      callTypes: [...new Set(input.callTypes)].map(toPrismaCallType),
      responseDelayMinutes: Math.min(
        1440,
        Math.max(0, Math.floor(input.responseDelayMinutes || 0))
      ),
      messageMode: mode,
      messageBody:
        mode === CallResponderMessageMode.TEXT
          ? input.messageBody?.trim().slice(0, 4096)
          : null,
      templateId:
        mode === CallResponderMessageMode.TEMPLATE
          ? input.templateId?.trim()
          : null,
      active: input.active ?? true,
    },
    include,
  });
  return toJson(row);
}

export async function updateCallResponderRule(
  workspaceId: string,
  ruleId: string,
  input: UpdateCallResponderRuleInput
): Promise<CallResponderRuleJson> {
  const existing = await prisma.callResponderRule.findFirst({
    where: { id: ruleId, workspaceId },
  });
  if (!existing) {
    throw new AppError(404, "Rule not found", "NOT_FOUND");
  }

  await validateRuleInput(workspaceId, input, existing);

  const nextMode =
    input.messageFormType !== undefined
      ? toPrismaMessageMode(input.messageFormType)
      : existing.messageMode;
  const row = await prisma.callResponderRule.update({
    where: { id: ruleId },
    data: {
      ...(input.name !== undefined
        ? { name: input.name.trim().slice(0, 200) }
        : {}),
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.callTypes !== undefined
        ? { callTypes: [...new Set(input.callTypes)].map(toPrismaCallType) }
        : {}),
      ...(input.responseDelayMinutes !== undefined
        ? {
            responseDelayMinutes: Math.min(
              1440,
              Math.max(0, Math.floor(input.responseDelayMinutes || 0))
            ),
          }
        : {}),
      ...(input.messageFormType !== undefined ? { messageMode: nextMode } : {}),
      ...(nextMode === CallResponderMessageMode.TEXT
        ? {
            messageBody:
              input.messageBody !== undefined
                ? input.messageBody?.trim().slice(0, 4096)
                : existing.messageBody,
            templateId: null,
          }
        : {
            messageBody: null,
            templateId:
              input.templateId !== undefined
                ? input.templateId?.trim()
                : existing.templateId,
          }),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
    include,
  });
  return toJson(row);
}

export async function deleteCallResponderRule(
  workspaceId: string,
  ruleId: string
): Promise<void> {
  const existing = await prisma.callResponderRule.findFirst({
    where: { id: ruleId, workspaceId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, "Rule not found", "NOT_FOUND");
  }
  await prisma.callResponderRule.delete({ where: { id: ruleId } });
}
