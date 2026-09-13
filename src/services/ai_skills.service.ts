import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";

export type AiSkillJson = {
  id: string;
  name: string;
  description: string | null;
  rolePrompt: string;
  servicesDescription: string;
  businessKnowledge: string;
  customInstructions: string | null;
  aiCredentialId: string | null;
  aiCredentialName: string | null;
  model: string | null;
  temperature: number;
  maxTokens: number | null;
  continuousChat: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateAiSkillInput = {
  name: string;
  description?: string | null;
  rolePrompt: string;
  servicesDescription: string;
  businessKnowledge: string;
  customInstructions?: string | null;
  aiCredentialId?: string | null;
  model?: string | null;
  temperature?: number;
  maxTokens?: number | null;
  continuousChat?: boolean;
  active?: boolean;
};

export type UpdateAiSkillInput = Partial<CreateAiSkillInput>;

function toJson(row: {
  id: string;
  name: string;
  description: string | null;
  rolePrompt: string;
  servicesDescription: string;
  businessKnowledge: string;
  customInstructions: string | null;
  aiCredentialId: string | null;
  aiCredential?: { name: string } | null;
  model: string | null;
  temperature: number;
  maxTokens: number | null;
  continuousChat: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AiSkillJson {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rolePrompt: row.rolePrompt,
    servicesDescription: row.servicesDescription,
    businessKnowledge: row.businessKnowledge,
    customInstructions: row.customInstructions,
    aiCredentialId: row.aiCredentialId,
    aiCredentialName: row.aiCredential?.name ?? null,
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    continuousChat: row.continuousChat,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function buildSystemPromptFromSkill(skill: {
  rolePrompt: string;
  servicesDescription: string;
  businessKnowledge: string;
  customInstructions?: string | null;
}): string {
  const parts: string[] = [
    "You are an AI assistant representing this business in WhatsApp chat. Respond conversationally, accurately, and politely to incoming customer messages.",
    "",
    "### YOUR ROLE & PERSONA",
    skill.rolePrompt.trim(),
    "",
    "### SERVICES & PRODUCTS PROVIDED",
    skill.servicesDescription.trim(),
    "",
    "### BUSINESS KNOWLEDGE BASE",
    skill.businessKnowledge.trim(),
  ];

  if (skill.customInstructions?.trim()) {
    parts.push(
      "",
      "### INSTRUCTIONS & GUIDELINES",
      skill.customInstructions.trim()
    );
  }

  parts.push(
    "",
    "### GENERAL RULES",
    "- Answer strictly based on the role, services, and business knowledge provided above.",
    "- If you do not know the answer or if the customer's query is outside the provided knowledge, politely say you don't have that information and suggest contacting a human support agent.",
    "- Keep WhatsApp replies concise, helpful, and easy to read on mobile devices.",
    "- When continuous chat history is provided, maintain conversation context and follow up naturally on previous messages."
  );

  return parts.join("\n");
}

export async function listAiSkills(workspaceId: string): Promise<AiSkillJson[]> {
  const rows = await prisma.aiSkill.findMany({
    where: { workspaceId },
    include: {
      aiCredential: { select: { name: true } },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(toJson);
}

export async function getAiSkill(
  workspaceId: string,
  skillId: string
): Promise<AiSkillJson> {
  const row = await prisma.aiSkill.findFirst({
    where: { id: skillId, workspaceId },
    include: {
      aiCredential: { select: { name: true } },
    },
  });
  if (!row) {
    throw new AppError(404, "AI Skill not found", "NOT_FOUND");
  }
  return toJson(row);
}

export async function createAiSkill(
  workspaceId: string,
  input: CreateAiSkillInput
): Promise<AiSkillJson> {
  const name = input.name.trim();
  if (!name) {
    throw new AppError(400, "Skill name is required", "VALIDATION");
  }
  if (!input.rolePrompt.trim()) {
    throw new AppError(400, "Role description is required", "VALIDATION");
  }
  if (!input.servicesDescription.trim()) {
    throw new AppError(400, "Services description is required", "VALIDATION");
  }
  if (!input.businessKnowledge.trim()) {
    throw new AppError(400, "Business knowledge is required", "VALIDATION");
  }

  if (input.aiCredentialId) {
    const cred = await prisma.aiCredential.findFirst({
      where: { id: input.aiCredentialId, workspaceId },
    });
    if (!cred) {
      throw new AppError(400, "Selected AI credential does not exist", "VALIDATION");
    }
  }

  const existing = await prisma.aiSkill.findFirst({
    where: { workspaceId, name },
  });
  if (existing) {
    throw new AppError(409, "A skill with this name already exists", "CONFLICT");
  }

  const row = await prisma.aiSkill.create({
    data: {
      workspaceId,
      name,
      description: input.description?.trim() || null,
      rolePrompt: input.rolePrompt.trim(),
      servicesDescription: input.servicesDescription.trim(),
      businessKnowledge: input.businessKnowledge.trim(),
      customInstructions: input.customInstructions?.trim() || null,
      aiCredentialId: input.aiCredentialId || null,
      model: input.model?.trim() || null,
      temperature:
        typeof input.temperature === "number" && !Number.isNaN(input.temperature)
          ? Math.min(2, Math.max(0, input.temperature))
          : 0.7,
      maxTokens:
        typeof input.maxTokens === "number" && input.maxTokens > 0
          ? Math.min(4096, input.maxTokens)
          : 1024,
      continuousChat: input.continuousChat ?? true,
      active: input.active ?? true,
    },
    include: {
      aiCredential: { select: { name: true } },
    },
  });

  return toJson(row);
}

export async function updateAiSkill(
  workspaceId: string,
  skillId: string,
  input: UpdateAiSkillInput
): Promise<AiSkillJson> {
  const existing = await prisma.aiSkill.findFirst({
    where: { id: skillId, workspaceId },
  });
  if (!existing) {
    throw new AppError(404, "AI Skill not found", "NOT_FOUND");
  }

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      throw new AppError(400, "Skill name cannot be empty", "VALIDATION");
    }
    if (name !== existing.name) {
      const conflict = await prisma.aiSkill.findFirst({
        where: { workspaceId, name, NOT: { id: skillId } },
      });
      if (conflict) {
        throw new AppError(409, "A skill with this name already exists", "CONFLICT");
      }
    }
  }

  if (input.aiCredentialId) {
    const cred = await prisma.aiCredential.findFirst({
      where: { id: input.aiCredentialId, workspaceId },
    });
    if (!cred) {
      throw new AppError(400, "Selected AI credential does not exist", "VALIDATION");
    }
  }

  const updated = await prisma.aiSkill.update({
    where: { id: skillId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim() || null }
        : {}),
      ...(input.rolePrompt !== undefined
        ? { rolePrompt: input.rolePrompt.trim() }
        : {}),
      ...(input.servicesDescription !== undefined
        ? { servicesDescription: input.servicesDescription.trim() }
        : {}),
      ...(input.businessKnowledge !== undefined
        ? { businessKnowledge: input.businessKnowledge.trim() }
        : {}),
      ...(input.customInstructions !== undefined
        ? { customInstructions: input.customInstructions?.trim() || null }
        : {}),
      ...(input.aiCredentialId !== undefined
        ? { aiCredentialId: input.aiCredentialId || null }
        : {}),
      ...(input.model !== undefined ? { model: input.model?.trim() || null } : {}),
      ...(input.temperature !== undefined
        ? {
            temperature: Math.min(2, Math.max(0, input.temperature)),
          }
        : {}),
      ...(input.maxTokens !== undefined
        ? {
            maxTokens:
              input.maxTokens && input.maxTokens > 0
                ? Math.min(4096, input.maxTokens)
                : null,
          }
        : {}),
      ...(input.continuousChat !== undefined
        ? { continuousChat: input.continuousChat }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
    include: {
      aiCredential: { select: { name: true } },
    },
  });

  return toJson(updated);
}

export async function deleteAiSkill(
  workspaceId: string,
  skillId: string
): Promise<{ deleted: true }> {
  const existing = await prisma.aiSkill.findFirst({
    where: { id: skillId, workspaceId },
  });
  if (!existing) {
    throw new AppError(404, "AI Skill not found", "NOT_FOUND");
  }

  await prisma.aiSkill.delete({
    where: { id: skillId },
  });

  return { deleted: true };
}
