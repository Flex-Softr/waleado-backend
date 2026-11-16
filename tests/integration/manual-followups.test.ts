import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approveAllSuggestions,
  createManualFollowUp,
  deleteFollowUp,
  getFollowUpSettings,
  listFollowUps,
  saveFollowUpSettings,
  updateFollowUp,
} from "../../src/services/followups.service";
import { prisma, resetDb } from "../helpers/db";
import { createWorkspace } from "../helpers/factories";

beforeEach(resetDb);

async function createDevice(workspaceId: string): Promise<string> {
  const d = await prisma.device.create({
    data: { workspaceId, name: "Test phone", sessionId: randomUUID() },
  });
  return d.id;
}

const inDays = (n: number) => new Date(Date.now() + n * 24 * 3_600_000);

describe("manual follow-ups", () => {
  it("adds a number by hand as a locked, scheduled plan", async () => {
    const ws = await createWorkspace();
    const deviceId = await createDevice(ws.id);

    const { item, everMessaged } = await createManualFollowUp(ws.id, {
      deviceId,
      phone: "+8801712345678",
      name: "Rahim",
      note: "Asked about hosting",
      followUpAt: inDays(3),
      followUpMessage: "  Hello Rahim  ",
    });

    expect(item.peerPhone).toBe("+8801712345678");
    expect(item.displayTitle).toBe("Rahim");
    expect(item.source).toBe("MANUAL");
    expect(item.manualLock).toBe(true);
    expect(item.followUpStatus).toBe("SCHEDULED");
    expect(item.followUpMessage).toBe("Hello Rahim");
    expect(item.note).toBe("Asked about hosting");
    expect(everMessaged).toBe(false);
  });

  it("updates the same contact instead of creating a second row", async () => {
    const ws = await createWorkspace();
    const deviceId = await createDevice(ws.id);
    const base = { deviceId, phone: "+8801712345678", followUpAt: inDays(1) };

    const first = await createManualFollowUp(ws.id, { ...base, followUpMessage: "one" });
    await updateFollowUp(ws.id, first.item.id, { stage: "CONVERTED" });
    const second = await createManualFollowUp(ws.id, { ...base, followUpMessage: "two" });

    expect(second.item.id).toBe(first.item.id);
    expect(second.item.followUpMessage).toBe("two");
    // Adding a converted contact back reopens it.
    expect(second.item.stage).toBe("INTERESTED");
    expect(second.item.followUpStatus).toBe("SCHEDULED");
    expect(await prisma.conversationFollowUp.count({ where: { workspaceId: ws.id } })).toBe(1);
  });

  it("rejects bad numbers and other workspaces' devices", async () => {
    const ws = await createWorkspace();
    const other = await createWorkspace();
    const deviceId = await createDevice(ws.id);
    const plan = { followUpAt: inDays(1), followUpMessage: "hi" };

    await expect(
      createManualFollowUp(ws.id, { deviceId, phone: "abc", ...plan })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createManualFollowUp(other.id, { deviceId, phone: "+8801712345678", ...plan })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("locks a plan when the owner edits it and unlocks on request", async () => {
    const ws = await createWorkspace();
    const deviceId = await createDevice(ws.id);
    const row = await prisma.conversationFollowUp.create({
      data: {
        workspaceId: ws.id,
        deviceId,
        peerKey: "+8801700000001",
        peerPhone: "+8801700000001",
        followUpStatus: "SUGGESTED",
        followUpAt: inDays(2),
        followUpMessage: "AI draft",
        lastConversationAt: new Date(),
      },
    });

    // Approving as-is keeps the AI in control.
    const approved = await updateFollowUp(ws.id, row.id, { followUpStatus: "SCHEDULED" });
    expect(approved.followUpStatus).toBe("SCHEDULED");
    expect(approved.manualLock).toBe(false);

    const edited = await updateFollowUp(ws.id, row.id, { followUpMessage: "My own words" });
    expect(edited.manualLock).toBe(true);

    const released = await updateFollowUp(ws.id, row.id, { manualLock: false });
    expect(released.manualLock).toBe(false);
  });

  it("approves all ready suggestions and lists them by view", async () => {
    const ws = await createWorkspace();
    const deviceId = await createDevice(ws.id);
    const mk = (n: number, extra: Record<string, unknown> = {}) =>
      prisma.conversationFollowUp.create({
        data: {
          workspaceId: ws.id,
          deviceId,
          peerKey: `+88017000000${n}`,
          peerPhone: `+88017000000${n}`,
          followUpStatus: "SUGGESTED",
          followUpAt: inDays(n),
          followUpMessage: "draft",
          lastConversationAt: new Date(),
          ...extra,
        },
      });
    await mk(11);
    await mk(12);
    await mk(13, { stage: "LOST" });

    expect(await listFollowUps(ws.id, { view: "suggested" })).toHaveLength(3);
    expect(await approveAllSuggestions(ws.id)).toEqual({ approved: 2 });
    expect(await listFollowUps(ws.id, { view: "scheduled" })).toHaveLength(2);
  });

  it("removes a contact and keeps other workspaces' rows safe", async () => {
    const ws = await createWorkspace();
    const other = await createWorkspace();
    const deviceId = await createDevice(ws.id);
    const { item } = await createManualFollowUp(ws.id, {
      deviceId,
      phone: "+8801712345678",
      followUpAt: inDays(1),
      followUpMessage: "hi",
    });

    await expect(deleteFollowUp(other.id, item.id)).rejects.toMatchObject({ statusCode: 404 });
    await deleteFollowUp(ws.id, item.id);
    expect(await prisma.conversationFollowUp.count()).toBe(0);
  });

  it("defaults to suggest mode and saves the AI mode", async () => {
    const ws = await createWorkspace();
    expect((await getFollowUpSettings(ws.id)).aiMode).toBe("SUGGEST");
    const saved = await saveFollowUpSettings(ws.id, { aiMode: "OFF" });
    expect(saved.aiMode).toBe("OFF");
    expect(saved.configured).toBe(true);
  });
});
