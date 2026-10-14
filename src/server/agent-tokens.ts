import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const TOKEN_KEY = "agent-access-token.v1";
const TOKEN_PATTERN = /^mtgs_[A-Za-z0-9_-]{43}$/;
const storedTokenSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
}).strict();

export interface AgentTokenStatus {
  configured: boolean;
  createdAt: number | null;
}

export interface AgentTokenManager {
  status(): Promise<AgentTokenStatus>;
  create(): Promise<{ token: string; createdAt: number }>;
  revoke(): Promise<AgentTokenStatus>;
  verify(token: string): Promise<boolean>;
}

export function createAgentTokenManager(bb: Pick<BbPluginApi, "storage">): AgentTokenManager {
  const read = async () => {
    const parsed = storedTokenSchema.safeParse(await bb.storage.kv.get(TOKEN_KEY));
    return parsed.success ? parsed.data : null;
  };
  return {
    async status() {
      const stored = await read();
      return { configured: stored !== null, createdAt: stored?.createdAt ?? null };
    },
    async create() {
      const token = `mtgs_${randomBytes(32).toString("base64url")}`;
      const createdAt = Date.now();
      await bb.storage.kv.set(TOKEN_KEY, { hash: createHash("sha256").update(token).digest("hex"), createdAt });
      return { token, createdAt };
    },
    async revoke() {
      await bb.storage.kv.delete(TOKEN_KEY);
      return { configured: false, createdAt: null };
    },
    async verify(token) {
      if (!TOKEN_PATTERN.test(token)) return false;
      const stored = await read();
      if (stored === null) return false;
      return timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(stored.hash, "hex"));
    },
  };
}
