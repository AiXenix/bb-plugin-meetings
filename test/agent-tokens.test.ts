import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAgentTokenManager } from "../src/server/agent-tokens.js";

describe("personal meeting tokens", () => {
  it("persists only the hash, verifies across managers and rotates and revokes access", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "meetings" });
    try {
      const tokens = createAgentTokenManager(bb);
      expect(await tokens.verify("mtgs_" + "a".repeat(43))).toBe(false);
      const first = await tokens.create();
      expect(first.token).toMatch(/^mtgs_[A-Za-z0-9_-]{43}$/);
      expect(await createAgentTokenManager(bb).verify(first.token)).toBe(true);
      const stored = await bb.storage.kv.get("agent-access-token.v1");
      expect(JSON.stringify(stored)).not.toContain(first.token);
      expect(await tokens.status()).toEqual({ configured: true, createdAt: first.createdAt });
      const second = await tokens.create();
      expect(second.token).not.toBe(first.token);
      expect(await tokens.verify(first.token)).toBe(false);
      expect(await tokens.verify(second.token)).toBe(true);
      expect(await tokens.verify(second.token + "x")).toBe(false);
      await tokens.revoke();
      expect(await tokens.verify(second.token)).toBe(false);
      expect(await tokens.status()).toEqual({ configured: false, createdAt: null });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("fails closed when persisted data is missing or invalid", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "meetings" });
    try {
      await bb.storage.kv.set("agent-access-token.v1", { hash: "not-a-hash", createdAt: 1 });
      const tokens = createAgentTokenManager(bb);
      expect(await tokens.verify("mtgs_" + "a".repeat(43))).toBe(false);
      expect(await tokens.status()).toEqual({ configured: false, createdAt: null });
    } finally { await harness.lifecycle.dispose(); }
  });
});
