"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listChatbotFlows = listChatbotFlows;
exports.createChatbotFlow = createChatbotFlow;
exports.updateChatbotFlow = updateChatbotFlow;
exports.deleteChatbotFlow = deleteChatbotFlow;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const templates_service_1 = require("./templates.service");
function deviceLabel(d) {
    return d.phone ? `${d.name} · ${d.phone}` : d.name;
}
function parseNodeKind(k) {
    const m = {
        message: client_1.ChatbotFlowNodeKind.MESSAGE,
        question: client_1.ChatbotFlowNodeKind.QUESTION,
        action: client_1.ChatbotFlowNodeKind.ACTION,
        condition: client_1.ChatbotFlowNodeKind.CONDITION,
    };
    const v = m[k];
    if (!v) {
        throw new errors_1.AppError(400, "Invalid node kind", "VALIDATION");
    }
    return v;
}
function formatNodeKind(k) {
    return k.toLowerCase();
}
function nodeToJson(row) {
    const base = {
        id: row.id,
        name: row.name,
        kind: formatNodeKind(row.kind),
        sortOrder: row.sortOrder,
    };
    if (row.kind !== client_1.ChatbotFlowNodeKind.MESSAGE || !row.payload || typeof row.payload !== "object") {
        return base;
    }
    const p = row.payload;
    const messageFormType = p.messageFormType === "template" ? "template" : "text";
    return {
        ...base,
        messageFormType,
        messageBody: typeof p.messageBody === "string" ? p.messageBody : undefined,
        templateId: typeof p.templateId === "string" ? p.templateId : null,
        templateName: typeof p.templateName === "string" ? p.templateName : null,
        attachmentType: typeof p.attachmentType === "string" ? p.attachmentType : null,
    };
}
function flowToJson(row) {
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
        orderBy: { sortOrder: "asc" },
    },
};
async function validateNodes(workspaceId, nodes) {
    for (const n of nodes) {
        if (n.kind !== "message")
            continue;
        const p = n.payload ?? {};
        const mft = p.messageFormType === "template" ? "template" : "text";
        if (mft === "text") {
            const body = typeof p.messageBody === "string" ? p.messageBody.trim() : "";
            if (!body) {
                throw new errors_1.AppError(400, "Message nodes need non-empty message text", "VALIDATION");
            }
        }
        else {
            const tid = typeof p.templateId === "string" ? p.templateId.trim() : "";
            if (!tid) {
                throw new errors_1.AppError(400, "Message nodes using template must include templateId", "VALIDATION");
            }
            await (0, templates_service_1.requireActiveTemplate)(workspaceId, tid);
        }
    }
}
async function listChatbotFlows(workspaceId) {
    const rows = await prisma_1.prisma.chatbotFlow.findMany({
        where: { workspaceId },
        include: flowInclude,
        orderBy: { updatedAt: "desc" },
    });
    return rows.map(flowToJson);
}
async function createChatbotFlow(workspaceId, input) {
    const device = await prisma_1.prisma.device.findFirst({
        where: { id: input.deviceId, workspaceId },
    });
    if (!device) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    const name = input.name.trim();
    const kw = input.triggerKeywords.trim();
    if (!name) {
        throw new errors_1.AppError(400, "Flow name is required", "VALIDATION");
    }
    if (!kw) {
        throw new errors_1.AppError(400, "Trigger keywords are required", "VALIDATION");
    }
    await validateNodes(workspaceId, input.nodes);
    const flow = await prisma_1.prisma.$transaction(async (tx) => {
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
                    payload: n.payload != null
                        ? n.payload
                        : client_1.Prisma.JsonNull,
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
async function updateChatbotFlow(workspaceId, flowId, input) {
    const existing = await prisma_1.prisma.chatbotFlow.findFirst({
        where: { id: flowId, workspaceId },
    });
    if (!existing) {
        throw new errors_1.AppError(404, "Flow not found", "NOT_FOUND");
    }
    let deviceId = existing.deviceId;
    if (input.deviceId !== undefined) {
        const device = await prisma_1.prisma.device.findFirst({
            where: { id: input.deviceId, workspaceId },
        });
        if (!device) {
            throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
        }
        deviceId = input.deviceId;
    }
    if (input.nodes) {
        await validateNodes(workspaceId, input.nodes);
    }
    const flow = await prisma_1.prisma.$transaction(async (tx) => {
        const data = {
            device: { connect: { id: deviceId } },
        };
        if (input.name !== undefined) {
            const t = input.name.trim();
            if (!t)
                throw new errors_1.AppError(400, "Flow name is required", "VALIDATION");
            data.name = t.slice(0, 200);
        }
        if (input.description !== undefined) {
            data.description = input.description.trim().slice(0, 2000);
        }
        if (input.triggerKeywords !== undefined) {
            const t = input.triggerKeywords.trim();
            if (!t) {
                throw new errors_1.AppError(400, "Trigger keywords are required", "VALIDATION");
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
                        payload: n.payload != null
                            ? n.payload
                            : client_1.Prisma.JsonNull,
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
async function deleteChatbotFlow(workspaceId, flowId) {
    const existing = await prisma_1.prisma.chatbotFlow.findFirst({
        where: { id: flowId, workspaceId },
        select: { id: true },
    });
    if (!existing) {
        throw new errors_1.AppError(404, "Flow not found", "NOT_FOUND");
    }
    await prisma_1.prisma.chatbotFlow.delete({ where: { id: flowId } });
}
