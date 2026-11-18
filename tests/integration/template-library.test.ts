import { beforeEach, describe, expect, it } from "vitest";
import {
  addTemplateExamples,
  createTemplate,
  duplicateTemplate,
  listTemplates,
  updateTemplate,
} from "../../src/services/templates.service";
import { resolveTemplateForSend } from "../../src/services/wa-outbound-content";
import { templateContextFor } from "../../src/services/template_context.service";
import { prisma, resetDb } from "../helpers/db";
import { createWorkspace } from "../helpers/factories";

beforeEach(resetDb);

describe("template library", () => {
  it("saves folder, tags, versions, variables and where it is shown", async () => {
    const ws = await createWorkspace();
    const t = await createTemplate(ws.id, {
      name: "Price follow-up",
      category: "  Follow up ",
      typeId: "text_message",
      content: "Hi {name}, the {plan} plan?",
      tags: ["Hosting", "hosting", "Price"],
      versions: ["Hello {name}! Still thinking about {plan}?", "Hi {name}, the {plan} plan?"],
      variables: [{ key: "name", value: "Sir" }, { key: "plan", value: "Business" }],
      showIn: ["follow_up", "live_chat"],
    });
    expect(t.category).toBe("Follow up");
    expect(t.tags).toEqual(["hosting", "price"]);
    expect(t.versions).toEqual(["Hello {name}! Still thinking about {plan}?"]);
    expect(t.variables).toEqual([{ key: "name", value: "Sir" }, { key: "plan", value: "Business" }]);
    expect(t.showIn).toEqual(["follow_up", "live_chat"]);

    const updated = await updateTemplate(ws.id, t.id, { tags: ["eid"], showIn: [] });
    expect(updated.tags).toEqual(["eid"]);
    expect(updated.showIn).toEqual([]);
  });

  it("lists usage, duplicates and adds examples", async () => {
    const ws = await createWorkspace();
    const t = await createTemplate(ws.id, { name: "Hello", category: "Greeting", typeId: "text_message", content: "Hi {name}" });
    const copy = await duplicateTemplate(ws.id, t.id);
    expect(copy.name).toBe("Hello (copy)");
    expect(copy.category).toBe("Greeting");

    const added = await addTemplateExamples(ws.id, ["greeting", "nope"]);
    expect(added).toHaveLength(1);
    expect(added[0].versions.length).toBe(1);

    const list = await listTemplates(ws.id);
    const row = list.find((x) => x.id === t.id);
    expect(row?.usage).toEqual({ autoReplies: 0, campaigns: 0, followUps: 0, callResponders: 0 });
  });

  it("resolves a version and fills variables for the recipient", async () => {
    const ws = await createWorkspace();
    const device = await prisma.device.create({ data: { workspaceId: ws.id, name: "d", sessionId: "s-1" } });
    await prisma.liveChatThread.create({
      data: { workspaceId: ws.id, deviceId: device.id, peerPhone: "+8801711111111", peerLabel: "Rahim" },
    });
    const ctx = await templateContextFor(ws.id, "+8801711111111", device.id);
    expect(ctx).toEqual({ name: "Rahim", phone: "+8801711111111" });
    expect(await templateContextFor(ws.id, "+8801722222222")).toEqual({ name: null, phone: "+8801722222222" });

    const out = resolveTemplateForSend(
      {
        typeId: "text_message",
        name: "x",
        media: null,
        footer: "Reply STOP, {name}",
        body: "Hi {name}, {plan}",
        versions: [],
        variables: [{ key: "plan", value: "Pro" }],
      },
      ctx
    );
    expect(out.body).toBe("Hi Rahim, Pro");
    expect(out.footer).toBe("Reply STOP, Rahim");
  });
});
