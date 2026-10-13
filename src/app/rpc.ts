// Typed access to the plugin's RPC methods (src/shared/rpc-contract.ts, types only).
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../shared/rpc-contract";

export type MeetingsRpc = PluginRpcClient<RpcContract>;

export function useMeetingsRpc(): MeetingsRpc {
  return useRpc<RpcContract>();
}

/** A displayable message for a rejected RPC call or any thrown value. */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
