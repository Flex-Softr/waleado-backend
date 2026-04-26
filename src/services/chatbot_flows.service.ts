import { ChatbotFlowNodeKind, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { requireActiveTemplate } from "./templates.service";

export type ChatbotFlowNodeJson = {
  id: string;
  name: string;
  kind: "message" | "question" | "action" | "condition";
  sortOrder: number;
  messageFormType?: "text" | "template";
  messageBody?: string;
  templateId?: string | null;
  templateName?: string | null;
  attachmentType?: string | null;
};

export type ChatbotFlowListItemJson = {
  id: string;
  name: string;
  description: string;
  deviceId: string;
  deviceLabel: string;
  triggerKeywords: string;
  cooldownMinutes: number;
  active: boolean;
  conversationCount: number;
  nodes: ChatbotFlowNodeJson[];
  createdAt: string;
  updatedAt: string;
};

function deviceLabel(d: { name: string; phone: string | null }): string {
  return d.phone ? `${d.name} · ${d.phone}` : d.name;
}

function parseNodeKind(
  k: string
): ChatbotFlowNodeKind {
  const m: Record<string, ChatbotFlowNodeKind> = {
    message: ChatbotFlowNodeKind.MESSAGE,
    question: ChatbotFlowNodeKind.QUESTION,
    action: ChatbotFlowNodeKind.ACTION,
    condition: ChatbotFlowNodeKind.CONDITION,
  };
  const v = m[k];
  if (!v) {
    throw new AppError(400, "Invalid node kind", "VALIDATION");
  }
  return v;
}

function formatNodeKind(k: ChatbotFlowNodeKind): ChatbotFlowNodeJson["kind"] {
  return k.toLowerCase() as ChatbotFlowNodeJson["kind"];
}

function nodeToJson(row: {
  id: string;
  name: string;
  kind: ChatbotFlowNodeKind;
  sortOrder: number;
  payload: Prisma.JsonValue | null;
}): ChatbotFlowNodeJson {
  const base: ChatbotFlowNodeJson = {
    id: row.id,
    name: row.name,
    kind: formatNodeKind(row.kind),
    sortOrder: row.sortOrder,
  };
  if (row.kind !== ChatbotFlowNodeKind.MESSAGE || !row.payload || typeof row.payload !== "object") {
    return base;
  }
  const p = row.payload as Record<string, unknown>;
  const messageFormType = p.messageFormType === "template" ? "template" : "text";
  return {
    ...base,
    messageFormType,
    messageBody: typeof p.messageBody === "string" ? p.messageBody : undefined,
    templateId: typeof p.templateId === "string" ? p.templateId : null,
    templateName: typeof p.templateName === "string" ? p.templateName : null,
    attachmentType:
      typeof p.attachmentType === "string" ? p.attachmentType : null,
  };
}

function flowToJson(row: {
  id: string;
  name: string;
  description: string;
  deviceId: string;
  triggerKeywords: string;
  cooldownMinutes: number;
  active: boolean;
  conversationCount: number;
  createdAt: Date;
  updatedAt: Date;
  device: { name: string; phone: string | null };
  nodes: {
    id: string;
    name: string;
    kind: ChatbotFlowNodeKind;
    sortOrder: number;
    payload: Prisma.JsonValue | null;
  }[];
}): ChatbotFlowListItemJson {
  const sorted = [...row.nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    deviceId: row.deviceId,
    deviceLabel: deviceLabel(row.device),
    triggerKeywords: row.triggerKeywords,
    cooldownMinutes: row.cooldownMinutes,
    active: row.active,
    conversationCount: row.conversationCount,
    nodes: sorted.map(nodeToJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const flowInclude = {
  device: { select: { name: true, phone: true } },
  nodes: {
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

export type FlowNodeInput = {
  name: string;
  kind: "message" | "question" | "action" | "condition";
  sortOrder: number;
  payload?: Record<string, unknown> | null;
};

async function validateNodes(
  workspaceId: string,
  nodes: FlowNodeInput[]
): Promise<void> {
  for (const n of nodes) {
    if (n.kind !== "message") continue;
    const p = n.payload ?? {};
    const mft = p.messageFormType === "template" ? "template" : "text";
    if (mft === "text") {
      const body = typeof p.messageBody === "string" ? p.messageBody.trim() : "";
      if (!body) {
        throw new AppError(
          400,
          "Message nodes need non-empty message text",
          "VALIDATION"
        );
      }
    } else {
      const tid =
        typeof p.templateId === "string" ? p.templateId.trim() : "";
      if (!tid) {
        throw new AppError(
          400,
          "Message nodes using template must include templateId",
          "VALIDATION"
        );
      }
      await requireActiveTemplate(workspaceId, tid);
    }
  }
}

export async function listChatbotFlows(
  workspaceId: string
): Promise<ChatbotFlowListItemJson[]> {
  const rows = await prisma.chatbotFlow.findMany({
    where: { workspaceId },
    include: flowInclude,
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(flowToJson);
}

export async function createChatbotFlow(
  workspaceId: string,
  input: {
    name: string;
    description: string;
    deviceId: string;
    triggerKeywords: string;
    cooldownMinutes: number;
    active: boolean;
    nodes: FlowNodeInput[];
  }
): Promise<ChatbotFlowListItemJson> {
  const device = await prisma.device.findFirst({
    where: { id: input.deviceId, workspaceId },
  });
  if (!device) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }

  const name = input.name.trim();
  const kw = input.triggerKeywords.trim();
  if (!name) {
    throw new AppError(400, "Flow name is required", "VALIDATION");
  }
  if (!kw) {
    throw new AppError(400, "Trigger keywords are required", "VALIDATION");
  }

  await validateNodes(workspaceId, input.nodes);

  const flow = await prisma.$transaction(async (tx) => {
    const f = await tx.chatbotFlow.create({
      data: {
        workspaceId,
        deviceId: input.deviceId,
        name: name.slice(0, 200),
        description: input.description.trim().slice(0, 2000),
        triggerKeywords: kw.slice(0, 1000),
        cooldownMinutes: Math.min(10080, Math.max(0, input.cooldownMinutes)),
        active: input.active,
      },
    });

    for (const n of input.nodes) {
      await tx.chatbotFlowNode.create({
        data: {
          flowId: f.id,
          sortOrder: n.sortOrder,
          name: n.name.trim().slice(0, 200),
          kind: parseNodeKind(n.kind),
          payload:
            n.payload != null
              ? (n.payload as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      });
    }

    return tx.chatbotFlow.findUniqueOrThrow({
      where: { id: f.id },
      include: flowInclude,
    });
  });

  return flowToJson(flow);
}

export async function updateChatbotFlow(
  workspaceId: string,
  flowId: string,
  input: {
    name?: string;
    description?: string;
    deviceId?: string;
    triggerKeywords?: string;
    cooldownMinutes?: number;
    active?: boolean;
    nodes?: FlowNodeInput[];
  }
): Promise<ChatbotFlowListItemJson> {
  const existing = await prisma.chatbotFlow.findFirst({
    where: { id: flowId, workspaceId },
  });
  if (!existing) {
    throw new AppError(404, "Flow not found", "NOT_FOUND");
  }

  let deviceId = existing.deviceId;
  if (input.deviceId !== undefined) {
    const device = await prisma.device.findFirst({
      where: { id: input.deviceId, workspaceId },
    });
    if (!device) {
      throw new AppError(404, "Device not found", "NOT_FOUND");
    }
    deviceId = input.deviceId;
  }

  if (input.nodes) {
    await validateNodes(workspaceId, input.nodes);
  }

  const flow = await prisma.$transaction(async (tx) => {
    const data: Prisma.ChatbotFlowUpdateInput = {
      device: { connect: { id: deviceId } },
    };
    if (input.name !== undefined) {
      const t = input.name.trim();
      if (!t) throw new AppError(400, "Flow name is required", "VALIDATION");
      data.name = t.slice(0, 200);
    }
    if (input.description !== undefined) {
      data.description = input.description.trim().slice(0, 2000);
    }
    if (input.triggerKeywords !== undefined) {
      const t = input.triggerKeywords.trim();
      if (!t) {
        throw new AppError(400, "Trigger keywords are required", "VALIDATION");
      }
      data.triggerKeywords = t.slice(0, 1000);
    }
    if (input.cooldownMinutes !== undefined) {
      data.cooldownMinutes = Math.min(10080, Math.max(0, input.cooldownMinutes));
    }
    if (input.active !== undefined) {
      data.active = input.active;
    }

    await tx.chatbotFlow.update({
      where: { id: flowId },
      data,
    });

    if (input.nodes) {
      await tx.chatbotFlowNode.deleteMany({ where: { flowId } });
      for (const n of input.nodes) {
        await tx.chatbotFlowNode.create({
          data: {
            flowId,
            sortOrder: n.sortOrder,
            name: n.name.trim().slice(0, 200),
            kind: parseNodeKind(n.kind),
            payload:
              n.payload != null
                ? (n.payload as Prisma.InputJsonValue)
                : Prisma.JsonNull,
          },
        });
      }
    }

    return tx.chatbotFlow.findUniqueOrThrow({
      where: { id: flowId },
      include: flowInclude,
    });
  });

  return flowToJson(flow);
}

export async function deleteChatbotFlow(
  workspaceId: string,
  flowId: string
): Promise<void> {
  const existing = await prisma.chatbotFlow.findFirst({
    where: { id: flowId, workspaceId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, "Flow not found", "NOT_FOUND");
  }
  await prisma.chatbotFlow.delete({ where: { id: flowId } });
}
