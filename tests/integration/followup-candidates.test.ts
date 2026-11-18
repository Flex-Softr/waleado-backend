import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAnalysisCandidates } from "../../src/services/followups.service";
import { prisma, resetDb } from "../helpers/db";
import { createWorkspace } from "../helpers/factories";

beforeEach(resetDb);

const HOUR = 3_600_000;

async function thread(workspaceId: string, deviceId: string, phone: string, msgs: Array<{ dir: "INBOUND" | "OUTBOUND"; hoursAgo: number }>) {
  const t = await prisma.liveChatThread.create({ data: { workspaceId, deviceId, peerPhone: phone } });
  for (const m of msgs) {
    await prisma.liveChatMessage.create({
      data: { threadId: t.id, direction: m.dir, bodyText: "x", createdAt: new Date(Date.now() - m.hoursAgo * HOUR) },
    });
  }
}

describe("loadAnalysisCandidates", () => {
  it("includes chats the AI never answered, timed by the customer's last message", async () => {
    const ws = await createWorkspace();
    const device = await prisma.device.create({ data: { workspaceId: ws.id, name: "d", sessionId: randomUUID() } });

    // Human-handled chat, customer quiet for 3h, our follow-up went out after: still timed at 3h.
    await thread(ws.id, device.id, "+8801700000001", [
      { dir: "INBOUND", hoursAgo: 3 },
      { dir: "OUTBOUND", hoursAgo: 0.1 },
    ]);
    // Customer wrote 10 minutes ago: still talking, not a candidate.
    await thread(ws.id, device.id, "+8801700000002", [
      { dir: "INBOUND", hoursAgo: 5 },
      { dir: "INBOUND", hoursAgo: 0.15 },
    ]);
    // Outbound only (e.g. a bulk campaign): never a candidate.
    await thread(ws.id, device.id, "+8801700000003", [{ dir: "OUTBOUND", hoursAgo: 4 }]);

    const now = Date.now();
    const list = await loadAnalysisCandidates(now, new Date(now - 14 * 24 * HOUR));
    expect(list.map((c) => c.peerKey)).toEqual(["+8801700000001"]);
    expect(list[0].ruleId).toBeNull();
    expect(Math.round((now - list[0].lastActivityAt.getTime()) / HOUR)).toBe(3);
  });
});
